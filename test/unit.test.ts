// Unit and contract tests. Provider parsing is tested against REAL captured CLI output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyText, parseClockTime, parseRelativeDuration, classifyCodexErrorInfo } from '../src/providers/classify.js';
import { ClaudeAdapter, parseClaudeRateLimit } from '../src/providers/claude.js';
import { CodexAdapter, interpretCodexRateLimits, strictSchema, extractJson } from '../src/providers/codex.js';
import { ManualClock } from '../src/core/clock.js';
import { defaultConfig, validateConfig } from '../src/core/config.js';
import { Db } from '../src/core/db.js';
import { TaskQueue } from '../src/engine/queue.js';
import { redact } from '../src/core/redact.js';
import { scanDiff, scanText, isForbiddenFile } from '../src/security/secrets.js';
import { globToRegExp } from '../src/security/policy.js';
import { agentEnv } from '../src/security/sandbox.js';
import { writeZip, readZip, extractZip } from '../src/util/zip.js';
import { validate } from '../src/util/validate.js';
import { validatePlan } from '../src/engine/workflow.js';
import { renderSections } from '../src/engine/context.js';
import { SCHEMAS } from '../src/engine/schemas.js';
import { demoPlan } from './support/scenario.js';
import { EventLog } from '../src/core/events.js';

const FIX = join(process.cwd(), 'test', 'fixtures');
const tmp = () => mkdtempSync(join(tmpdir(), 'orch-unit-'));

