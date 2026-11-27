// Scenario group E: autonomous recovery (usage limits, failover, staggered resets, restarts,
// killed agents, lease fencing, duplicate prevention, preserved communications).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor } from '../src/engine/supervisor.js';
import type { SimBehaviour } from '../src/providers/simulated.js';
import { DEMO_GOAL, demoBehaviour } from './support/scenario.js';
import { drive, makeHarness, newDemoProject, type Harness } from './support/harness.js';

const HOUR = 3_600_000;
const done = (s: string) => ['completed', 'blocked', 'failed'].includes(s);

function exhaust(h: Harness, provider: 'claude' | 'codex', untilMs: () => number, base: SimBehaviour): SimBehaviour {
  return (req, c) => {
    if (c.provider === provider && h.clock.now() < untilMs()) {
      return { failure: { cls: 'usage_limit', message: `You've hit your usage limit (${provider})`, resetAt: untilMs(), resetSource: 'provider', limitKind: 'five_hour' } };
    }
    return base(req, c);
  };
}

test('E: Codex exhaustion → eligible Claude failover → Codex recovers after provider-reported reset', async () => {
  const base = demoBehaviour();
  let h!: Harness;
  let resetAt = 0;
  h = makeHarness((req, c) => exhaust(h, 'codex', () => resetAt, base)(req, c), (cfg) => { cfg.routing.failoverAfterMinutes = 10; });
  resetAt = h.clock.now() + 2 * HOUR;
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 800, stepMs: 20_000 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    assert.equal(h.ctx.capacity.get('codex').status, 'exhausted', 'claude finished the work while codex was still limited');
    // After the provider-reported reset, a non-model capacity probe restores codex without spending usage.
    h.codex.capacity = { available: true, windows: [{ window: 'primary_300m', status: 'allowed', utilization: 0.02, resetsAt: null }] };
    h.clock.set(resetAt + 1000);
    await h.sup.tick();
    assert.equal(h.ctx.capacity.get('codex').status, 'available');
    const exhaustedEvt = h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type='provider.status' AND message LIKE 'codex:%→ exhausted%'")!.n;
    assert.ok(exhaustedEvt >= 1, 'codex was marked exhausted');
    // While codex was exhausted, codex was not called again until its reset (no polling of an exhausted provider).
    const codexCallsDuringLimit = h.codex.calls.filter((c) => c.at < resetAt).length;
    assert.ok(codexCallsDuringLimit <= 1, `codex called ${codexCallsDuringLimit} times before reset`);
    assert.ok(h.claude.calls.length > 0, 'claude carried the work');
    // The provider-reported reset time was used.
    const evt = h.ctx.db.get<{ data: string }>("SELECT data FROM events WHERE type='provider.status' AND message LIKE 'codex:%→ exhausted%'")!;
    assert.equal(JSON.parse(evt.data).resetAt, resetAt);
  } finally { h.cleanup(); }
});

test('E: Claude exhaustion → eligible Codex failover', async () => {
  const base = demoBehaviour();
  let h!: Harness;
  let resetAt = 0;
  h = makeHarness((req, c) => exhaust(h, 'claude', () => resetAt, base)(req, c));
  resetAt = h.clock.now() + 5 * HOUR;
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 1500, stepMs: 30_000 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    assert.ok(h.claude.calls.filter((c) => c.at < resetAt).length <= 1);
    assert.ok(h.codex.calls.length > 0);
  } finally { h.cleanup(); }
});

test('E: simultaneous exhaustion → supervisor waits (no polling) → staggered resets → automatic continuation, surviving a restart while waiting', async () => {
  const base = demoBehaviour();
  let h!: Harness;
  let codexReset = 0;
  let claudeReset = 0;
  let planned = false;
  h = makeHarness((req, c) => {
    if (req.meta.taskKind === 'plan') { planned = true; return base(req, c); }
    if (planned) {
      if (c.provider === 'codex' && h.clock.now() < codexReset) return { failure: { cls: 'usage_limit', message: 'codex limit', resetAt: codexReset, resetSource: 'provider', limitKind: 'five_hour' } };
      if (c.provider === 'claude' && h.clock.now() < claudeReset) return { failure: { cls: 'usage_limit', message: 'claude limit', resetAt: claudeReset, resetSource: 'provider', limitKind: 'seven_day' } };
    }
    return base(req, c);
  });
  codexReset = h.clock.now() + 3 * HOUR;
  claudeReset = h.clock.now() + 6 * HOUR;
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    // Run until both providers are exhausted.
    await drive(h, () => h.ctx.capacity.get('codex').status === 'exhausted' && h.ctx.capacity.get('claude').status === 'exhausted', p0.id, { maxTicks: 200, stepMs: 1000 });
    const callsAtExhaustion = h.codex.calls.length + h.claude.calls.length;
    // Advance 2h in 10-minute steps: nothing may be executed, project must not fail.
    for (let i = 0; i < 12; i++) { await h.sup.tick(); await h.sup.settle(); h.clock.advance(10 * 60_000); }
    assert.equal(h.codex.calls.length + h.claude.calls.length, callsAtExhaustion, 'no provider calls while both exhausted');
    const mid = h.ctx.db.get<{ status: string; status_reason: string }>('SELECT status, status_reason FROM projects WHERE id=?', p0.id)!;
    assert.ok(!done(mid.status), `project stays runnable while waiting (${mid.status})`);
    assert.match(mid.status_reason, /waiting for provider capacity/);
    const waitingBefore = h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status='waiting_capacity'")!.n;
    assert.ok(waitingBefore >= 1);

    // Restart the supervisor while waiting for capacity.
    const sup2 = new Supervisor(h.ctx, { lock: false });
    await sup2.recover();
    h.sup = sup2;

    // Codex resets first (staggered); work continues on codex before claude is back.
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 3000, stepMs: 60_000 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    const firstAfter = [...h.codex.calls, ...h.claude.calls].filter((c) => c.at >= codexReset).sort((a, b) => a.at - b.at)[0]!;
    assert.equal(firstAfter.provider, 'codex', 'codex resumed first after its earlier reset');
    assert.ok(firstAfter.at < claudeReset, 'work continued before claude reset');
    // Claude's later reset is honoured independently: it leaves 'exhausted' only once its own reset passes.
    if (h.clock.now() < claudeReset) {
      assert.equal(h.ctx.capacity.get('claude').status, 'exhausted');
      h.clock.set(claudeReset + 1000);
      await h.sup.tick();
    }
    assert.ok(['recovering', 'available'].includes(h.ctx.capacity.get('claude').status), 'claude recovers after its own reset');
    // Interrupted sessions resumed natively where possible.
    assert.ok([...h.codex.calls, ...h.claude.calls].some((c) => c.resumed), 'at least one native resume');
    const dup = h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM (SELECT idempotency_key, COUNT(*) c FROM tasks GROUP BY idempotency_key HAVING c > 1)')!.n;
    assert.equal(dup, 0);
  } finally { h.cleanup(); }
});

