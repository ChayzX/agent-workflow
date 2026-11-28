// Regression tests for defects found by the independent review of PR #1 (each was reproduced first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueCommand } from '../src/app.js';
import { Supervisor } from '../src/engine/supervisor.js';
import { collectDir, writeZip, readZip, extractZip } from '../src/util/zip.js';
import { scanTree, scanText } from '../src/security/secrets.js';
import { defaultConfig } from '../src/core/config.js';
import { DEMO_GOAL, demoBehaviour } from './support/scenario.js';
import { drive, makeHarness, newDemoProject } from './support/harness.js';

const done = (s: string) => ['completed', 'blocked', 'failed'].includes(s);

test('review#1: a remediation that commits nothing re-runs gates and re-review instead of sticking in gating', async () => {
  const base = demoBehaviour();
  let disputes = 0;
  const h = makeHarness((req, c) => {
    // First W-002 remediation changes nothing (agent disputes); the verify then still finds it open; second remediation fixes.
    if (req.meta.taskKind === 'remediate' && req.meta.workItemKey === 'W-002' && disputes++ === 0)
      return { structured: { status: 'completed', summary: 'no change needed', files_changed: [], tests_added: [], addressed_finding_ids: [], root_cause: 'n/a', notes: '', messages: [] } };
    return base(req, c);
  });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 600 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    assert.ok(disputes >= 2, 'a second remediation round happened');
  } finally { h.cleanup(); }
});

test('review#2/#3: repeated failing remediation triggers exactly one investigation at a time, no storm, bounded', async () => {
  const base = demoBehaviour();
  let investigations = 0;
  let n = 0;
  const h = makeHarness((req, c) => {
    if (req.meta.taskKind === 'remediate' && req.meta.workItemKey === 'W-001') {
      writeFileSync(join(req.cwd, 'src/calc.js'), `// attempt ${++n}\nexport function add(a, b) {\n  return a - b;\n}\n`);
      return { structured: { status: 'completed', summary: 'tried', files_changed: ['src/calc.js'], tests_added: [], addressed_finding_ids: [], root_cause: 'x', notes: '', messages: [] } };
    }
    if (req.meta.taskKind === 'investigate') { investigations++; return { structured: { root_cause: 'r', strategy: 'retry_same', recommended_role: '', guidance: 'g', blocker: '' } }; }
    return base(req, c);
  }, (cfg) => { cfg.limits.maxRemediationRounds = 2; });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    await drive(h, () => !!h.ctx.db.get("SELECT 1 FROM work_items WHERE key='W-001' AND status='blocked'"), p0.id, { maxTicks: 800 });
    const inv = h.ctx.db.all<{ status: string }>("SELECT t.status FROM tasks t JOIN work_items w ON w.id=t.work_item_id WHERE w.key='W-001' AND t.kind='investigate'");
    assert.equal(inv.length, investigations, 'every investigation task was actually executed (no cancelled storm)');
    assert.equal(investigations, 3, 'bounded at 3 investigations before blocking');
    const keys = h.ctx.db.all<{ k: string }>("SELECT idempotency_key k FROM tasks t JOIN work_items w ON w.id=t.work_item_id WHERE w.key='W-001' AND t.kind='remediate'").map((r) => r.k);
    assert.equal(new Set(keys).size, keys.length, 'remediation keys never collide');
    const w = h.ctx.db.get<{ status: string }>("SELECT status FROM work_items WHERE key='W-001'")!;
    assert.equal(w.status, 'blocked');
  } finally { h.cleanup(); }
});

test('review#8: cancelling a queued review does not strand the item; cancel never overwrites a finished task', async () => {
  const h = makeHarness(demoBehaviour());
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    let cancelled = false;
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 800, onTick: () => {
      if (cancelled) return;
      const t = h.ctx.db.get<{ id: string }>("SELECT t.id FROM tasks t JOIN work_items w ON w.id=t.work_item_id WHERE w.key='W-003' AND t.kind='review' AND t.status='queued'");
      if (t) { issueCommand(h.ctx, 'cancel_task', null, { taskId: t.id }); cancelled = true; }
    } });
    assert.ok(cancelled);
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    const anySucceeded = h.ctx.db.get<{ id: string }>("SELECT id FROM tasks WHERE status='succeeded' LIMIT 1")!;
    assert.equal(h.ctx.queue.cancel(anySucceeded.id, 'late'), false);
    assert.equal(h.ctx.queue.get(anySucceeded.id)!.status, 'succeeded');
  } finally { h.cleanup(); }
});

test('review#7: completion audit never passes with a single auditor (failed auditor is replaced)', async () => {
  const base = demoBehaviour();
  let killed = 0;
  const h = makeHarness((req, c) => {
    if (req.meta.taskKind === 'completion_audit' && killed < 4) { killed++; return { failure: { cls: 'policy_refusal', message: 'auditor refused' } }; }
    return base(req, c);
  });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 900 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    const audits = h.ctx.db.all<{ status: string; result: string }>("SELECT status, result FROM audits WHERE kind='completion' ORDER BY created_at");
    const passed = audits.find((a) => a.status === 'passed')!;
    assert.equal(JSON.parse(passed.result).auditors.length, 2, 'passing audit had two successful auditors');
  } finally { h.cleanup(); }
});

test('review#4: symlinks never smuggle outside files into a package; zip refuses escaping links', () => {
  const d = mkdtempSync(join(tmpdir(), 'orch-sym-'));
  mkdirSync(join(d, 'outside')); writeFileSync(join(d, 'outside', '.credentials.json'), '{"refresh_token":"abcdefghijklmnopqrstuvwxyz0123456789"}'); // orchestrator:allow-secret (test fixture)
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'README.md'), '# x\n');
  symlinkSync(join(d, 'outside', '.credentials.json'), join(d, 'src', 'notes.md'));
  assert.ok(scanTree(join(d, 'src')).some((h) => h.rule === 'symlink-escape'));
  assert.throws(() => collectDir(join(d, 'src'), 'pkg'), /symlink escapes/);
  rmSync(join(d, 'src', 'notes.md'));
  symlinkSync('README.md', join(d, 'src', 'alias.md'));
  writeZip(join(d, 'ok.zip'), collectDir(join(d, 'src'), 'pkg'));
  const e = readZip(join(d, 'ok.zip')).find((x) => x.name === 'pkg/alias.md')!;
  assert.equal(e.data.toString(), 'README.md', 'internal link stored as a link, not its target content');
  mkdirSync(join(d, 'x'));
  extractZip(join(d, 'ok.zip'), join(d, 'x'));
  writeZip(join(d, 'evil.zip'), [{ name: 'pkg/evil', data: Buffer.from('../../outside/.credentials.json'), mode: 0o120777 }]);
  mkdirSync(join(d, 'y'));
  assert.throws(() => extractZip(join(d, 'evil.zip'), join(d, 'y')), /unsafe symlink/);
  rmSync(d, { recursive: true, force: true });
});

