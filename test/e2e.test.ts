// End-to-end lifecycle with simulated providers and REAL git, worktrees, gates and packaging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readZip } from '../src/util/zip.js';
import { DEMO_GOAL, demoBehaviour, type ScenarioState } from './support/scenario.js';
import { drive, makeHarness, newDemoProject } from './support/harness.js';

test('goal → plan → debate → implement → gates → cross review → remediation → Q&A → audit → verified ZIP', async () => {
  const state: ScenarioState = { calls: {}, log: [] };
  const h = makeHarness(demoBehaviour(state));
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, (x) => ['completed', 'blocked', 'failed'].includes(x.status), p0.id, { maxTicks: 600 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    const db = h.ctx.db;

    // Requirements verified with evidence.
    const reqs = db.all<{ key: string; status: string }>('SELECT key, status FROM requirements WHERE project_id=? ORDER BY key', p.id);
    assert.deepEqual(reqs.map((r) => r.status), ['verified', 'verified', 'verified']);

    // Deliberate defect: W-001 gates failed first, then remediated and passed.
    const w1gates = db.all<{ status: string; scope: string }>("SELECT g.status, g.scope FROM gate_runs g JOIN work_items w ON w.id=g.work_item_id WHERE w.key='W-001' AND g.name='test' ORDER BY g.started_at", );
    assert.equal(w1gates[0]!.status, 'fail');
    assert.ok(w1gates.some((g) => g.status === 'pass'));
    assert.ok(state.calls['remediate:W-001']! >= 1);

    // Review finding on W-002 recorded, remediated, and independently verified (not by assertion).
    const f = db.get<{ status: string; reviewer_provider: string; resolution_evidence: string }>("SELECT f.* FROM findings f JOIN work_items w ON w.id=f.work_item_id WHERE w.key='W-002'")!;
    assert.equal(f.status, 'verified');
    assert.match(f.resolution_evidence, /verified by/);

    // Cross-provider review: reviewer provider differs from implementer provider.
    const w2 = db.get<{ implementer_provider: string; id: string }>("SELECT * FROM work_items WHERE key='W-002'")!;
    const rev = db.get<{ provider: string }>("SELECT provider FROM tasks WHERE work_item_id=? AND kind='review' ORDER BY created_at LIMIT 1", w2.id)!;
    assert.notEqual(rev.provider, w2.implementer_provider, 'review should run on the other provider');

    // No agent reviewed its own work.
    const selfReview = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks r JOIN work_items w ON w.id=r.work_item_id WHERE r.kind IN ('review','verify_fix','security_review') AND r.agent_id = w.implementer_agent_id")!.n;
    assert.equal(selfReview, 0);

    // Q&A: documentation agent asked, backend answered, the asker resumed.
    const q = db.get<{ id: string; state: string }>("SELECT * FROM messages WHERE type='question'")!;
    const a = db.get<{ reply_to: string }>("SELECT * FROM messages WHERE type='answer' AND reply_to=?", q.id);
    assert.ok(a, 'question was answered');
    assert.ok(state.log.some((l) => l.includes('implement:W-003') && l.includes('resumed')), 'asker resumed its session');

    // Debate: decided with security objection resolved; W-002 waited for it.
    const dec = db.get<{ status: string; security_resolutions: string }>("SELECT * FROM decisions WHERE key='ADR-001'")!;
    assert.equal(dec.status, 'decided');
    assert.match(dec.security_resolutions, /Static imports/);
    const positions = db.all<{ provider: string }>('SELECT DISTINCT provider FROM decision_positions');
    assert.ok(positions.length >= 2, 'both providers participated in the debate');

    // Completion audit ran on both providers.
    const auditors = db.all<{ provider: string }>("SELECT provider FROM tasks WHERE kind='completion_audit' AND status='succeeded'");
    assert.equal(new Set(auditors.map((x) => x.provider)).size, 2);

    // Release ZIP exists, verified, contains manifest + no secrets.
    const rel = db.get<{ status: string; zip_path: string; sha256: string }>("SELECT * FROM releases WHERE project_id=?", p.id)!;
    assert.equal(rel.status, 'verified');
    assert.ok(existsSync(rel.zip_path) && existsSync(rel.zip_path + '.sha256'));
    const names = readZip(rel.zip_path).map((e) => e.name);
    for (const n of ['RELEASE/manifest.json', 'RELEASE/sbom.cdx.json', 'RELEASE/requirements-matrix.md', 'RELEASE/security-assessment.md', 'RELEASE/rollback.md', 'RELEASE/adr/ADR-001.md', 'src/calc.js', 'README.md']) {
      assert.ok(names.some((x) => x.endsWith(n)), `zip contains ${n}`);
    }

    // No duplicate tasks per idempotency family and audit chain intact.
    const dup = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM (SELECT idempotency_key, COUNT(*) c FROM tasks GROUP BY idempotency_key HAVING c > 1)')!.n;
    assert.equal(dup, 0);
    assert.equal(h.ctx.events.verifyAuditChain().ok, true);
  } finally {
    h.cleanup();
  }
});
