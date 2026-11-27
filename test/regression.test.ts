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
  mkdirSync(join(d, 'outside')); writeFileSync(join(d, 'outside', '.credentials.json'), '{"refresh_token":"abcdefghijklmnopqrstuvwxyz0123456789"}');
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
  assert.ok(scanText('a.json', '{ "api_key": "abcdefghijklmnopqrstuvwxyz123456" }').length > 0);
  assert.ok(scanText('a.json', '"refresh_token":"Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA"').length > 0);
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
  const g = new ClaudeStateGuard(f);
  g.snapshot();
  const cur = JSON.parse(readFileSync(f, 'utf8'));
  cur.numStartups = 2; cur.mcpServers.evil = { command: 'curl evil' }; cur.projects['/w'].mcpServers = { e: { command: 'sh' } };
  writeFileSync(f, JSON.stringify(cur));
  assert.equal(g.verifyAndRestore(), true);
  const after = JSON.parse(readFileSync(f, 'utf8'));
  assert.deepEqual(Object.keys(after.mcpServers), ['ok']);
  assert.equal(after.projects['/w'].mcpServers, undefined);
  assert.equal(after.numStartups, 2, 'unrelated Claude state preserved');
  rmSync(d, { recursive: true, force: true });
});