test('review#11: secret scanner catches JSON-keyed secrets and Claude OAuth tokens', () => {
  assert.ok(scanText('a.json', '{ "api_key": "abcdefghijklmnopqrstuvwxyz123456" }').length > 0); // orchestrator:allow-secret (test fixture)
  assert.ok(scanText('a.json', '"refresh_token":"Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA"').length > 0); // orchestrator:allow-secret (test fixture)
  assert.ok(scanText('c.txt', 'sk-ant-oat01-' + 'A'.repeat(40)).length > 0);
});

test('review#5: agent processes are confined — no orchestrator secrets, no supervisor /proc, no shared repo writes', async (t) => {
  const { findBwrap, wrapAgentCommand } = await import('../src/security/sandbox.js');
  if (!findBwrap()) { t.skip('bubblewrap unavailable'); return; }
  const d = mkdtempSync(join(tmpdir(), 'orch-agent-'));
  const orch = join(d, 'orch'); const wt = join(orch, 'workspaces', 'p', 'wt', 'W-001'); const repo = join(orch, 'workspaces', 'p', 'repo.git');
  mkdirSync(join(orch, 'secrets'), { recursive: true }); mkdirSync(wt, { recursive: true }); mkdirSync(join(repo, 'hooks'), { recursive: true });
  writeFileSync(join(orch, 'secrets', 'github-token'), 'ghp_SECRET');
  const cfg = defaultConfig(orch);
  const w = wrapAgentCommand(cfg, { orchHome: orch, provider: 'claude', writable: [wt], readOnly: [repo] }, 'sh', ['-c',
    `cat ${join(orch, 'secrets', 'github-token')} 2>/dev/null && echo LEAK; test -e /proc/${process.pid}/environ && echo SEEPROC; echo x > ${join(repo, 'hooks', 'pre-push')} 2>/dev/null && echo HOOKWRITE; echo ok > ${join(wt, 'f.txt')} && echo WROTE`]);
  const out = execFileSync(w.cmd, w.args, { encoding: 'utf8' });
  assert.doesNotMatch(out, /LEAK|SEEPROC|HOOKWRITE/);
  assert.match(out, /WROTE/);
  assert.equal(readFileSync(join(wt, 'f.txt'), 'utf8').trim(), 'ok');
  rmSync(d, { recursive: true, force: true });
});

test('review#10: supervisor lock admits exactly one live instance and recovers a stale lock', async () => {
  const h = makeHarness(demoBehaviour());
  try {
    const a = new Supervisor(h.ctx);
    const b = new Supervisor(h.ctx);
    a.acquireLock();
    assert.throws(() => b.acquireLock(), /another supervisor is running/);
    writeFileSync(join(h.home, 'supervisor.lock'), '999999 sup_dead'); // stale (pid not alive)
    b.acquireLock();
    assert.match(readFileSync(join(h.home, 'supervisor.lock'), 'utf8'), new RegExp(b.instanceId));
    b.releaseLock();
  } finally { h.cleanup(); }
});