test('E: killed agent and supervisor crash mid-run → lease fencing, orphan recovery, resume, no duplicate work', async () => {
  const base = demoBehaviour();
  let hangOnce = true;
  let killedOnce = true;
  const stopLater: Supervisor[] = [];
  const h = makeHarness((req, c) => {
    if (req.meta.taskKind === 'implement' && req.meta.workItemKey === 'W-001' && hangOnce) { hangOnce = false; return { hang: true }; }
    if (req.meta.taskKind === 'implement' && req.meta.workItemKey === 'W-003' && killedOnce && !c.resumed) { killedOnce = false; return { failure: { cls: 'killed', message: 'process terminated by SIGKILL' } }; }
    return base(req, c);
  });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const sup1 = h.sup;
    stopLater.push(sup1);
    // Drive until the hanging W-001 implementation is running under sup1.
    for (let i = 0; i < 100; i++) {
      await sup1.tick();
      if (h.ctx.db.get("SELECT 1 FROM tasks t JOIN work_items w ON w.id=t.work_item_id WHERE w.key='W-001' AND t.kind='implement' AND t.status='running' AND t.session_id IS NOT NULL")) break;
      await new Promise((r) => setTimeout(r, 20));
      h.clock.advance(1000);
    }
    const t1 = h.ctx.db.get<{ id: string; lease_owner: string; session_id: string }>("SELECT t.* FROM tasks t JOIN work_items w ON w.id=t.work_item_id WHERE w.key='W-001' AND t.kind='implement'")!;
    assert.equal(t1.lease_owner, sup1.instanceId);
    // "Crash": sup1 disappears without shutdown. Its lease expires; a new supervisor recovers.
    h.clock.advance(h.ctx.cfg.supervisor.leaseMs + 1000);
    const sup2 = new Supervisor(h.ctx, { lock: false });
    const rec = await sup2.recover();
    assert.ok(rec.requeued >= 1);
    h.sup = sup2;
    // Late result from the crashed worker must be fenced off.
    assert.equal(h.ctx.queue.succeed(t1.id, sup1.instanceId, { status: 'completed' }), false, 'stale owner cannot write');
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 800 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    // Hung run was resumed (session preserved) rather than restarted from scratch.
    assert.ok(h.claude.calls.concat(h.codex.calls).some((c) => c.req.meta.workItemKey === 'W-001' && c.req.meta.taskKind === 'implement' && c.resumed));
    // Killed W-003 run was retried and the work item completed once.
    const w3 = h.ctx.db.all<{ status: string }>("SELECT t.status FROM tasks t JOIN work_items w ON w.id=t.work_item_id WHERE w.key='W-003' AND t.kind='implement' AND t.status='succeeded'");
    assert.equal(w3.length, 1);
    const branches = h.ctx.db.all<{ branch: string }>('SELECT branch FROM work_items WHERE project_id=?', p0.id);
    assert.equal(new Set(branches.map((b) => b.branch)).size, branches.length, 'one branch per work item');
  } finally { for (const s of [...stopLater, h.sup]) await s.stop(0).catch(() => {}); h.cleanup(); }
});

test('E: authentication expiry is handled separately from usage exhaustion and requests reauthentication', async () => {
  const base = demoBehaviour();
  let h!: Harness;
  let authBroken = true;
  h = makeHarness((req, c) => (c.provider === 'codex' && authBroken ? { failure: { cls: 'auth', message: '401 Unauthorized: token expired' } } : base(req, c)));
  try {
    h.codex.authOk = false;
    const p0 = newDemoProject(h, DEMO_GOAL);
    await drive(h, () => h.ctx.capacity.get('codex').status === 'auth_required', p0.id, { maxTicks: 100, stepMs: 1000 });
    const appr = h.ctx.db.get<{ action: string; reason: string }>("SELECT * FROM approvals WHERE action='provider_reauthentication'")!;
    assert.match(appr.reason, /codex login/);
    assert.notEqual(h.ctx.capacity.get('codex').status, 'exhausted');
    // Operator re-authenticates; periodic CLI auth check (no model usage) restores the provider.
    authBroken = false;
    h.codex.authOk = true;
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 800, stepMs: 60_000 });
    assert.equal(p.status, 'completed');
    assert.equal(h.ctx.capacity.get('codex').status, 'available');
  } finally { h.cleanup(); }
});
