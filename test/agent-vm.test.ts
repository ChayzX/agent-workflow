// Agent sessions in VMs (security.agentBackend = "devvm") against a fake `devvm` whose "VMs" are directories:
// one lease per item and its reuse through remediation, the bundle/patch round trip, no GitHub token or credential
// on any command line, review isolation, reaping, TTL renewal/expiry and rebuild, a gaming pause, and the egress proxy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEMO_GOAL, demoBehaviour } from './support/scenario.js';
import { drive, makeHarness, newDemoProject, type Harness } from './support/harness.js';
import { EgressProxy, hostDecision, isInternalAddress } from '../src/vm/egress-proxy.js';
import { json } from '../src/core/db.js';
import type { Config } from '../src/core/config.js';

const REPO = process.cwd();
const GH_TOKEN = 'ghp_' + 'Q'.repeat(36);
const OAUTH = 'sk-ant-oat01-' + 'z'.repeat(48);

interface Fake { bin: string; home: string; calls: () => string[][]; setMode: (m: Record<string, unknown>) => void; leases: () => string[] }
function installFake(): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'orch-fakevm-'));
  chmodSync(dir, 0o755);
  const bin = join(dir, 'devvm');
  copyFileSync(join(REPO, 'test', 'support', 'fake-devvm.mjs'), bin);
  chmodSync(bin, 0o755);
  const home = join(dir, 'state');
  mkdirSync(join(home, 'fake', 'leases'), { recursive: true });
  process.env.DEVVM_HOME = home;
  return {
    bin, home,
    calls: () => readFileSync(join(home, 'fake', 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    setMode: (m) => writeFileSync(join(home, 'fake', 'mode.json'), JSON.stringify(m)),
    leases: () => readdirSync(join(home, 'fake', 'leases')),
  };
}

function vmHarness(fake: Fake, tweak: (c: Config) => void = () => {}): Harness {
  const state = { calls: {}, log: [] };
  const h = makeHarness(demoBehaviour(state), (c) => {
    c.security.agentBackend = 'devvm';
    c.vm.command = fake.bin;
    c.vm.egressProxy = 'http://192.0.2.1:3128';
    c.vm.warmPool = 0;
    c.vm.unavailableRetryMin = 1;
    tweak(c);
  });
  mkdirSync(h.ctx.paths.secrets, { recursive: true, mode: 0o700 });
  writeFileSync(join(h.ctx.paths.secrets, 'claude-oauth-token'), OAUTH + '\n', { mode: 0o600 });
  writeFileSync(join(h.ctx.paths.secrets, 'codex-auth.json'), JSON.stringify({ tokens: { access_token: 'codex-' + 'y'.repeat(40) }, last_refresh: '2026-11-27T00:00:00Z' }), { mode: 0o600 });
  h.claude.followWrap = true;
  h.codex.followWrap = true;
  return h;
}

const done = (x: { status: string }) => ['completed', 'blocked', 'failed'].includes(x.status);

test('agent VMs: one lease per work item reused through remediation; bundle in, patch out; reviews isolated; destroyed on merge', async () => {
  const fake = installFake();
  process.env.GITHUB_TOKEN = GH_TOKEN; // present in the supervisor's environment; must never reach a VM
  const h = vmHarness(fake);
  try {
    await h.sup.start();
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, done, p0.id, { maxTicks: 900, stepMs: 10_000 });
    await h.sup.stop(10);
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    const db = h.ctx.db;
    // The agents' edits were made inside the (fake) VMs and came back as patches: the product works.
    const main = execFileSync('git', ['-C', join(p.workspace_dir, 'repo.git'), 'show', `${p.default_branch}:src/calc.js`], { encoding: 'utf8' });
    assert.match(main, /a \+ b/);
    // One work lease per item; W-001's implementation and remediation ran in the same VM (so resume could work).
    const work = db.all<{ work_item_id: string; n: number }>("SELECT work_item_id, COUNT(*) AS n FROM vm_leases WHERE purpose='work' GROUP BY work_item_id");
    assert.ok(work.length >= 2);
    for (const w of work) assert.equal(w.n, 1, 'exactly one lease per work item');
    const w1 = db.get<{ id: string }>("SELECT id FROM work_items WHERE key='W-001'")!;
    const w1Leases = new Set(db.all<{ input: string }>("SELECT input FROM tasks WHERE work_item_id=? AND kind IN ('implement','remediate')", w1.id).map((t) => json<{ vmLease?: string }>(t.input, {}).vmLease).filter(Boolean));
    assert.equal(w1Leases.size, 1, 'implementation and remediation share the item\'s VM');
    assert.ok(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE work_item_id=? AND kind='remediate'", w1.id)!.n >= 1);
    // Reviews never ran in an implementer's VM.
    const reviewLeases = db.all<{ input: string }>("SELECT input FROM tasks WHERE kind IN ('review','verify_fix') AND status='succeeded'").map((t) => json<{ vmLease?: string }>(t.input, {}).vmLease).filter(Boolean);
    const purposes = new Set(reviewLeases.map((id) => db.get<{ purpose: string }>('SELECT purpose FROM vm_leases WHERE id=?', id!)?.purpose));
    assert.deepEqual([...purposes], ['review']);
    // Merged items' VMs are destroyed.
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM vm_leases WHERE purpose='work' AND status!='gone'")!.n, 0);
    // Neither the GitHub token nor any provider credential appeared on a devvm command line.
    const argv = JSON.stringify(fake.calls());
    assert.ok(!argv.includes(GH_TOKEN), 'GitHub token never sent');
    assert.ok(!argv.includes(OAUTH), 'credentials only travel on stdin');
    assert.ok(!argv.includes('codex-' + 'y'.repeat(40)));
    assert.match(argv, /unset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY GITHUB_TOKEN GH_TOKEN/);
    assert.match(argv, /HTTPS_PROXY='http:\/\/192\.0\.2\.1:3128'/, 'every agent command goes through the egress proxy');
    assert.ok(db.get("SELECT 1 FROM audit_log WHERE action='security.agent_backend'"), 'agent backend audited at start');
  } finally { delete process.env.GITHUB_TOKEN; h.cleanup(); }
});

test('agent VMs: credentials are installed in the guest from 0600 sources; the guest never sees the GitHub token', async () => {
  const fake = installFake();
  process.env.GITHUB_TOKEN = GH_TOKEN;
  const h = vmHarness(fake);
  try {
    const lease = await h.sup.vmPool.provision('review', null, null);
    const guest = join(fake.home, 'fake', 'leases', lease.id, 'root', 'home', 'dev');
    assert.equal(readFileSync(join(guest, '.orch', 'credentials.env'), 'utf8'), `CLAUDE_CODE_OAUTH_TOKEN=${OAUTH}\n`);
    assert.ok(existsSync(join(guest, '.codex', 'auth.json')));
    const env = execFileSync(fake.bin, ['ssh', lease.id, '--', 'env'], { encoding: 'utf8', env: { ...process.env } });
    assert.ok(!env.includes(GH_TOKEN));
    // An unsafe credential source is refused (and reported as an auth problem, not silently skipped).
    chmodSync(join(h.ctx.paths.secrets, 'claude-oauth-token'), 0o644);
    await assert.rejects(h.sup.vmPool.provision('review', null, null), /must be mode 600/);
  } finally { delete process.env.GITHUB_TOKEN; h.cleanup(); }
});

test('agent VMs: a lease lost mid-item is rebuilt from checkpoints (new generation, no resume) and the item completes', async () => {
  const fake = installFake();
  fake.setMode({ loseOnSecondSync: 'W-001' }); // the host reaps W-001's VM just before its remediation starts
  const h = vmHarness(fake);
  try {
    await h.sup.start();
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, done, p0.id, { maxTicks: 900, stepMs: 10_000 });
    await h.sup.stop(10);
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    const w1 = h.ctx.db.get<{ id: string }>("SELECT id FROM work_items WHERE key='W-001'")!;
    const gens = h.ctx.db.all<{ generation: number; status: string }>("SELECT generation, status FROM vm_leases WHERE work_item_id=? ORDER BY generation", w1.id);
    assert.ok(gens.length >= 2 && gens.at(-1)!.generation >= 2, `rebuilt: ${JSON.stringify(gens)}`);
    assert.ok(h.ctx.db.get("SELECT 1 FROM events WHERE type='vm.lease_lost'"));
    assert.equal(h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status='dead'")!.n, 0, 'a lost VM is not the task\'s fault');
    // The rebuilt run did not try to resume a session that lived in the lost VM.
    const rem = h.ctx.db.all<{ mode: string }>("SELECT s.mode FROM sessions s JOIN tasks t ON t.id=s.task_id WHERE t.work_item_id=? AND t.kind='remediate'", w1.id);
    assert.ok(rem.length && rem.every((r) => r.mode !== 'resume'), JSON.stringify(rem));
  } finally { h.cleanup(); }
});

test('agent VMs: TTL is renewed while in use; an expired lease is marked lost; crashed provisioning is reaped at start', async () => {
  const fake = installFake();
  const h = vmHarness(fake, (c) => { c.vm.agent.ttlMinutes = 60; c.vm.agent.renewBeforeMin = 30; });
  try {
    const sec = () => Math.floor(h.clock.now() / 1000);
    fake.setMode({ now: sec() });
    const pool = h.sup.vmPool;
    const a = await pool.provision('work', null, null);
    h.clock.advance(40 * 60_000); fake.setMode({ now: sec() });
    await pool.reconcile({ runnableWork: true, busyLeases: new Set([a.id]) });
    const renewed = h.ctx.db.get<{ expires_at: number }>('SELECT expires_at FROM vm_leases WHERE id=?', a.id)!;
    assert.equal(renewed.expires_at, (sec() + 60 * 60) * 1000, 'renewed to now + TTL');
    h.clock.advance(61 * 60_000); fake.setMode({ now: sec() }); // missed the renewal window: the host expired it
    await pool.reconcile({ runnableWork: true, busyLeases: new Set([a.id]) });
    assert.equal(h.ctx.db.get<{ status: string }>('SELECT status FROM vm_leases WHERE id=?', a.id)!.status, 'gone');
    assert.ok(h.ctx.db.get("SELECT 1 FROM events WHERE type='vm.lease_lost'"));
    // Crash mid-provision: a row left 'provisioning' (and its VM) is destroyed by the next start.
    const orphan = 'f'.repeat(32);
    execFileSync(fake.bin, ['provision', '--id', orphan], { env: process.env });
    h.ctx.db.run("INSERT INTO vm_leases(id, purpose, status, cpus, ram_mib, disk_gib, generation, created_at, updated_at) VALUES (?, 'work', 'provisioning', 4, 8192, 32, 1, 0, 0)", orphan);
    await h.sup.start(); await h.sup.stop(10);
    assert.equal(h.ctx.db.get<{ status: string }>('SELECT status FROM vm_leases WHERE id=?', orphan)!.status, 'gone');
    assert.ok(!fake.leases().includes(orphan), 'the orphaned VM was destroyed');
  } finally { h.cleanup(); }
});

test('agent VMs: during a gaming pause work stays queued (no attempts burned) and resumes when the pause ends', async () => {
  const fake = installFake();
  fake.setMode({ mode: 'paused' });
  const h = vmHarness(fake);
  try {
    await h.sup.start();
    const p0 = newDemoProject(h, DEMO_GOAL);
    for (let i = 0; i < 40; i++) { await h.sup.tick(); await h.sup.settle(); h.clock.advance(10_000); }
    const db = h.ctx.db;
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('succeeded','dead','failed')")!.n, 0, 'nothing ran');
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE attempts > 1")!.n, 0, 'no attempts were counted');
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type='vm.unavailable'")!.n, 1, 'one notice per outage');
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions")!.n, 0, 'no agent ran on this host');
    fake.setMode({ mode: 'ok' });
    const p = await drive(h, done, p0.id, { maxTicks: 900, stepMs: 10_000 });
    await h.sup.stop(10);
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    assert.ok(db.get("SELECT 1 FROM events WHERE type='vm.available'"));
  } finally { h.cleanup(); }
});

test('egress proxy: only allowlisted names to public addresses; LAN, internal resolutions, IP literals, denied hosts and other clients are refused', async () => {
  const policy = { allowHosts: ['registry.npmjs.org', '.debian.org', 'mirror.test'], denyHosts: ['pantry.example.org', '.pantrybot.test'], allowPorts: [443, 80], allowClients: [] };
  assert.deepEqual(hostDecision(policy, 'registry.npmjs.org', 443), { ok: true });
  assert.equal(hostDecision(policy, 'deb.debian.org', 80).ok, true);
  for (const [host, port] of [['evil.com', 443], ['192.168.1.1', 443], ['registry.npmjs.org', 22], ['pantry.example.org', 443], ['api.pantrybot.test', 443], ['[::1]', 443]] as const) {
    assert.equal(hostDecision(policy, host, port).ok, false, `${host}:${port}`);
  }
  for (const a of ['10.1.2.3', '172.16.0.1', '192.168.40.5', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', '224.0.0.1']) assert.ok(isInternalAddress(a), a);
  for (const a of ['104.16.0.1', '151.101.1.1', '2606:4700::1111']) assert.ok(!isInternalAddress(a), a);

  // Live proxy: an allowlisted name that resolves to a LAN address (e.g. a poisoned record) is refused.
  let upstreamHits = 0;
  const upstream = createServer((req, res) => { upstreamHits++; res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(`pkg:${req.url}`); });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upPort = (upstream.address() as { port: number }).port;
  const cache = mkdtempSync(join(tmpdir(), 'orch-egress-cache-'));
  const log = join(cache, 'egress.jsonl');
  const resolve = async (h: string) => (h === 'mirror.test' ? ['127.0.0.1'] : h === 'deb.debian.org' ? ['192.168.40.5'] : ['104.16.0.1']);
  const proxy = new EgressProxy({ ...policy, allowPorts: [443, 80, upPort], listen: '127.0.0.1', port: 0, logFile: log, cacheDir: cache, cacheMaxMb: 10, resolve, allowLoopbackForTests: true });
  const { port } = await proxy.start();
  const connectTo = (target: string) => new Promise<string>((res) => {
    const s = connect(port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once('data', (d) => { res(d.toString().split('\r\n')[0]!); s.destroy(); });
    s.on('error', () => res('error'));
  });
  try {
    assert.match(await connectTo('evil.com:443'), / 403 /);
    assert.match(await connectTo('1.1.1.1:443'), / 403 /);
    assert.match(await connectTo('deb.debian.org:443'), / 403 /, 'allowlisted name resolving to a LAN address');
    assert.match(await connectTo('pantry.example.org:443'), / 403 /);
    assert.match(await connectTo(`mirror.test:${upPort}`), / 200 /, 'allowed path tunnels');
    const get = (path: string) => new Promise<{ status: number; body: string }>((res, rej) => {
      const r = httpGet({ host: '127.0.0.1', port, path: `http://mirror.test:${upPort}${path}`, headers: { host: `mirror.test:${upPort}` } }, (m) => {
        let body = ''; m.setEncoding('utf8'); m.on('data', (d) => { body += d; }); m.on('end', () => res({ status: m.statusCode ?? 0, body }));
      });
      r.on('error', rej);
    });
    assert.equal((await get('/pool/a_1.0.deb')).body, 'pkg:/pool/a_1.0.deb');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await get('/pool/a_1.0.deb')).body, 'pkg:/pool/a_1.0.deb');
    assert.equal(upstreamHits, 1, 'second download served from the package cache');
    const decisions = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(decisions.some((d) => d.decision === 'deny' && d.host === 'deb.debian.org' && /internal address/.test(d.reason)));
  } finally { await proxy.stop(); upstream.close(); }

  // A client that is not the gaming PC cannot use the proxy at all.
  const closed = new EgressProxy({ ...policy, allowClients: ['192.0.2.50'], listen: '127.0.0.1', port: 0, logFile: null, cacheDir: null, cacheMaxMb: 1, resolve });
  const c = await closed.start();
  try {
    const line = await new Promise<string>((res) => { const s = connect(c.port, '127.0.0.1', () => s.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n')); s.once('data', (d) => { res(d.toString()); s.destroy(); }); });
    assert.match(line, /403[\s\S]*client 127\.0\.0\.1 is not allowed/);
  } finally { await closed.stop(); }
});

test('agent VMs: a warm spare is kept only while there is runnable work, adopted by the next item, and released when idle', async () => {
  const fake = installFake();
  const h = vmHarness(fake, (c) => { c.vm.warmPool = 1; });
  try {
    const pool = h.sup.vmPool;
    await pool.reconcile({ runnableWork: false, busyLeases: new Set() });
    assert.equal(pool.rows().length, 0, 'no spare while idle: the PC may sleep');
    await pool.reconcile({ runnableWork: true, busyLeases: new Set() });
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 50 && !pool.rows("status='ready' AND purpose='warm'").length; i++) await new Promise((r) => setTimeout(r, 50));
    const [warm] = pool.rows("status='ready' AND purpose='warm'");
    assert.ok(warm, 'a warm spare was provisioned');
    const lease = await pool.leaseFor({ id: 'task_x', project_id: 'p1', work_item_id: 'wi_1', read_only: 0 } as never);
    assert.equal(lease.id, warm!.id, 'the next work item adopts the spare instead of waiting for a boot');
    assert.equal(lease.purpose, 'work');
    // Idle again: the adopted lease belongs to a work item that no longer exists, and no spare is kept.
    await pool.reconcile({ runnableWork: false, busyLeases: new Set() });
    assert.equal(pool.rows().length, 0);
  } finally { h.cleanup(); }
});