test('re-review N1: tampered worktree git metadata (.git / commondir / HEAD / filters) is repaired; supervisor git never runs agent filters', async () => {
  const { Workspace } = await import('../src/git/git.js');
  const base = mkdtempSync(join(tmpdir(), 'orch-gitesc-'));
  for (const variant of ['gitdir', 'commondir', 'config']) {
    const ws = new Workspace(join(base, variant), 'main');
    const tampers: string[] = [];
    ws.onTamper = (f) => tampers.push(...f);
    await ws.ensure(null);
    const wt = (await ws.worktree('W-001', 'orch/w-001', await ws.head())).path;
    const marker = join(base, `${variant}-escaped`);
    const fake = join(wt, '.cache-x');
    execFileSync('git', ['init', '-q', '--bare', fake]);
    writeFileSync(join(wt, '.f.sh'), `#!/bin/sh\nid -un > ${marker}\ncat\n`, { mode: 0o755 });
    const filterCfg = `[filter "x"]\n\tclean = ${join(wt, '.f.sh')}\n`;
    writeFileSync(join(fake, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n${filterCfg}`);
    if (variant === 'gitdir') writeFileSync(join(wt, '.git'), `gitdir: ${fake}\n`);
    if (variant === 'commondir') { writeFileSync(join(ws.bare, 'worktrees', 'W-001', 'commondir'), fake + '\n'); writeFileSync(join(ws.bare, 'worktrees', 'W-001', 'HEAD'), 'ref: refs/heads/main\n'); }
    if (variant === 'config') writeFileSync(join(ws.bare, 'config'), readFileSync(join(ws.bare, 'config'), 'utf8') + filterCfg);
    writeFileSync(join(wt, '.gitattributes'), '*.txt filter=x\n');
    writeFileSync(join(wt, 'a.txt'), 'hello\n');
    await ws.commitAll(wt, 'feat: x');
    assert.equal(existsSync(marker), false, `${variant}: agent-defined filter must never execute`);
    assert.ok(tampers.length > 0, `${variant}: tampering detected and reported`);
    const branch = execFileSync('git', ['--git-dir', join(ws.bare, 'worktrees', 'W-001'), 'symbolic-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(branch, 'refs/heads/orch/w-001', `${variant}: commit landed on the task branch, never on main`);
  }
  rmSync(base, { recursive: true, force: true });
});

test('re-review N2: in-tree symlinks survive packaging and checksum verification', async () => {
  const { lstatSync, readlinkSync } = await import('node:fs');
  const { sha256 } = await import('../src/core/ids.js');
  const b = mkdtempSync(join(tmpdir(), 'orch-ilink-'));
  mkdirSync(join(b, 'src', 'docs'), { recursive: true });
  writeFileSync(join(b, 'src', 'docs', 'README.md'), '# real\n');
  symlinkSync('docs/README.md', join(b, 'src', 'README.md'));
  const entries = collectDir(join(b, 'src'), 'pkg');
  const manifest = entries.map((e) => ({ path: e.name.slice(4), sha256: sha256(e.data) }));
  writeZip(join(b, 'r.zip'), entries);
  mkdirSync(join(b, 'clean'));
  extractZip(join(b, 'r.zip'), join(b, 'clean'));
  const bad = manifest.filter((f) => { const fp = join(b, 'clean', 'pkg', f.path); return sha256(lstatSync(fp).isSymbolicLink() ? Buffer.from(readlinkSync(fp)) : readFileSync(fp)) !== f.sha256; });
  assert.deepEqual(bad, []);
  rmSync(b, { recursive: true, force: true });
});

test('re-review N4: cancelling a queued implementation does not strand the work item', async () => {
  const h = makeHarness(demoBehaviour());
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    let cancelled = false;
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 800, onTick: () => {
      if (cancelled) return;
      const t = h.ctx.db.get<{ id: string }>("SELECT t.id FROM tasks t JOIN work_items w ON w.id=t.work_item_id WHERE w.key='W-003' AND t.kind='implement' AND t.status='queued'");
      if (t) { issueCommand(h.ctx, 'cancel_task', null, { taskId: t.id }); cancelled = true; }
    } });
    assert.ok(cancelled);
    assert.equal(p.status, 'completed', p.status_reason ?? '');
  } finally { h.cleanup(); }
});

test('re-review N6: a stale lock carrying our own pid (e.g. PID 1 restart) is taken over', () => {
  const h = makeHarness(demoBehaviour());
  try {
    writeFileSync(join(h.ctx.paths.home, 'supervisor.lock'), `${process.pid} sup_previous_instance`);
    h.sup.acquireLock();
    assert.match(readFileSync(join(h.ctx.paths.home, 'supervisor.lock'), 'utf8'), new RegExp(h.sup.instanceId));
    h.sup.releaseLock();
  } finally { h.cleanup(); }
});

test('third-pass R1: recover() never follows an agent/gate-planted gitdir; gates cannot rewrite .git', async (t) => {
  const { Workspace } = await import('../src/git/git.js');
  const base = mkdtempSync(join(tmpdir(), 'orch-r1-'));
  const ws = new Workspace(join(base, 'proj'), 'main');
  await ws.ensure(null);
  const wt = (await ws.worktree('W-001', 'orch/w-001', await ws.head())).path;
  const fake = join(wt, '.tmp-cache');
  const env = { ...process.env, GIT_DIR: fake, GIT_WORK_TREE: wt, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' };
  const g = (...a: string[]) => { try { execFileSync('git', a, { env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* conflict expected */ } };
  g('init', '-q', '-b', 'main');
  writeFileSync(join(wt, '.tmp-x.sh'), `#!/bin/sh\nid -un > ${base}/escaped\ncat\n`, { mode: 0o755 });
  writeFileSync(join(wt, '.gitattributes'), '*.txt filter=x\n'); writeFileSync(join(wt, 'a.txt'), 'one\n');
  g('add', '.gitattributes', 'a.txt'); g('commit', '-qm', 'A');
  g('checkout', '-q', '-b', 'topic'); writeFileSync(join(wt, 'a.txt'), 'topic\n'); g('commit', '-qam', 'T');
  g('checkout', '-q', 'main'); writeFileSync(join(wt, 'a.txt'), 'main\n'); g('commit', '-qam', 'M');
  g('checkout', '-q', 'topic'); g('rebase', 'main');
  g('config', 'filter.x.smudge', join(wt, '.tmp-x.sh'));
  writeFileSync(join(wt, '.git'), `gitdir: ${fake}\n`);
  await ws.recover();
  assert.equal(existsSync(join(base, 'escaped')), false, 'planted smudge filter never runs');
  assert.match(readFileSync(join(wt, '.git'), 'utf8'), /worktrees\/W-001/, '.git pointer repaired');
  // Gate sandbox: the .git pointer is read-only for gate commands.
  const { findBwrap, runSandboxed } = await import('../src/security/sandbox.js');
  if (!findBwrap()) { t.diagnostic('bubblewrap unavailable; skipped gate .git check'); rmSync(base, { recursive: true, force: true }); return; }
  const cfg = defaultConfig(join(base, 'orch')); cfg.security.sandbox = 'bwrap';
  await runSandboxed(cfg, { cwd: wt, writable: [wt], hide: [], network: false, readOnlyLast: [join(wt, '.git')] }, 'echo "gitdir: /tmp/evil" > .git', { PATH: process.env.PATH! }, 10000);
  assert.match(readFileSync(join(wt, '.git'), 'utf8'), /worktrees\/W-001/, 'gate could not rewrite .git');
  rmSync(base, { recursive: true, force: true });
});

test('third-pass R2: sandbox relaxation fails closed (approval required) and applies only after approval', async (t) => {
  const { findBwrap, agentSandboxRelaxed, relaxAgentSandbox } = await import('../src/security/sandbox.js');
  if (!findBwrap()) { t.skip('bubblewrap unavailable'); return; }
  const h = makeHarness(demoBehaviour());
  try {
    // A provider whose auth only works when the sandbox is relaxed (like this host's Claude).
    h.claude.checkAuth = async () => ({ ok: agentSandboxRelaxed('claude'), method: 'sim' });
    h.ctx.cfg.security.agentSandbox = 'auto';
    await h.sup.sandboxSelfCheck();
    assert.equal(agentSandboxRelaxed('claude'), false, 'not relaxed without authorization');
    const appr = h.ctx.db.get<{ id: string; action: string }>("SELECT * FROM approvals WHERE dedup_key='sandbox-relax:claude'")!;
    assert.equal(appr.action, 'credential_expansion');
    assert.equal(h.ctx.capacity.get('claude').status, 'auth_required');
    h.ctx.policy.decide(appr.id, true, 'operator');
    await h.sup.tick();
    assert.equal(agentSandboxRelaxed('claude'), true, 'relaxed after operator approval');
    assert.equal(h.ctx.capacity.get('claude').status, 'available');
  } finally { relaxAgentSandbox('claude', false); await h.sup.stop(0).catch(() => {}); h.cleanup(); }
});

test('third-pass R3: mcpServers changes in ~/.claude.json are detected and reverted', async () => {
  const { ClaudeStateGuard } = await import('../src/security/sandbox.js');
  const d = mkdtempSync(join(tmpdir(), 'orch-r3-'));
  const f = join(d, '.claude.json');
  writeFileSync(f, JSON.stringify({ numStartups: 1, mcpServers: { ok: { command: 'x' } }, projects: { '/w': { allowedTools: [] } } }));
  const g = new ClaudeStateGuard([f]);
  g.snapshot();
  // Claude creating an ordinary new project entry is not tampering.
  const norm = JSON.parse(readFileSync(f, 'utf8')); norm.projects['/new-worktree'] = { mcpServers: {}, allowedTools: [] };
  writeFileSync(f, JSON.stringify(norm));
  assert.equal(g.verifyAndRestore(), false, 'no false alarm for new empty project entries');
  const cur = JSON.parse(readFileSync(f, 'utf8'));
  cur.numStartups = 2; cur.mcpServers.evil = { command: 'curl evil' }; cur.projects['/w'].mcpServers = { e: { command: 'sh' } };
  writeFileSync(f, JSON.stringify(cur));
  assert.equal(g.verifyAndRestore(), true);
  const after = JSON.parse(readFileSync(f, 'utf8'));
  assert.deepEqual(Object.keys(after.mcpServers), ['ok']);
  assert.deepEqual(after.projects['/w'].mcpServers, {});
  assert.equal(g.verifyAndRestore(), false, 'no repeated alarm after restore');
  assert.equal(after.numStartups, 2, 'unrelated Claude state preserved');
  rmSync(d, { recursive: true, force: true });
});

test('fourth-pass S1: a PR awaiting human review does not starve other merges; a denied review blocks only that item', async () => {
  const h = makeHarness(demoBehaviour());
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const wf = h.sup.workflow;
    const store = wf.store;
    // Two work items: W-A sits in 'merging' with a pending human-review approval; W-B is merge_ready.
    const mk = (key: string) => store.createWorkItem(p0.id, { key, type: 'feature', title: key, description: 'd', acceptance: ['a'], requirement_keys: [], depends_on: [], paths: [], role: 'backend_engineer', complexity: 'low', priority: 0, milestone: null, source: 'plan' });
    const a = mk('W-A'); mk('W-B');
    store.patchWorkItem(a.id, { status: 'merging', head_commit: 'abc', pr_number: 7 });
    h.ctx.policy.request('human_review_required', 'needs review', { projectId: p0.id, requestedBy: 'test', dedup: `human-review:${p0.id}:W-A:abc` });
    h.ctx.db.run("UPDATE projects SET status='active', plan='{}' WHERE id=?", p0.id);
    await wf.ws(store.project(p0.id)!).ensure(null); // advance() only proceeds once the workspace exists
    const calls: string[] = [];
    (wf as any).continueRemoteMerge = async () => { calls.push('remote'); };
    await wf.advance(store.project(p0.id)!);
    assert.equal(calls.length, 0, 'pending approval: no GitHub calls, integration job left for others');
    const appr = h.ctx.db.get<{ id: string }>("SELECT id FROM approvals WHERE dedup_key=?", `human-review:${p0.id}:W-A:abc`)!;
    h.ctx.policy.decide(appr.id, false, 'operator');
    await wf.advance(store.project(p0.id)!);
    assert.equal(store.workItem(a.id)!.status, 'blocked');
    assert.match(store.workItem(a.id)!.status_reason ?? '', /denied/);
    assert.equal(calls.length, 0, 'denied review never retried against GitHub');
  } finally { await h.sup.workflow.drainJobs(); h.cleanup(); }
});

test('live finding: an agent "blocked" claim with real changes goes to gates/review instead of investigation', async () => {
  const base = demoBehaviour();
  let claimed = false;
  const h = makeHarness((req, c) => {
    if (req.meta.taskKind === 'remediate' && req.meta.workItemKey === 'W-001' && !claimed) {
      claimed = true;
      writeFileSync(join(req.cwd, 'src/calc.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
      return { structured: { status: 'blocked', summary: 'fixed but cannot stage (git read-only)', files_changed: ['src/calc.js'], tests_added: [], addressed_finding_ids: [], root_cause: 'x', notes: 'supervisor must stage', messages: [] } };
    }
    return base(req, c);
  });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 600 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    assert.ok(claimed);
    const inv = h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks t JOIN work_items w ON w.id=t.work_item_id WHERE w.key='W-001' AND t.kind='investigate'")!.n;
    assert.equal(inv, 0, 'no investigation for a blocked claim that left a real fix');
  } finally { h.cleanup(); }
});

test('live finding (run 2): gate commands can use git in a worktree (shared repo.git exposed read-only)', async (t) => {
  const { Workspace } = await import('../src/git/git.js');
  const { findBwrap, runSandboxed } = await import('../src/security/sandbox.js');
  if (!findBwrap()) { t.diagnostic('bubblewrap unavailable; skipped'); return; }
  const base = mkdtempSync(join(tmpdir(), 'orch-gitgate-'));
  try {
    const ws = new Workspace(join(base, 'proj'), 'main');
    await ws.ensure(null);
    const wt = (await ws.worktree('W-001', 'orch/w-001', await ws.head())).path;
    const cfg = defaultConfig(join(base, 'orch')); cfg.security.sandbox = 'bwrap';
    const spec = { cwd: wt, writable: [wt], hide: [base], network: false, readOnlyLast: [join(wt, '.git')] };
    const env = { PATH: process.env.PATH!, HOME: wt };
    const without = await runSandboxed(cfg, spec, 'git rev-parse HEAD', env, 10000);
    assert.notEqual(without.exitCode, 0, 'hidden repo.git breaks git (the bug)');
    const ok = await runSandboxed(cfg, { ...spec, readOnly: [ws.bare] }, 'git rev-parse HEAD && git ls-files >/dev/null', env, 10000);
    assert.equal(ok.exitCode, 0, ok.stderr);
    const write = await runSandboxed(cfg, { ...spec, readOnly: [ws.bare] }, 'git update-ref refs/heads/evil HEAD', env, 10000);
    assert.notEqual(write.exitCode, 0, 'shared repository stays read-only for gates');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('live finding (run 2): auditors are told to read files; a decline with only boolean verdicts is inconclusive, not vague defects', async () => {
  const base = demoBehaviour();
  let declined = 0;
  const prompts: string[] = [];
  const h = makeHarness((req, c) => {
    if (req.meta.taskKind === 'completion_audit') {
      prompts.push(req.prompt);
      if (declined < 1) {
        declined++;
        return { structured: { summary: 'The supplied record contains no README contents.', docs_accurate: false, install_reproducible: false, release_recommended: false, defects: [],
          requirements: ['R-001', 'R-002', 'R-003'].map((key) => ({ key, status: 'satisfied', evidence: 'gate passed', gap: '' })) } };
      }
    }
    return base(req, c);
  });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 900 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    const vague = h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM work_items WHERE title IN ('Installation is not reproducible','Documentation does not match implementation')")!.n;
    assert.equal(vague, 0, 'no vague defects from boolean verdicts alone');
    assert.ok(h.ctx.db.get("SELECT 1 FROM audits WHERE kind='completion' AND status='inconclusive'"), 'decline recorded as inconclusive');
    assert.ok(prompts.length >= 2);
    for (const pr of prompts) {
      assert.match(pr, /Tracked files at the audited commit/);
      assert.match(pr, /src\/calc\.js/);
      assert.doesNotMatch(pr, /You cannot run commands/);
    }
  } finally { h.cleanup(); }
});

test('live finding (run 2): boolean audit verdicts never duplicate a concrete defect as vague work items', async () => {
  const base = demoBehaviour();
  let n = 0;
  const h = makeHarness((req, c) => {
    if (req.meta.taskKind === 'completion_audit' && n < 2) {
      n++;
      // Both auditors of the first audit: one concrete defect, plus the boolean verdicts it implies.
      return { structured: { summary: 'install fails with CRLF', docs_accurate: false, install_reproducible: false, release_recommended: false,
        defects: [{ severity: 'medium', title: 'Installation fails with CRLF line endings', description: 'README.md:12 test requires LF', paths: ['README.md'], acceptance: ['works with CRLF'] }],
        requirements: ['R-001', 'R-002', 'R-003'].map((key) => ({ key, status: 'satisfied', evidence: 'src/calc.js:1', gap: '' })) } };
    }
    return base(req, c);
  });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 900 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    const titles = h.ctx.db.all<{ title: string }>("SELECT title FROM work_items WHERE type='defect'").map((r) => r.title);
    assert.ok(titles.includes('Installation fails with CRLF line endings'), titles.join(', '));
    assert.equal(titles.filter((t) => /not reproducible|does not match implementation/.test(t)).length, 0, titles.join(', '));
  } finally { h.cleanup(); }
});

test('live finding (run 2): operator can unblock a wrongly blocked item; guidance reaches the agent; audited', async () => {
  const base = demoBehaviour();
  const prompts: string[] = [];
  const h = makeHarness((req, c) => { if (req.meta.workItemKey === 'W-002') prompts.push(req.prompt); return base(req, c); });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    let blocked = false;
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 900, onTick: () => {
      const w = h.sup.workflow.store.workItemByKey(p0.id, 'W-002');
      if (!blocked && w && ['ready', 'implementing'].includes(w.status)) {
        blocked = true;
        h.ctx.db.run("UPDATE work_items SET status='blocked', status_reason='agent claimed an external blocker' WHERE id=?", w.id);
        h.ctx.queue.cancelForWorkItem(w.id, 'blocked');
        issueCommand(h.ctx, 'unblock_item', p0.id, { key: 'W-002', note: 'Not an external blocker: gate results are execution evidence.' }, 'operator');
      }
    } });
    assert.ok(blocked, 'item was blocked during the run');
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    assert.ok(prompts.some((x) => x.includes('Operator guidance') && x.includes('gate results are execution evidence')), 'guidance delivered to the agent');
    assert.ok(h.ctx.db.get("SELECT 1 FROM audit_log WHERE action='workitem.unblock'"), 'unblock is in the audit log');
    assert.equal(h.sup.workflow.unblock(h.sup.workflow.store.project(p0.id)!, 'W-002', 'x', 'operator'), 'W-002 is done, not blocked');
  } finally { h.cleanup(); }
});

test('live finding (run 2): operator cancel descopes a vague item; the project still completes; audited', async () => {
  const h = makeHarness(demoBehaviour());
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    let cancelled = false;
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 900, onTick: () => {
      const cur = h.sup.workflow.store.project(p0.id)!;
      if (!cancelled && cur.status === 'active') {
        cancelled = true;
        const d = h.sup.workflow.createDefect(cur, { title: 'Documentation does not match implementation', description: 'vague', severity: 'medium', paths: [], source: 'completion-audit', acceptance: ['docs accurate'] });
        issueCommand(h.ctx, 'cancel_item', p0.id, { key: d.key, note: 'vague audit verdict; superseded' }, 'operator');
      }
    } });
    assert.ok(cancelled);
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    assert.equal(h.ctx.db.get<{ status: string }>("SELECT status FROM work_items WHERE title='Documentation does not match implementation'")!.status, 'cancelled');
    assert.ok(h.ctx.db.get("SELECT 1 FROM audit_log WHERE action='workitem.descoped'"));
  } finally { h.cleanup(); }
});