function fakeCli(dir: string, name: string, script: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

test('classify: real Codex usage-limit message → usage_limit with parsed local reset time', () => {
  const line = readFileSync(join(FIX, 'codex-exec-usage-limit.jsonl'), 'utf8').split('\n').map((l) => l && JSON.parse(l)).find((e) => e?.type === 'turn.failed');
  const now = new Date(2026, 10, 27, 4, 11, 0).getTime();
  const f = classifyText(line.error.message, now);
  assert.equal(f.cls, 'usage_limit');
  assert.equal(new Date(f.resetAt!).getHours(), 7);
  assert.equal(new Date(f.resetAt!).getMinutes(), 8);
  assert.ok(f.resetAt! > now);
});

test('classify: real Codex 401 → auth (not usage)', () => {
  const ev = readFileSync(join(FIX, 'codex-exec-unauthenticated.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'turn.failed');
  assert.equal(classifyText(ev.error.message, Date.now()).cls, 'auth');
});

test('classify: Claude limit phrasings, durations, clock times and Codex error codes', () => {
  const now = new Date(2026, 10, 27, 10, 0, 0).getTime();
  const a = classifyText("You've hit your session limit · resets 3:45pm", now);
  assert.equal(a.cls, 'usage_limit'); assert.equal(a.limitKind, 'five_hour'); assert.equal(new Date(a.resetAt!).getHours(), 15);
  const b = classifyText("You've hit your weekly limit · resets Mon 12:00am", now);
  assert.equal(b.limitKind, 'seven_day'); assert.equal(new Date(b.resetAt!).getDay(), 1);
  const c = classifyText("You've hit your Opus limit · resets 3pm", now);
  assert.equal(c.limitKind, 'model'); assert.equal(c.model, 'opus');
  assert.equal(classifyText('Claude AI usage limit reached|1795763284', now).resetAt, 1795763284000);
  assert.equal(parseRelativeDuration('try again in 2 days 3 hours'), (2 * 24 + 3) * 3600_000);
  assert.equal(new Date(parseClockTime('try again at Dec 3rd, 2026 4:05 PM', now)!).getDate(), 3);
  assert.equal(classifyText('429 Too Many Requests', now).cls, 'rate_limit');
  assert.equal(classifyText('overloaded_error 529', now).cls, 'transient');
  assert.equal(classifyText('prompt is too long', now).cls, 'context_overflow');
  assert.equal(classifyCodexErrorInfo('usageLimitExceeded'), 'usage_limit');
  assert.equal(classifyCodexErrorInfo({ responseStreamDisconnected: { httpStatusCode: 502 } }), 'transient');
});

test('codex app-server: real rate-limit snapshot → unavailable with provider reset time', () => {
  const r = JSON.parse(readFileSync(join(FIX, 'codex-app-server-ratelimits.json'), 'utf8')).response;
  const p = interpretCodexRateLimits(r);
  assert.equal(p.available, false);
  assert.equal(p.resetAt, 1795763284000);
  assert.equal(p.windows.find((w) => w.window.startsWith('secondary'))!.status, 'allowed');
});

test('claude adapter parses real stream-json success output (fake CLI replaying captured fixture)', async () => {
  const d = tmp();
  const bin = fakeCli(d, 'claude', `cat >/dev/null; cat ${join(FIX, 'claude-stream-success.jsonl')}`);
  const cfg = defaultConfig(d);
  const a = new ClaudeAdapter({ ...cfg.providers.claude!, command: bin }, new ManualClock(), {});
  const r = await a.execute({ prompt: 'x', cwd: d, mode: 'read-only', timeoutMs: 10000, env: { PATH: process.env.PATH! }, outputSchema: { type: 'object' }, meta: { taskId: 't', taskKind: 'answer', role: 'x', projectId: 'p', attempt: 1 } });
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, '5228d4c8-bd75-4d69-b50b-db9aff523182');
  assert.equal(r.authSource, 'none');
  assert.ok(r.usage!.outputTokens! > 0);
  assert.ok(r.rateLimits.some((w) => w.window === 'seven_day' && w.utilization === 0.64 && w.resetsAt === 1796086800000));
  rmSync(d, { recursive: true, force: true });
});

test('claude adapter: API-key auth source is refused unless billing is authorized; rejected rate limit → usage_limit', async () => {
  const d = tmp();
  const bin = fakeCli(d, 'claude', `cat >/dev/null; echo '{"type":"system","subtype":"init","session_id":"s1","apiKeySource":"ANTHROPIC_API_KEY"}'; sleep 5`);
  const cfg = defaultConfig(d);
  const a = new ClaudeAdapter({ ...cfg.providers.claude!, command: bin }, new ManualClock(), {});
  const r = await a.execute({ prompt: 'x', cwd: d, mode: 'read-only', timeoutMs: 10000, env: { PATH: process.env.PATH! }, meta: { taskId: 't', taskKind: 'answer', role: 'x', projectId: 'p', attempt: 1 } });
  assert.equal(r.failure?.cls, 'billing_policy');
  const bin2 = fakeCli(d, 'claude2', `cat >/dev/null; echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1795756200,"rateLimitType":"five_hour"},"session_id":"s2"}'; echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"limit","session_id":"s2"}'; exit 1`);
  const b = new ClaudeAdapter({ ...cfg.providers.claude!, command: bin2 }, new ManualClock(), {});
  const r2 = await b.execute({ prompt: 'x', cwd: d, mode: 'read-only', timeoutMs: 10000, env: { PATH: process.env.PATH! }, meta: { taskId: 't', taskKind: 'answer', role: 'x', projectId: 'p', attempt: 1 } });
  assert.equal(r2.failure?.cls, 'usage_limit');
  assert.equal(r2.failure?.resetAt, 1795756200000);
  assert.equal(r2.failure?.resetSource, 'provider');
  assert.equal(parseClaudeRateLimit({ status: 'allowed_warning', utilization: 0.9, rateLimitType: 'seven_day' })[0]!.status, 'warning');
  rmSync(d, { recursive: true, force: true });
});

test('codex adapter: real usage-limit JSONL via fake CLI → usage_limit; args include resume + schema; killed process classified', async () => {
  const d = tmp();
  const bin = fakeCli(d, 'codex', `cat >/dev/null; cat ${join(FIX, 'codex-exec-usage-limit.jsonl')}; exit 1`);
  const cfg = defaultConfig(d);
  const a = new CodexAdapter({ ...cfg.providers.codex!, command: bin }, new ManualClock(new Date(2026, 10, 27, 4, 11).getTime()), {});
  const r = await a.execute({ prompt: 'x', cwd: d, mode: 'workspace-write', timeoutMs: 10000, env: { PATH: process.env.PATH! }, meta: { taskId: 't', taskKind: 'implement', role: 'x', projectId: 'p', attempt: 1 } });
  assert.equal(r.failure?.cls, 'usage_limit');
  assert.equal(r.sessionId, '01a21b33-46a9-7742-8eda-396a825239a0');
  const args = a.buildArgs({ prompt: '', cwd: '/w', mode: 'read-only', timeoutMs: 1, env: {}, resumeSessionId: 'abc', model: 'm', effort: 'low', meta: { taskId: 't', taskKind: 'review', role: 'r', projectId: 'p', attempt: 1 } }, '/s.json', '/o.txt');
  assert.deepEqual(args.slice(-3), ['resume', 'abc', '-']);
  assert.ok(args.includes('--output-schema') && args.includes('read-only'));
  const slow = fakeCli(d, 'codex-slow', `if [ "$1" = login ]; then echo "Logged in using ChatGPT"; exit 0; fi; cat >/dev/null; echo '{"type":"thread.started","thread_id":"t9"}'; sleep 30`);
  const s = new CodexAdapter({ ...cfg.providers.codex!, command: slow }, new ManualClock(), {});
  const ac = new AbortController();
  const pr = s.execute({ prompt: 'x', cwd: d, mode: 'read-only', timeoutMs: 20000, env: { PATH: process.env.PATH! }, signal: ac.signal, meta: { taskId: 't', taskKind: 'review', role: 'x', projectId: 'p', attempt: 1 } });
  setTimeout(() => ac.abort(), 300);
  const rs = await pr;
  assert.equal(rs.failure?.cls, 'interrupted');
  assert.equal(rs.sessionId, 't9', 'session id preserved for resume');
  rmSync(d, { recursive: true, force: true });
});

test('codex strict schema: additionalProperties=false and all properties required', () => {
  const s = strictSchema(SCHEMAS.review) as any;
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required.sort(), Object.keys(s.properties).sort());
  assert.equal(s.properties.findings.items.additionalProperties, false);
  assert.equal(extractJson('Here:\n```json\n{"a":1}\n```'), '{"a":1}');
});

test('queue: idempotent enqueue, single winner claim, lease fencing', () => {
  const db = new Db(':memory:');
  const clock = new ManualClock();
  db.run("INSERT INTO projects(id,name,goal_text,goal_sha256,status,repo_mode,repo_source,workspace_dir,settings,created_at,updated_at) VALUES ('p','n','g','h','active','local','','/x','{}',0,0)");
  const q = new TaskQueue(db, clock);
  const a = q.enqueue({ projectId: 'p', kind: 'implement', role: 'r', idempotencyKey: 'k1', input: {} });
  const b = q.enqueue({ projectId: 'p', kind: 'implement', role: 'r', idempotencyKey: 'k1', input: {} });
  assert.equal(a.task.id, b.task.id); assert.equal(b.created, false);
  assert.ok(q.claim(a.task.id, 'w1', 'codex', 1000));
  assert.equal(q.claim(a.task.id, 'w2', 'claude', 1000), null, 'second claim loses');
  assert.equal(q.succeed(a.task.id, 'w2', {}), false, 'non-owner cannot complete');
  clock.advance(2000);
  assert.equal(q.expiredLeases().length, 1);
  assert.ok(q.recoverOrphan(a.task.id, 'w1'));
  assert.equal(q.get(a.task.id)!.attempts, 0, 'recovery does not burn retry budget');
  db.close();
});

test('db: goal baseline immutable; audit log append-only and hash-chained', () => {
  const db = new Db(':memory:');
  db.run("INSERT INTO projects(id,name,goal_text,goal_sha256,status,repo_mode,repo_source,workspace_dir,settings,created_at,updated_at) VALUES ('p','n','g','h','active','local','','/x','{}',0,0)");
  assert.throws(() => db.run("UPDATE projects SET goal_text='changed' WHERE id='p'"), /immutable/);
  const ev = new EventLog(db, new ManualClock());
  ev.audit('op', 'a1'); ev.audit('op', 'a2');
  assert.equal(ev.verifyAuditChain().ok, true);
  assert.throws(() => db.run("UPDATE audit_log SET action='x'"), /append-only/);
  assert.throws(() => db.run('DELETE FROM audit_log'), /append-only/);
  db.close();
});

test('security: redaction, secret scanning, forbidden files, env scrubbing', () => {
  assert.doesNotMatch(redact('token ghp_' + 'a'.repeat(36)), /a{36}/);
  assert.doesNotMatch(redact('Authorization: Bearer sk-ant-api03-' + 'x'.repeat(40)), /x{40}/);
  assert.equal(scanText('f', `const k = "${'AKIA' + 'ABCDEFGHIJKLMNOP'}";`).length, 1);
  assert.equal(scanText('f', 'aws example AKIAIOSFODNN7EXAMPLE').length, 0, 'documented examples allowed');
  assert.equal(scanDiff(`+++ b/.env\n@@ -0,0 +1 @@\n+X=1\n`)[0]!.rule, 'forbidden-file');
  assert.ok(isForbiddenFile('deploy/key.pem') && !isForbiddenFile('.env.example'));
  const cfg = defaultConfig('/tmp/x');
  const env = agentEnv(cfg, 'claude', {}, { PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 's', HTTPS_PROXY: 'p' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HTTPS_PROXY', 'PATH']);
  cfg.providers.claude!.allowApiKeyBilling = true;
  assert.ok('ANTHROPIC_API_KEY' in agentEnv(cfg, 'claude', {}, { ANTHROPIC_API_KEY: 'k' }));
  assert.ok(globToRegExp('.github/workflows/**').test('.github/workflows/ci.yml'));
  assert.ok(globToRegExp('**/*.pem').test('a/b/c.pem'));
});

test('config: non-loopback dashboard requires a token; heartbeat < lease/2', () => {
  const c = defaultConfig('/tmp/x');
  c.dashboard.host = '0.0.0.0';
  assert.throws(() => validateConfig(c), /access token/);
  const c2 = defaultConfig('/tmp/x');
  c2.supervisor.heartbeatMs = c2.supervisor.leaseMs;
  assert.throws(() => validateConfig(c2), /heartbeat/);
});

test('zip: round trip, CRC verified, zip-slip rejected, deterministic output', () => {
  const d = tmp();
  const entries = [{ name: 'p/a.txt', data: Buffer.from('hello') }, { name: 'p/b/c.bin', data: Buffer.alloc(5000, 7) }];
  writeZip(join(d, 'x.zip'), entries);
  writeZip(join(d, 'y.zip'), [...entries].reverse());
  assert.deepEqual(readFileSync(join(d, 'x.zip')), readFileSync(join(d, 'y.zip')));
  assert.equal(readZip(join(d, 'x.zip')).find((e) => e.name === 'p/a.txt')!.data.toString(), 'hello');
  mkdirSync(join(d, 'out'));
  assert.deepEqual(extractZip(join(d, 'x.zip'), join(d, 'out')).sort(), ['p/a.txt', 'p/b/c.bin']);
  writeZip(join(d, 'evil.zip'), [{ name: '../escape.txt', data: Buffer.from('x') }]);
  assert.throws(() => extractZip(join(d, 'evil.zip'), join(d, 'out')), /unsafe path/);
  rmSync(d, { recursive: true, force: true });
});

test('plan validation: accepts demo plan; rejects cycles, unknown deps, uncovered mandatory requirements', () => {
  assert.deepEqual(validatePlan(demoPlan()), []);
  const bad = demoPlan() as any;
  bad.work_items[0].depends_on = ['W-002'];
  assert.ok(validatePlan(bad).some((e) => e.includes('cycle')));
  const bad2 = demoPlan() as any;
  bad2.work_items[1].depends_on = ['W-999'];
  assert.ok(validatePlan(bad2).some((e) => e.includes('unknown key W-999')));
  const bad3 = demoPlan() as any;
  bad3.work_items = bad3.work_items.filter((w: any) => w.key !== 'W-003');
  assert.ok(validatePlan(bad3).some((e) => e.includes('R-003')));
  assert.deepEqual(validate(SCHEMAS.plan, demoPlan()), []);
  assert.ok(validate(SCHEMAS.review, { verdict: 'maybe' }).length > 0);
});

test('context budget: low-priority sections trimmed first; priority-0 sections preserved', () => {
  const out = renderSections([
    { title: 'Policies', body: 'MUST KEEP', priority: 0 },
    { title: 'Diff', body: 'x'.repeat(50_000), priority: 1 },
    { title: 'Inbox', body: 'y'.repeat(50_000), priority: 3 },
  ], 20_000);
  assert.ok(out.length <= 20_500);
  assert.ok(out.includes('MUST KEEP'));
});

test('sandbox (bubblewrap): gate commands cannot read credentials, write outside the worktree, or reach the network', async (t) => {
  const { findBwrap, runSandboxed } = await import('../src/security/sandbox.js');
  if (!findBwrap()) { t.skip('bubblewrap unavailable'); return; }
  const d = tmp();
  const wt = join(d, 'wt'); mkdirSync(wt);
  const secretDir = join(d, 'orch-home'); mkdirSync(secretDir);
  writeFileSync(join(secretDir, 'secret.txt'), 'TOPSECRET');
  const cfg = defaultConfig(secretDir);
  cfg.security.sandbox = 'bwrap';
  const spec = { cwd: wt, writable: [wt], hide: [secretDir], network: false };
  const env = { PATH: process.env.PATH!, HOME: wt };
  const ok = await runSandboxed(cfg, spec, 'echo hi > inside.txt && cat inside.txt', env, 10000);
  assert.equal(ok.exitCode, 0); assert.match(ok.stdout, /hi/); assert.equal(ok.sandbox, 'bwrap');
  const read = await runSandboxed(cfg, spec, `cat ${join(secretDir, 'secret.txt')}`, env, 10000);
  assert.notEqual(read.exitCode, 0); assert.doesNotMatch(read.stdout, /TOPSECRET/);
  const home = await runSandboxed(cfg, spec, 'ls ~/.codex/auth.json /root/.codex/auth.json 2>&1; test ! -e /root/.codex/auth.json', env, 10000);
  assert.equal(home.exitCode, 0, 'real home directory is hidden');
  await runSandboxed(cfg, spec, `echo x > ${join(d, 'escape.txt')}; echo y > /etc/orch-escape 2>/dev/null; echo z > ${join(secretDir, 'planted.txt')}`, env, 10000);
  assert.equal(existsSync(join(d, 'escape.txt')), false, 'write outside worktree never reaches the host');
  assert.equal(existsSync('/etc/orch-escape'), false);
  assert.equal(existsSync(join(secretDir, 'planted.txt')), false);
  const net = await runSandboxed(cfg, spec, `node -e "require('net').connect(443,'1.1.1.1').on('error',()=>process.exit(3)).on('connect',()=>process.exit(0))"`, env, 15000);
  assert.notEqual(net.exitCode, 0, 'no network');
  rmSync(d, { recursive: true, force: true });
});

test('capacity: success that reports a rejected window keeps the provider exhausted (no flap); stale reset clamps to ≥1 min', async () => {
  const { CapacityManager } = await import('../src/engine/capacity.js');
  const db = new Db(':memory:');
  const clock = new ManualClock(Date.UTC(2026, 10, 27, 5, 10, 13));
  const cap = new CapacityManager(db, clock, defaultConfig('/tmp/x'), new EventLog(db, clock));
  cap.recordSuccess('claude', [{ window: 'five_hour', status: 'rejected', resetsAt: Date.UTC(2026, 10, 27, 5, 10, 0) }]);
  const s = cap.get('claude');
  assert.equal(s.status, 'exhausted');
  assert.equal(s.reset_at, clock.now() + 60_000, 'reset in the past is clamped to now + 1 min');
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type='provider.status'")!.n, 1, 'single transition, no flap');
  clock.advance(61_000);
  await cap.tick(new Map());
  db.close();
});

test('codex billing guard: API-key login is refused at execution time unless billing is authorized', async () => {
  const d = tmp();
  const bin = fakeCli(d, 'codex', 'if [ "$1" = login ]; then echo "Logged in using an API key - sk-proj-***"; exit 0; fi; cat >/dev/null; prev=""; for a in "$@"; do if [ "$prev" = "-o" ]; then echo "{}" > "$a"; fi; prev="$a"; done; echo \'{"type":"thread.started","thread_id":"t1"}\'; echo \'{"type":"turn.completed","usage":{}}\'');
  const cfg = defaultConfig(d);
  const meta = { taskId: 't', taskKind: 'review' as const, role: 'x', projectId: 'p', attempt: 1 };
  const a = new CodexAdapter({ ...cfg.providers.codex!, command: bin }, new ManualClock(), { PATH: process.env.PATH! });
  const r = await a.execute({ prompt: 'x', cwd: d, mode: 'read-only', timeoutMs: 10000, env: { PATH: process.env.PATH! }, meta });
  assert.equal(r.failure?.cls, 'billing_policy');
  const b = new CodexAdapter({ ...cfg.providers.codex!, command: bin, allowApiKeyBilling: true }, new ManualClock(), { PATH: process.env.PATH! });
  const r2 = await b.execute({ prompt: 'x', cwd: d, mode: 'read-only', timeoutMs: 10000, env: { PATH: process.env.PATH! }, meta });
  assert.notEqual(r2.failure?.cls, 'billing_policy', 'authorized billing proceeds');
  rmSync(d, { recursive: true, force: true });
});
