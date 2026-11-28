// VM gate backend (deploy/devvm) against a fake `devvm`: explicit selection, audit, fail-closed waits, secret-scan
// export block, stdin streaming, the empty-repository init, the network-namespace check and devvm prune.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { defaultConfig, validateConfig } from '../src/core/config.js';
import { runGates } from '../src/engine/gates.js';
import { GateBackendUnavailableError, gateBackendStatus } from '../src/engine/gate-backend.js';
import { checkDevVmExecutable } from '../src/vm/devvm.js';
import { runProcess } from '../src/providers/process.js';
import { Workspace } from '../src/git/git.js';
import { makeHarness } from './support/harness.js';
import type { SimBehaviour } from '../src/providers/simulated.js';

const REPO = process.cwd();
const tmp = (p = 'orch-devvm-') => mkdtempSync(join(tmpdir(), p));

/** A fake devvm copied into a private directory (the backend refuses group/world-writable locations). */
function installFake(): { bin: string; home: string; calls: () => string[][]; gates: () => Array<{ command: string; network: boolean; bytes: number; files: string[] }>; setMode: (m: Record<string, unknown>) => void } {
  const dir = tmp('orch-fakevm-');
  chmodSync(dir, 0o755);
  const bin = join(dir, 'devvm');
  copyFileSync(join(REPO, 'test', 'support', 'fake-devvm.mjs'), bin);
  chmodSync(bin, 0o755);
  const home = join(dir, 'state');
  mkdirSync(join(home, 'fake'), { recursive: true });
  process.env.DEVVM_HOME = home;
  const lines = (f: string) => (existsSync(join(home, 'fake', f)) ? readFileSync(join(home, 'fake', f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    bin, home,
    calls: () => lines('calls.jsonl'),
    gates: () => lines('gates.jsonl'),
    setMode: (m) => writeFileSync(join(home, 'fake', 'mode.json'), JSON.stringify(m)),
  };
}

function repoWith(files: Record<string, string>): { dir: string; commit: string } {
  const dir = tmp('orch-gate-repo-');
  execFileSync('git', ['init', '-q', dir]);
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'init']);
  return { dir, commit: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
}

const noAgents: SimBehaviour = () => ({ ok: false, failure: { cls: "unknown", message: "no agents in this test" } }) as never;

test('devvm: config selects the VM backend explicitly; the legacy key and a missing command are rejected', () => {
  const cfg = defaultConfig(tmp());
  assert.equal(cfg.security.gateBackend, 'local');
  cfg.security.gateBackend = 'devvm';
  assert.throws(() => validateConfig(cfg), /requires vm\.command/);
  cfg.vm.command = 'devvm';
  assert.throws(() => validateConfig(cfg), /requires vm\.command/);
  cfg.vm.command = '/usr/local/bin/devvm';
  validateConfig(cfg);
  (cfg.security as Record<string, unknown>).devVmGateCommand = '/home/x/.local/bin/devvm';
  assert.throws(() => validateConfig(cfg), /devVmGateCommand was replaced/);
});

test('devvm: the executable must be trusted (absolute, executable, not group/world-writable)', () => {
  const fake = installFake();
  assert.equal(checkDevVmExecutable(fake.bin), null);
  assert.match(checkDevVmExecutable('devvm')!, /absolute/);
  assert.match(checkDevVmExecutable(join(fake.home, 'missing'))!, /does not exist/);
  chmodSync(fake.bin, 0o775);
  assert.match(checkDevVmExecutable(fake.bin)!, /writable by group or others/);
  chmodSync(fake.bin, 0o644);
  assert.match(checkDevVmExecutable(fake.bin)!, /not executable/);
});

test('devvm: gates run in the VM with only the exact commit, real exit codes, a streamed archive and an audited selection', async () => {
  const fake = installFake();
  const big = 'x'.repeat(3 * 1024 * 1024); // larger than any pipe buffer: stdin must be streamed, not truncated
  const { dir, commit } = repoWith({ 'probe.txt': 'probe-ok\n', 'big.bin': big });
  writeFileSync(join(dir, 'untracked.txt'), 'not in the commit');
  const h = makeHarness(noAgents, (c) => { c.security.gateBackend = 'devvm'; c.vm.command = fake.bin; });
  try {
    await h.sup.start();
    await h.sup.stop(10);
    const audit = h.ctx.db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action='security.gate_backend' ORDER BY id DESC LIMIT 1");
    assert.ok(audit, 'gate backend selection is audited at supervisor start');
    assert.equal(JSON.parse(audit!.detail).backend, 'devvm');
    assert.ok(h.ctx.db.get("SELECT 1 FROM events WHERE type='security.vm_backend_ok'"), 'self-check reports the backend');

    const s = await runGates(h.ctx, { projectId: 'p1', workItemId: null, scope: 'task', cwd: dir, commit, gates: [
      { name: 'probe', command: 'test "$(cat probe.txt)" = probe-ok && test "$(wc -c < big.bin)" = 3145728', required: true },
      { name: 'exit7', command: 'exit 7', required: true },
    ] as never });
    const byName = Object.fromEntries(s.results.map((r) => [r.name, r]));
    assert.equal(byName.probe!.status, 'pass');
    assert.equal(byName.probe!.sandbox, 'devvm');
    assert.equal(byName.exit7!.status, 'fail');
    assert.equal(byName.exit7!.exitCode, 7, 'the command\'s real exit code is recorded');
    assert.equal(byName['secret-scan']!.status, 'pass');
    const g = fake.gates();
    assert.equal(g.length, 2);
    assert.deepEqual(g[0]!.files, ['big.bin', 'probe.txt'], 'only the committed tree is exported (no untracked files, no .git)');
    assert.equal(g[0]!.network, false, 'gates get no network by default');
  } finally { h.cleanup(); }
});

test('devvm: an unavailable VM host makes gates wait (never run here), once-per-outage notice, retry after the hold', async () => {
  const fake = installFake();
  const { dir, commit } = repoWith({ 'a.txt': 'a' });
  const h = makeHarness(noAgents, (c) => { c.security.gateBackend = 'devvm'; c.vm.command = fake.bin; c.vm.unavailableRetryMin = 5; });
  const gates = [{ name: 'check', command: 'test -f a.txt', required: true }] as never;
  try {
    fake.setMode({ mode: 'asleep' });
    await assert.rejects(runGates(h.ctx, { projectId: 'p1', workItemId: null, scope: 'task', cwd: dir, commit, gates }), GateBackendUnavailableError);
    assert.equal(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gate_runs')!.n, 0, 'an outage is not a gate result');
    const callsAfterFirst = fake.calls().length;
    await assert.rejects(runGates(h.ctx, { projectId: 'p1', workItemId: null, scope: 'task', cwd: dir, commit, gates }), /retrying after/);
    assert.equal(fake.calls().length, callsAfterFirst, 'during the hold the VM host is not contacted again');
    assert.equal(h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type='gates.backend_unavailable'")!.n, 1);
    assert.ok(gateBackendStatus(h.ctx.cfg).waitingUntil);

    fake.setMode({ mode: 'paused' }); // gaming pause: still waiting, still not a result
    h.clock.advance(5 * 60_000 + 1);
    await assert.rejects(runGates(h.ctx, { projectId: 'p1', workItemId: null, scope: 'task', cwd: dir, commit, gates }), /pause/i);

    fake.setMode({ mode: 'ok', dropSsh: true }); // the PC went to sleep mid-gate: lost SSH is an outage, not a failure
    h.clock.advance(5 * 60_000 + 1);
    await assert.rejects(runGates(h.ctx, { projectId: 'p1', workItemId: null, scope: 'task', cwd: dir, commit, gates }), GateBackendUnavailableError);

    fake.setMode({ mode: 'ok' });
    h.clock.advance(5 * 60_000 + 1);
    const s = await runGates(h.ctx, { projectId: 'p1', workItemId: null, scope: 'task', cwd: dir, commit, gates });
    assert.equal(s.passed, true);
    assert.ok(h.ctx.db.get("SELECT 1 FROM events WHERE type='gates.backend_available'"));
    assert.equal(gateBackendStatus(h.ctx.cfg).waitingUntil, null);
  } finally { h.cleanup(); }
});

test('devvm: credentials in the tree block the export to the VM; an untrusted executable fails closed', async () => {
  const fake = installFake();
  const { dir, commit } = repoWith({ 'config.js': 'const key = "AKIAABCDEFGHIJKLMNOP";\n' });
  const h = makeHarness(noAgents, (c) => { c.security.gateBackend = 'devvm'; c.vm.command = fake.bin; });
  try {
    const s = await runGates(h.ctx, { projectId: 'p1', workItemId: null, scope: 'task', cwd: dir, commit, gates: [{ name: 'test', command: 'true', required: true }] as never });
    assert.equal(s.passed, false);
    assert.equal(s.results.find((r) => r.name === 'test')!.status, 'error');
    assert.equal(s.results.find((r) => r.name === 'secret-scan')!.status, 'fail');
    assert.equal(fake.gates().length, 0, 'nothing was sent to the VM');
  } finally { h.cleanup(); }
  const fake2 = installFake();
  chmodSync(fake2.bin, 0o777);
  const h2 = makeHarness(noAgents, (c) => { c.security.gateBackend = 'devvm'; c.vm.command = fake2.bin; });
  try {
    await assert.rejects(runGates(h2.ctx, { projectId: 'p1', workItemId: null, scope: 'task', cwd: dir, commit, gates: [{ name: 'test', command: 'true', required: true }] as never }), /writable by group or others/);
    assert.equal(fake2.calls().length, 0);
  } finally { h2.cleanup(); }
});

test('process: a Readable stdin is streamed completely to the child', async () => {
  const size = 5 * 1024 * 1024;
  const r = await runProcess('sh', ['-c', 'wc -c'], { cwd: tmpdir(), env: { PATH: process.env.PATH! }, stdin: Readable.from([Buffer.alloc(size, 1)]), timeoutMs: 30_000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), String(size));
  const broken = new Readable({ read() { this.destroy(new Error('source failed')); } });
  const r2 = await runProcess('sh', ['-c', 'cat > /dev/null; echo done'], { cwd: tmpdir(), env: { PATH: process.env.PATH! }, stdin: broken, timeoutMs: 10_000 });
  assert.notEqual(r2.timedOut, true, 'a failing stdin source does not hang the run');
});

test('git: an empty repository gets an initial commit without `worktree add --orphan` (Git 2.39 compatible)', async () => {
  const root = tmp();
  const ws = new Workspace(join(root, 'ws'), 'main', () => ({}));
  await ws.ensure(null);
  const log = execFileSync('git', ['-C', ws.integration, 'log', '--format=%s', 'main'], { encoding: 'utf8' }).trim();
  assert.equal(log, 'chore: initialize repository');
  assert.equal(execFileSync('git', ['-C', ws.integration, 'ls-tree', 'HEAD'], { encoding: 'utf8' }).trim(), '', 'the initial commit has the empty tree');
  await ws.ensure(null); // idempotent
  // Cloned empty remote (GitHub mode with a brand-new repository).
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const ws2 = new Workspace(join(root, 'ws2'), 'main', () => ({}));
  await ws2.ensure(remote);
  assert.equal(execFileSync('git', ['-C', ws2.integration, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), 'main');
  rmSync(root, { recursive: true, force: true });
});

test('devvm smoke gate 1: the network check passes in a fresh network namespace (route table may be empty)', (t) => {
  const probe = spawnSync('unshare', ['--net', '--pid', '--fork', '--mount-proc', 'true']);
  if (probe.status !== 0) { t.skip('unshare --net is not permitted here'); return; }
  const script = join(REPO, 'deploy', 'devvm', 'netns-check.sh');
  const inside = spawnSync('unshare', ['--net', '--pid', '--fork', '--mount-proc', 'sh', script], { encoding: 'utf8' });
  assert.equal(inside.status, 0, inside.stdout + inside.stderr);
  assert.equal(inside.stdout.trim(), 'isolated');
  const lines = spawnSync('unshare', ['--net', 'sh', '-c', 'wc -l < /proc/net/route'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(lines === '0' || lines === '1', `route file has ${lines} lines`);
});

test('devvm CLI: prune removes lock-only and expired lease folders, keeps in-flight ones; host values come from config', (t) => {
  if (spawnSync('python3', ['--version']).status !== 0) { t.skip('python3 not installed'); return; }
  const home = tmp('orch-devvm-home-');
  const cli = join(REPO, 'deploy', 'devvm', 'devvm');
  const leases = join(home, 'leases');
  const lockOnly = 'a'.repeat(32), inFlight = 'b'.repeat(32), expired = 'c'.repeat(32);
  for (const id of [lockOnly, inFlight, expired]) { mkdirSync(join(leases, id), { recursive: true }); writeFileSync(join(leases, id, 'lock'), ''); }
  writeFileSync(join(leases, inFlight, 'request.json'), JSON.stringify({ ttl_minutes: 60 }));
  writeFileSync(join(leases, expired, 'lease.json'), JSON.stringify({ expires_at: 1 }));
  writeFileSync(join(leases, expired, 'identity'), 'k');
  const env = { ...process.env, DEVVM_HOME: home };
  const r = spawnSync('python3', [cli, 'prune'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(leases, lockOnly)), false, 'lock-only folder removed');
  assert.equal(existsSync(join(leases, expired)), false, 'expired lease folder removed with its key');
  assert.equal(existsSync(join(leases, inFlight, 'request.json')), true, 'in-flight request kept');
  const noCfg = spawnSync('python3', [cli, 'reachable'], { env, encoding: 'utf8' });
  assert.equal(noCfg.status, 1);
  assert.match(noCfg.stderr, /config\.json/);
  const gate = spawnSync('python3', [cli, 'gate', '--', 'true'], { env, encoding: 'utf8', input: '' });
  assert.equal(gate.status, 75, 'a gate that cannot get a VM exits EX_UNAVAILABLE');
  writeFileSync(join(home, 'config.json'), readFileSync(join(REPO, 'deploy', 'devvm', 'config.example.json')));
  const ok = spawnSync('python3', [cli, 'reachable'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).reachable, false, 'documentation address is unreachable');
  rmSync(home, { recursive: true, force: true });
});

test('devvm e2e: with the VM host asleep, items wait in gating (no remediation, nothing run here); they complete once it wakes', async () => {
  const { DEMO_GOAL, demoBehaviour } = await import('./support/scenario.js');
  const { drive, newDemoProject } = await import('./support/harness.js');
  const fake = installFake();
  fake.setMode({ mode: 'asleep' });
  const h = makeHarness(demoBehaviour({ calls: {}, log: [] }), (c) => { c.security.gateBackend = 'devvm'; c.vm.command = fake.bin; c.vm.unavailableRetryMin = 1; });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    await drive(h, () => !!h.ctx.db.get("SELECT 1 FROM work_items WHERE project_id=? AND status='gating'", p0.id), p0.id, { maxTicks: 200 });
    for (let i = 0; i < 30; i++) { await h.sup.tick(); await h.sup.settle(); h.clock.advance(5_000); }
    assert.equal(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gate_runs WHERE project_id=?', p0.id)!.n, 0, 'no gate result was recorded during the outage');
    assert.equal(h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND kind='remediate'", p0.id)!.n, 0, 'an outage never triggers remediation');
    assert.equal(h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type='job.error'")!.n, 0, 'waiting is not logged as a job error');
    assert.equal(h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type='gates.backend_unavailable'")!.n, 1);
    fake.setMode({ mode: 'ok' });
    const p = await drive(h, (x) => ['completed', 'blocked', 'failed'].includes(x.status), p0.id, { maxTicks: 800 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    const sandboxes = h.ctx.db.all<{ log_path: string }>("SELECT log_path FROM gate_runs WHERE project_id=? AND name != 'secret-scan'", p0.id);
    assert.ok(sandboxes.length > 0);
    assert.ok(fake.gates().length >= sandboxes.length, 'every recorded gate ran in the (fake) VM');
  } finally { h.cleanup(); }
});