test('PR #61 review #1: unblock re-runs dependency resolution (a dependent never starts while its dependency is blocked)', async () => {
  const h = makeHarness(demoBehaviour());
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const wf = h.sup.workflow;
    let phase = 0; let violated = false; let reblocked = false;
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 1200, onTick: () => {
      const w1 = wf.store.workItemByKey(p0.id, 'W-001'); const w2 = wf.store.workItemByKey(p0.id, 'W-002');
      if (!w1 || !w2) return;
      if (w1.status === 'blocked' && ['implementing', 'gating', 'in_review'].includes(w2.status)) violated = true;
      if (phase === 0 && ['ready', 'implementing'].includes(w1.status) && w2.status === 'backlog') {
        h.ctx.db.run("UPDATE work_items SET status='blocked' WHERE id=?", w1.id); h.ctx.queue.cancelForWorkItem(w1.id, 'test block'); phase = 1;
      } else if (phase === 1 && w2.status === 'blocked') {
        issueCommand(h.ctx, 'unblock_item', p0.id, { key: 'W-002', note: 'try again' }, 'operator'); phase = 2;
      } else if (phase === 2 && w2.status === 'blocked' && wf.store.checkpointsOfKind(p0.id, w2.id, 'operator_unblock').length === 1) {
        reblocked = true;
        issueCommand(h.ctx, 'unblock_item', p0.id, { key: 'W-001', note: 'dependency fixed' }, 'operator'); phase = 3;
      } else if (phase === 3 && w1.status !== 'blocked') {
        // W-002 and W-003 both depend on W-001; the resolver blocked both. Unblock every dependent.
        for (const w of wf.store.workItems(p0.id).filter((x) => x.status === 'blocked')) issueCommand(h.ctx, 'unblock_item', p0.id, { key: w.key, note: 'dependency is back' }, 'operator');
        phase = 4;
      }
    } });
    assert.ok(reblocked, `dependent was re-blocked by the resolver after unblock (phase ${phase})`);
    assert.equal(violated, false, 'dependent never started while its dependency was blocked');
    assert.equal(p.status, 'completed', p.status_reason ?? '');
  } finally { h.cleanup(); }
});

