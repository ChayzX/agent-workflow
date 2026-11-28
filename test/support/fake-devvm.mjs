#!/usr/bin/env node
// Fake `devvm` for tests: the same CLI contract as deploy/devvm/devvm, with each "VM" simulated by a directory.
// State lives in $DEVVM_HOME/fake/. Behaviour is steered by $DEVVM_HOME/fake/mode.json:
//   { "mode": "ok" | "asleep" | "paused" | "full", "dropSsh": false }
// Every invocation is appended to $DEVVM_HOME/fake/calls.jsonl (argv only; stdin is never logged).
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const EX_UNAVAILABLE = 75;
const home = process.env.DEVVM_HOME;
if (!home) { process.stderr.write('devvm: DEVVM_HOME not set (fake)\n'); process.exit(1); }
const state = join(home, 'fake');
const leasesDir = join(state, 'leases');
mkdirSync(leasesDir, { recursive: true });
const argv = process.argv.slice(2);
appendFileSync(join(state, 'calls.jsonl'), JSON.stringify(argv) + '\n');
const settings = existsSync(join(state, 'mode.json')) ? JSON.parse(readFileSync(join(state, 'mode.json'), 'utf8')) : {};
const mode = settings.mode ?? 'ok';
const now = () => settings.now ?? Math.floor(Date.now() / 1000);

function unavailable(msg) { process.stderr.write(`devvm: unavailable: ${msg}\n`); process.exit(EX_UNAVAILABLE); }
function fail(msg) { process.stderr.write(`devvm: ${msg}\n`); process.exit(1); }
function print(v) { process.stdout.write(JSON.stringify(v) + '\n'); process.exit(0); }
function readStdin() { try { return readFileSync(0); } catch { return Buffer.alloc(0); } }
function opt(args, name, dflt) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; }
function leaseDir(id) { if (!/^[0-9a-f]{32}$/.test(id ?? '')) fail('Expected a 32-character lowercase hexadecimal lease ID'); return join(leasesDir, id); }
function readLease(id) { const f = join(leaseDir(id), 'lease.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; }
function allLeases() { return readdirSync(leasesDir).map((id) => readLease(id)).filter(Boolean); }
function admission() {
  if (mode === 'asleep') unavailable('Gaming PC SSH listener did not become reachable within 180 seconds');
  if (mode === 'paused') unavailable('Gaming pause is enabled');
  if (mode === 'full') unavailable('Concurrent VM limit reached');
}
function runIn(root, command, extraEnv = {}) {
  const r = spawnSync('bash', ['-c', command], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'], env: { PATH: process.env.PATH, HOME: join(root, 'home', 'dev'), LANG: 'C.UTF-8', FAKE_GUEST_ROOT: root, ...extraEnv } });
  return r.status ?? 1;
}

const [op, ...rest] = argv;
switch (op) {
  case 'reachable': print({ reachable: mode !== 'asleep' });
  case 'wake': if (mode === 'asleep') unavailable('did not wake'); print({ ready: true, vbox: 'fake' });
  case 'list': if (mode === 'asleep') fail('Windows SSH exited 255'); print({ paused: mode === 'paused', leases: allLeases() });
  case 'pause': case 'resume': print({ paused: op === 'pause', leases: allLeases().length });
  case 'prune': process.exit(0);
  case 'status': { const l = readLease(rest[0]); print(l ?? { id: rest[0], phase: 'absent', vm_state: 'absent' }); }
  case 'provision': {
    admission();
    const id = opt(rest, '--id') ?? randomBytes(16).toString('hex');
    const ttl = Number(opt(rest, '--ttl-minutes', '60'));
    const dir = leaseDir(id);
    const prior = readLease(id);
    if (prior) print(prior);
    mkdirSync(join(dir, 'root', 'home', 'dev'), { recursive: true });
    const lease = { id, name: `adev-${id}`, phase: 'running', vm_state: 'running', cpus: Number(opt(rest, '--cpus', '2')), ram_mib: Number(opt(rest, '--ram-mib', '2048')), disk_gib: Number(opt(rest, '--disk-gib', '12')), expires_at: now() + ttl * 60 };
    writeFileSync(join(dir, 'lease.json'), JSON.stringify(lease));
    print(lease);
  }
  case 'renew': {
    const l = readLease(rest[0]); if (!l) fail('Lease is absent');
    if (l.expires_at <= now()) fail('Lease is not running or has expired');
    l.expires_at = now() + Number(opt(rest, '--ttl-minutes', '60')) * 60;
    writeFileSync(join(leaseDir(l.id), 'lease.json'), JSON.stringify(l)); print(l);
  }
  case 'destroy': { rmSync(leaseDir(rest[0]), { recursive: true, force: true }); print({ id: rest[0], destroyed: true }); }
  case 'ssh': {
    const args = rest[0] === '--identity' ? rest.slice(2) : rest;
    const l = readLease(args[0]);
    if (mode === 'asleep') unavailable('Windows SSH exited 255');
    if (!l) fail('This lease has no local receipt; use status or destroy to inspect it');
    if (l.expires_at <= now()) fail('Lease has expired');
    if (settings.dropSsh) { process.stderr.write('ssh: connection lost\n'); process.exit(255); }
    const cmd = args.slice(1)[0] === '--' ? args.slice(2) : args.slice(1);
    // Simulate the host reaping a lease (TTL) right when the orchestrator syncs a given item for the 2nd time.
    if (settings.loseOnSecondSync && cmd.join(' ').includes(`work/${settings.loseOnSecondSync}'.bundle`)) {
      const f = join(state, `syncs-${settings.loseOnSecondSync}`);
      const n = (existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0) + 1;
      writeFileSync(f, String(n));
      if (n === 2) { rmSync(leaseDir(l.id), { recursive: true, force: true }); fail('This lease has no local receipt; use status or destroy to inspect it'); }
    }
    process.exit(runIn(join(leaseDir(l.id), 'root'), cmd.join(' ') || 'true'));
  }
  case 'gate': {
    if (rest.includes('--help')) { process.stdout.write('usage: devvm gate [--status-file STATUS_FILE] [--network] ... -- command\n'); process.exit(0); }
    admission();
    const sep = rest.indexOf('--');
    const command = sep >= 0 ? rest.slice(sep + 1).join(' ') : rest.at(-1);
    const network = rest.includes('--network');
    const tarball = readStdin();
    if (settings.dropSsh) { process.stderr.write('ssh: connection lost\n'); process.exit(255); }
    const root = mkdtempSync(join(state, 'gate-'));
    try {
      mkdirSync(join(root, 'home', 'dev'), { recursive: true });
      const work = join(root, 'work'); mkdirSync(work);
      writeFileSync(join(root, 'source.tar'), tarball);
      const x = spawnSync('tar', ['-xf', join(root, 'source.tar'), '-C', work]);
      if (x.status !== 0) fail('could not extract the source archive');
      appendFileSync(join(state, 'gates.jsonl'), JSON.stringify({ command, network, bytes: tarball.length, files: readdirSync(work).sort() }) + '\n');
      const rc = runIn(work, command, { CI: 'true', HOME: join(root, 'home', 'dev') });
      const statusFile = opt(rest.slice(0, sep >= 0 ? sep : undefined), '--status-file');
      if (statusFile) { writeFileSync(statusFile, `${rc}\n`); process.exitCode = 0; } else process.exitCode = rc;
    } finally { rmSync(root, { recursive: true, force: true }); }
    break;
  }
  default: fail(`unknown operation ${op}`);
}