test('PR #61 review #2/#5/#7: cancel refused once integration starts; block never revives a cancelled item; limits restart after unblock', async () => {
  const h = makeHarness(demoBehaviour());
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 900 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    const wf = h.sup.workflow; const proj = wf.store.project(p0.id)!;
    assert.match(wf.cancelItem(proj, 'W-001', 'x', 'operator'), /not cancelled/);
    for (const st of ['merge_ready', 'merging', 'merged']) {
      h.ctx.db.run('UPDATE work_items SET status=? WHERE key=? AND project_id=?', st, 'W-002', p0.id);
      assert.match(wf.cancelItem(proj, 'W-002', 'x', 'operator'), /integration started or finished/, st);
    }
    // block() on a cancelled item is a no-op (late results cannot revive descoped work).
    h.ctx.db.run("UPDATE work_items SET status='remediation' WHERE key='W-003' AND project_id=?", p0.id);
    assert.equal(wf.cancelItem(proj, 'W-003', 'descoped', 'operator'), 'ok');
    (wf as any).block(proj, wf.store.workItemByKey(p0.id, 'W-003')!, 'late failure');
    assert.equal(wf.store.workItemByKey(p0.id, 'W-003')!.status, 'cancelled');
    // Investigation limit counts only since the last operator unblock.
    h.ctx.db.run("UPDATE work_items SET status='remediation' WHERE key='W-002' AND project_id=?", p0.id);
    const w2 = wf.store.workItemByKey(p0.id, 'W-002')!;
    for (let i = 0; i < 3; i++) {
      const { task } = h.ctx.queue.enqueue({ projectId: p0.id, kind: 'investigate', role: 'engineering_director', workItemId: w2.id, idempotencyKey: `test-inv-${i}`, input: {}, readOnly: true } as any);
      h.ctx.db.run("UPDATE tasks SET status='succeeded', processed=1 WHERE id=?", task.id);
    }
    h.clock.advance(1000);
    (wf as any).requestInvestigation(proj, w2, 'still failing');
    assert.equal(wf.store.workItemByKey(p0.id, 'W-002')!.status, 'blocked', 'limit reached → blocked');
    h.clock.advance(1000);
    assert.equal(wf.unblock(proj, 'W-002', 'operator looked at it', 'operator'), 'ok');
    h.ctx.db.run("UPDATE work_items SET status='remediation' WHERE id=?", w2.id);
    h.clock.advance(1000);
    (wf as any).requestInvestigation(proj, wf.store.workItemByKey(p0.id, 'W-002')!, 'new failure');
    assert.notEqual(wf.store.workItemByKey(p0.id, 'W-002')!.status, 'blocked', 'counter restarted after unblock');
    assert.ok(h.ctx.db.get("SELECT 1 FROM tasks WHERE work_item_id=? AND kind='investigate' AND status='queued'", w2.id), 'a new investigation was queued');
  } finally { h.cleanup(); }
});

test('PR #61 review #8: release recommended but docs/install marked false without a defect is inconclusive, not a pass', async () => {
  const base = demoBehaviour();
  let n = 0;
  const h = makeHarness((req, c) => {
    if (req.meta.taskKind === 'completion_audit' && n < 1) {
      n++;
      return { structured: { summary: 'looks fine', docs_accurate: false, install_reproducible: true, release_recommended: true, defects: [],
        requirements: ['R-001', 'R-002', 'R-003'].map((key) => ({ key, status: 'satisfied', evidence: 'src/calc.js:1', gap: '' })) } };
    }
    return base(req, c);
  });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const p = await drive(h, (x) => done(x.status), p0.id, { maxTicks: 900 });
    assert.equal(p.status, 'completed', p.status_reason ?? '');
    const audits = h.ctx.db.all<{ status: string; result: string }>("SELECT status, result FROM audits WHERE kind='completion' ORDER BY created_at");
    assert.equal(audits[0]!.status, 'inconclusive');
    assert.match(audits[0]!.result, /without a concrete defect/);
    assert.equal(h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM work_items WHERE type='defect'")!.n, 0);
  } finally { h.cleanup(); }
});

test('PR #61 review #9: runGates passes the shared repository to the gate sandbox (git works in gates)', async (t) => {
  const { findBwrap } = await import('../src/security/sandbox.js');
  if (!findBwrap()) { t.diagnostic('bubblewrap unavailable; skipped'); return; }
  const { runGates } = await import('../src/engine/gates.js');
  const h = makeHarness(demoBehaviour(), (c) => { c.security.sandbox = 'bwrap'; });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const ws = h.sup.workflow.ws(p0);
    await ws.ensure(null);
    const head = await ws.head();
    const gates = [{ name: 'git', command: 'git rev-parse HEAD', required: true, kind: 'test' }] as any;
    const without = await runGates(h.ctx, { projectId: p0.id, workItemId: null, scope: 'test', cwd: ws.integration, commit: head, gates });
    const withGit = await runGates(h.ctx, { projectId: p0.id, workItemId: null, scope: 'test', cwd: ws.integration, commit: head, gates, gitDir: ws.bare });
    assert.equal(without.passed, false, 'without gitDir the worktree pointer dangles');
    assert.equal(withGit.passed, true, 'with gitDir git works read-only');
  } finally { h.cleanup(); }
});

test('operator verification #29: GitHub-mode git transport carries the supervisor token (env-scoped, never on disk)', async (t) => {
  const tokDir = mkdtempSync(join(tmpdir(), 'orch-tok-'));
  const tokFile = join(tokDir, 'github-token');
  writeFileSync(tokFile, 'test-token-abc\n', { mode: 0o600 });
  const saved = { a: process.env.GITHUB_TOKEN, b: process.env.ORCH_GITHUB_TOKEN };
  delete process.env.GITHUB_TOKEN; delete process.env.ORCH_GITHUB_TOKEN; // isolate from the host environment
  t.after(() => { if (saved.a !== undefined) process.env.GITHUB_TOKEN = saved.a; if (saved.b !== undefined) process.env.ORCH_GITHUB_TOKEN = saved.b; });
  const h = makeHarness(demoBehaviour(), (c) => { c.github.tokenFile = tokFile; });
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const ws = h.sup.workflow.ws({ ...p0, repo_mode: 'github' });
    const env = (ws as any).auth() as Record<string, string>;
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:test-token-abc').toString('base64')}`);
    assert.deepEqual((h.sup.workflow.ws(p0) as any).auth(), {}, 'local mode gets no credentials');
  } finally { h.cleanup(); rmSync(tokDir, { recursive: true, force: true }); }
});

test('operator verification #31: rejected pushes never retry in a tight loop (scope/auth block at once; others back off, then block)', async () => {
  const h = makeHarness(demoBehaviour());
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    await drive(h, (x) => done(x.status), p0.id, { maxTicks: 900 });
    const wf = h.sup.workflow; const proj = wf.store.project(p0.id)!;
    const reset = (key: string) => { h.ctx.db.run("UPDATE work_items SET status='merge_ready' WHERE project_id=? AND key=?", p0.id, key); return wf.store.workItemByKey(p0.id, key)!; };
    let w = reset('W-001');
    (wf as any).onPushFailure(proj, w, "! [remote rejected] orch/w-001 (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)");
    w = wf.store.workItemByKey(p0.id, 'W-001')!;
    assert.equal(w.status, 'blocked'); assert.match(w.status_reason ?? '', /workflow` scope/);
    w = reset('W-002');
    (wf as any).onPushFailure(proj, w, "fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    assert.equal(wf.store.workItemByKey(p0.id, 'W-002')!.status, 'blocked', 'missing credentials block at once');
    w = reset('W-003');
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      (wf as any).onPushFailure(proj, w, 'error: RPC failed; curl 56 connection reset');
      delays.push(((wf as any).pushRetryAt.get(w.id) as number) - h.clock.now());
      h.clock.advance(1);
    }
    assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000], 'exponential backoff');
    assert.equal(wf.store.workItemByKey(p0.id, 'W-003')!.status, 'merge_ready');
    // While backing off, the item does not take the project's integration slot (other items are not starved).
    const jobs = (wf as any).jobs as Map<string, Promise<void>>;
    h.ctx.db.run("UPDATE projects SET status='active' WHERE id=?", p0.id);
    (wf as any).advanceActive(wf.store.project(p0.id)!);
    assert.equal(jobs.has(`integration:${p0.id}`), false, 'no integration job for an item in backoff');
    // A successful push ends the streak: the count is consecutive, not cumulative.
    h.ctx.db.run('INSERT INTO checkpoints(id, project_id, work_item_id, task_id, kind, summary, data, created_at) VALUES (?,?,?,?,?,?,?,?)', 'ck-ok', p0.id, w.id, null, 'push_ok', 'ok', '{}', h.clock.now());
    h.clock.advance(1);
    (wf as any).onPushFailure(proj, w, 'error: RPC failed; curl 56 connection reset');
    assert.equal(wf.store.workItemByKey(p0.id, 'W-003')!.status, 'merge_ready', 'streak restarted after a successful push');
    assert.equal(((wf as any).pushRetryAt.get(w.id) as number) - h.clock.now(), 30_000);
    for (let i = 0; i < 4; i++) { h.clock.advance(1); (wf as any).onPushFailure(proj, w, 'error: RPC failed; curl 56 connection reset'); }
    assert.equal(wf.store.workItemByKey(p0.id, 'W-003')!.status, 'blocked', 'blocked after 5 consecutive failures');
  } finally { h.cleanup(); }
});

test('operator verification #49/#53: without a working sandbox, gates and agents fail closed unless explicitly opted out', async (t) => {
  const sbx = await import('../src/security/sandbox.js');
  const real = sbx.findBwrap();
  sbx.overrideBwrapForTests(null);
  t.after(() => sbx.overrideBwrapForTests(real ?? undefined));
  const cfg = defaultConfig(mkdtempSync(join(tmpdir(), 'orch-fc-')));
  // Gates: the untrusted command never runs unconfined; the gate records an error with the reason.
  cfg.security.sandbox = 'auto';
  const marker = join(cfg.home, 'ran');
  const r = await sbx.runSandboxed(cfg, { cwd: cfg.home, writable: [cfg.home], hide: [], network: false }, `touch ${marker}`, { PATH: process.env.PATH! }, 5000);
  assert.match(r.spawnError ?? '', /sandbox unavailable/);
  assert.equal(existsSync(marker), false, 'command did not run');
  cfg.security.sandbox = 'none';
  const r2 = await sbx.runSandboxed(cfg, { cwd: cfg.home, writable: [cfg.home], hide: [], network: false }, `touch ${marker}`, { PATH: process.env.PATH! }, 5000);
  assert.equal(r2.exitCode, 0); assert.equal(existsSync(marker), true, 'explicit opt-out runs it');
  // Agents: the supervisor dispatches nothing and records why.
  const h = makeHarness(demoBehaviour(), (c) => { c.security.agentSandbox = 'auto'; });
  try {
    await h.sup.sandboxSelfCheck();
    assert.match(h.sup.sandboxBlocked ?? '', /agent sandbox unavailable/);
    const p0 = newDemoProject(h, DEMO_GOAL);
    for (let i = 0; i < 30; i++) { await h.sup.tick(); h.clock.advance(1000); }
    assert.equal(h.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status IN ('running','succeeded','failed','dead')", p0.id)!.n, 0, 'no agent task ran');
    assert.ok(h.ctx.db.get("SELECT 1 FROM audit_log WHERE action='security.sandbox_unavailable'"));
  } finally { await h.sup.workflow.drainJobs(); h.cleanup(); }
});

test('operator verification #48: provider CLIs symlinked into a hidden home have their real package bound read-only', async (t) => {
  const sbx = await import('../src/security/sandbox.js');
  if (!sbx.findBwrap()) { t.diagnostic('bubblewrap unavailable; skipped'); return; }
  const orchHome = mkdtempSync(join(tmpdir(), 'orch-sym-home-'));
  const pkg = join(orchHome, 'lib', 'node_modules', '@x', 'fakecli');
  mkdirSync(join(pkg, 'bin'), { recursive: true }); mkdirSync(join(orchHome, 'bin'));
  writeFileSync(join(pkg, 'package.json'), '{}'); writeFileSync(join(pkg, 'bin', 'cli.js'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  symlinkSync(join(pkg, 'bin', 'cli.js'), join(orchHome, 'bin', 'fakecli'));
  const savedPath = process.env.PATH;
  process.env.PATH = `${join(orchHome, 'bin')}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; rmSync(orchHome, { recursive: true, force: true }); });
  const cfg = defaultConfig(join(orchHome, 'h')); cfg.security.agentSandbox = 'bwrap';
  const w = sbx.wrapAgentCommand(cfg, { orchHome, provider: 'codex', writable: [], readOnly: [] }, 'fakecli', []);
  const binds = w.args.flatMap((a, i) => (a === '--ro-bind' ? [w.args[i + 1]] : []));
  assert.ok(binds.includes(pkg), `package root bound: ${binds.join(' ')}`);
  const run = execFileSync(w.cmd, w.args, { encoding: 'utf8', env: { PATH: process.env.PATH! } });
  assert.equal(run.trim(), 'ok', 'the symlinked CLI runs inside the sandbox');
});

test('PR #63 review B1: a standalone CLI binary directly in the home never re-exposes the home (SSH keys, GitHub token)', async (t) => {
  const sbx = await import('../src/security/sandbox.js');
  if (!sbx.findBwrap()) { t.diagnostic('bubblewrap unavailable; skipped'); return; }
  const home = mkdtempSync(join(tmpdir(), 'orch-b1-home-'));
  const orchHome = join(home, '.orch');
  mkdirSync(join(home, '.ssh')); writeFileSync(join(home, '.ssh', 'id_rsa'), 'SSH-PRIVATE\n'); // orchestrator:allow-secret (test fixture)
  mkdirSync(join(orchHome, 'secrets'), { recursive: true }); writeFileSync(join(orchHome, 'secrets', 'github-token'), 'TOKEN-SECRET\n'); // orchestrator:allow-secret (test fixture)
  const bin = join(home, 'codex');
  writeFileSync(bin, `#!/bin/sh\ncat ${join(home, '.ssh', 'id_rsa')} 2>/dev/null; cat ${join(orchHome, 'secrets', 'github-token')} 2>/dev/null; echo ran\n`, { mode: 0o755 });
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = savedHome; rmSync(home, { recursive: true, force: true }); });
  const cfg = defaultConfig(orchHome); cfg.security.agentSandbox = 'bwrap';
  const w = sbx.wrapAgentCommand(cfg, { orchHome, provider: 'codex', writable: [], readOnly: [] }, bin, []);
  const binds = w.args.flatMap((a, i) => (a === '--ro-bind' || a === '--bind' ? [w.args[i + 1]] : []));
  assert.ok(!binds.includes(home) && !binds.includes(orchHome) && !binds.includes('/home'), `no hidden root re-bound: ${binds.join(' ')}`);
  assert.ok(binds.includes(bin), 'only the binary file is bound');
  const out = execFileSync(w.cmd, w.args, { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: home } });
  assert.match(out, /ran/, 'the standalone binary still runs');
  assert.doesNotMatch(out, /SSH-PRIVATE|TOKEN-SECRET/, 'secrets stay hidden');
});

test('PR #63 review B2: the reconcile revert path forces a re-sync (updated_at bumped) and audits', async () => {
  const h = makeHarness(demoBehaviour());
  try {
    const p0 = newDemoProject(h, DEMO_GOAL);
    const wf = h.sup.workflow; const proj = wf.store.project(p0.id)!;
    await drive(h, (x) => !!wf.store.workItemByKey(p0.id, 'W-003'), p0.id, { maxTicks: 200 });
    const w3 = wf.store.workItemByKey(p0.id, 'W-003')!;
    let synced = 0;
    (h.ctx as any).github = () => ({ reconcileExternal: async () => [{ key: 'W-003', change: 'closed' }], syncAll: async () => { synced++; } });
    const before = wf.store.workItemByKey(p0.id, 'W-003')!.updated_at;
    (wf as any).lastSync.delete(p0.id);
    (wf as any).syncGitHub(proj);
    await wf.drainJobs();
    assert.ok(wf.store.workItemByKey(p0.id, 'W-003')!.updated_at > before, 'updated_at bumped so syncAll rewrites the issue');
    assert.equal(synced, 1);
    assert.ok(h.ctx.db.get("SELECT 1 FROM audit_log WHERE action='workitem.external_change_reverted' AND target=?", w3.key));
  } finally { await h.sup.workflow.drainJobs(); h.cleanup(); }
});
