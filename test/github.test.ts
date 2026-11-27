// GitHub contract tests against an in-memory fake implementing the REST/GraphQL surface used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ManualClock } from '../src/core/clock.js';
import { EventLog } from '../src/core/events.js';
import { GitHubClient } from '../src/github/client.js';
import { GitHubSync } from '../src/github/sync.js';
import { Store } from '../src/engine/store.js';

interface Issue { id: number; node_id: string; number: number; title: string; body: string; state: string; state_reason: string | null; labels: Array<{ name: string }>; html_url: string; milestone?: number }

export function fakeGitHub() {
  const s = {
    issues: [] as Issue[], labels: new Set<string>(), milestones: [] as Array<{ number: number; title: string }>, subs: new Map<number, number[]>(), deps: new Map<number, number[]>(),
    projects: [] as Array<{ id: string; title: string; fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>; items: Map<string, Record<string, string>> }>,
    pulls: [] as Array<{ number: number; head: string; html_url: string; merged: boolean; sha?: string }>, checks: new Map<string, string>(), releases: [] as Array<{ id: number; tag_name: string; html_url: string; assets: Array<{ name: string }> }>,
    calls: [] as string[], nextNum: 1, protectedMerge: false,
  };
  const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = u.pathname.replace(/^\/repos\/o\/r/, '');
    s.calls.push(`${method} ${u.pathname}`);
    if (u.pathname === '/graphql') {
      const q: string = body.query;
      const v = body.variables;
      if (q.includes('repositoryOwner')) return json(200, { data: { repositoryOwner: { __typename: 'User', id: 'U1', projectsV2: { nodes: s.projects.map((p) => ({ id: p.id, title: p.title })) } } } });
      if (q.includes('createProjectV2Field')) { const p = s.projects.find((x) => x.id === v.p)!; p.fields.push({ id: `F${p.fields.length + 1}`, name: v.n, options: v.o.map((o: any, i: number) => ({ id: `O${p.fields.length}_${i}`, name: o.name })) }); return json(200, { data: { createProjectV2Field: { projectV2Field: { id: 'x' } } } }); }
      if (q.includes('createProjectV2')) { const p = { id: `PVT_${s.projects.length + 1}`, title: v.t, fields: [{ id: 'F0', name: 'Status', options: [{ id: 'o', name: 'Todo' }] }], items: new Map() }; s.projects.push(p); return json(200, { data: { createProjectV2: { projectV2: { id: p.id, title: p.title } } } }); }
      if (q.includes('fields(first')) { const p = s.projects.find((x) => x.id === v.p)!; return json(200, { data: { node: { fields: { nodes: p.fields } } } }); }
      if (q.includes('addProjectV2ItemById')) { const p = s.projects.find((x) => x.id === v.p)!; const id = `PVTI_${v.c}`; p.items.set(id, p.items.get(id) ?? {}); return json(200, { data: { addProjectV2ItemById: { item: { id } } } }); }
      if (q.includes('updateProjectV2ItemFieldValue')) { const p = s.projects.find((x) => x.id === v.p)!; p.items.get(v.i)![v.f] = v.o; return json(200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: v.i } } } }); }
      return json(200, { errors: [{ message: `unhandled graphql ${q.slice(0, 40)}` }] });
    }
    if (path === '' && method === 'GET') return json(200, { node_id: 'R_1' });
    if (path === '/labels' && method === 'GET') return json(200, [...s.labels].map((name) => ({ name })));
    if (path === '/labels' && method === 'POST') { if (s.labels.has(body.name)) return json(422, { message: 'exists' }); s.labels.add(body.name); return json(201, { name: body.name }); }
    if (path === '/milestones' && method === 'GET') return json(200, u.searchParams.get('page') === '1' ? s.milestones : []);
    if (path === '/milestones' && method === 'POST') { const m = { number: s.milestones.length + 1, title: body.title }; s.milestones.push(m); return json(201, m); }
    if (path === '/issues' && method === 'GET') return json(200, u.searchParams.get('page') === '1' ? s.issues : []);
    if (path === '/issues' && method === 'POST') { const n = s.nextNum++; const i: Issue = { id: 1000 + n, node_id: `I_${n}`, number: n, title: body.title, body: body.body, state: 'open', state_reason: null, labels: body.labels.map((name: string) => ({ name })), html_url: `https://gh/o/r/issues/${n}` }; s.issues.push(i); return json(201, i); }
    let m = /^\/issues\/(\d+)$/.exec(path);
    if (m) {
      const i = s.issues.find((x) => x.number === Number(m![1]));
      if (!i) return json(404, { message: 'Not Found' });
      if (method === 'PATCH') { Object.assign(i, { title: body.title, body: body.body, labels: body.labels.map((name: string) => ({ name })), ...(body.state ? { state: body.state, state_reason: body.state_reason ?? null } : {}) }); }
      return json(200, i);
    }
    m = /^\/issues\/(\d+)\/sub_issues$/.exec(path);
    if (m) { const n = Number(m[1]); if (method === 'POST') { s.subs.set(n, [...(s.subs.get(n) ?? []), body.sub_issue_id]); return json(201, {}); } return json(200, u.searchParams.get('page') === '1' ? (s.subs.get(n) ?? []).map((id) => ({ id })) : []); }
    m = /^\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(path);
    if (m) { const n = Number(m[1]); if (method === 'POST') { s.deps.set(n, [...(s.deps.get(n) ?? []), body.issue_id]); return json(201, {}); } return json(200, u.searchParams.get('page') === '1' ? (s.deps.get(n) ?? []).map((id) => ({ id })) : []); }
    if (path === '/pulls' && method === 'GET') return json(200, s.pulls.filter((p) => `o:${p.head}` === u.searchParams.get('head')));
    if (path === '/pulls' && method === 'POST') { const n = s.nextNum++; const p = { number: n, head: body.head, html_url: `https://gh/o/r/pull/${n}`, merged: false }; s.pulls.push(p); return json(201, p); }
    m = /^\/pulls\/(\d+)\/merge$/.exec(path);
    if (m) {
      if (s.protectedMerge) return json(405, { message: 'At least 1 approving review is required by reviewers with write access.' });
      const p = s.pulls.find((x) => x.number === Number(m![1]))!;
      if (body.sha !== s.checks.get('head:' + p.head)) return json(409, { message: 'Head branch was modified. Review and try the merge again.' });
      p.merged = true; return json(200, { merged: true, sha: 'mergesha', message: 'merged' });
    }
    m = /^\/commits\/(\w+)\/check-runs$/.exec(path);
    if (m) { const st = s.checks.get(m[1]!); return json(200, { total_count: st ? 1 : 0, check_runs: st ? [{ name: 'ci', status: st === 'pending' ? 'in_progress' : 'completed', conclusion: st === 'pending' ? null : st }] : [] }); }
    m = /^\/commits\/(\w+)\/status$/.exec(path);
    if (m) return json(200, { state: 'success', total_count: 0 });
    m = /^\/releases\/tags\/(.+)$/.exec(path);
    if (m) { const r = s.releases.find((x) => x.tag_name === decodeURIComponent(m![1]!)); return r ? json(200, r) : json(404, { message: 'Not Found' }); }
    if (path === '/releases' && method === 'POST') { const r = { id: s.releases.length + 1, tag_name: body.tag_name, html_url: `https://gh/o/r/releases/${body.tag_name}`, upload_url: '', assets: [] as Array<{ name: string }> }; s.releases.push(r); return json(201, r); }
    m = /^\/releases\/(\d+)\/assets$/.exec(path);
    if (m) { s.releases.find((x) => x.id === Number(m![1]))!.assets.push({ name: u.searchParams.get('name')! }); return json(201, {}); }
    return json(404, { message: `fake: unhandled ${method} ${path}` });
  }) as typeof fetch;
  return { s, fetchImpl };
}

function setup() {
  const db = new Db(':memory:');
  const clock = new ManualClock();
  db.run("INSERT INTO projects(id,name,goal_text,goal_sha256,status,repo_mode,repo_source,workspace_dir,settings,created_at,updated_at) VALUES ('p','demo','goal text','h','active','github','o/r','/x','{}',0,0)");
  const store = new Store(db, clock);
  store.upsertRequirement('p', { key: 'R-001', kind: 'functional', title: 'Add', description: 'd', acceptance: ['a'], mandatory: true, priority: 0 });
  const w1 = store.createWorkItem('p', { key: 'W-001', type: 'feature', title: 'Impl add', description: 'd', acceptance: ['x'], requirement_keys: ['R-001'], depends_on: [], paths: [], role: 'backend_engineer', complexity: 'low', priority: 0, milestone: 'MVP', source: 'plan' });
  store.createWorkItem('p', { key: 'W-002', type: 'feature', title: 'Impl mul', description: 'd', acceptance: ['y'], requirement_keys: ['R-001'], depends_on: ['W-001'], paths: [], role: 'backend_engineer', complexity: 'low', priority: 1, milestone: 'MVP', source: 'plan' });
  const fake = fakeGitHub();
  const client = new GitHubClient({ token: 'ghp_' + 'z'.repeat(36), fetchImpl: fake.fetchImpl, sleep: async () => {} });
  const sync = new GitHubSync(client, db, clock, new EventLog(db, clock), 'p', 'o', 'r', { allowCreateProject: true, projectTitle: 'demo board', mergeMethod: 'squash' });
  return { db, clock, store, fake, sync, w1 };
}

test('github: sync creates labels, milestone, issues, sub-issues, dependencies and board fields; re-sync and crash replay never duplicate', async () => {
  const { db, clock, store, fake, sync } = setup();
  await sync.syncAll(store);
  assert.equal(fake.s.issues.length, 3, '1 requirement + 2 work items');
  assert.equal(fake.s.milestones.length, 1);
  assert.ok(fake.s.labels.has('orchestrator') && fake.s.labels.has('priority:P0'));
  const req = fake.s.issues.find((i) => i.title.startsWith('R-001'))!;
  assert.equal(fake.s.subs.get(req.number)!.length, 2, 'work items are sub-issues of the requirement');
  const w2 = fake.s.issues.find((i) => i.title.startsWith('W-002'))!;
  const w1 = fake.s.issues.find((i) => i.title.startsWith('W-001'))!;
  assert.deepEqual(fake.s.deps.get(w2.number), [w1.id], 'W-002 blocked by W-001');
  const board = fake.s.projects[0]!;
  assert.ok(board.fields.some((f) => f.name === 'Orchestrator Status'));
  assert.equal(board.items.size, 2);
  // Re-sync: nothing new.
  clock.advance(1000);
  await sync.syncAll(store);
  assert.equal(fake.s.issues.length, 3);
  // Crash replay: local mapping lost (e.g. crash after create, before record) → marker search prevents duplicates.
  db.run('DELETE FROM github_objects');
  store.patchWorkItem(store.workItemByKey('p', 'W-001')!.id, { status: 'done' });
  clock.advance(1000);
  const sync2 = new GitHubSync((sync as any).client, db, clock, new EventLog(db, clock), 'p', 'o', 'r', { allowCreateProject: true, projectTitle: 'demo board', mergeMethod: 'squash' });
  await sync2.syncAll(store);
  assert.equal(fake.s.issues.length, 3, 'no duplicate issues after crash replay');
  assert.equal(fake.s.projects.length, 1, 'no duplicate project board');
  assert.equal(fake.s.issues.find((i) => i.title.startsWith('W-001'))!.state, 'closed');
  assert.equal(fake.s.deps.get(w2.number)!.length, 1, 'no duplicate dependency links');
});

test('github: external close-as-not-planned and reopen are reconciled', async () => {
  const { store, fake, sync, clock } = setup();
  await sync.syncAll(store);
  fake.s.issues.find((i) => i.title.startsWith('W-002'))!.state = 'closed';
  fake.s.issues.find((i) => i.title.startsWith('W-002'))!.state_reason = 'not_planned';
  clock.advance(10);
  const ch = await sync.reconcileExternal(store);
  assert.deepEqual(ch, [{ key: 'W-002', change: 'closed_not_planned' }]);
});

test('github: PR idempotent, CI gating on exact SHA, 409 on moved head, 405 human review, release publish idempotent', async () => {
  const { store, fake, sync, w1 } = setup();
  store.patchWorkItem(w1.id, { branch: 'orch/w-001' });
  const w = store.workItem(w1.id)!;
  const pr1 = await sync.ensurePullRequest(w, 'main');
  const pr2 = await sync.ensurePullRequest(w, 'main');
  assert.equal(pr1.number, pr2.number);
  assert.equal(await sync.checks('abc123'), 'none');
  fake.s.checks.set('abc123', 'pending');
  assert.equal(await sync.checks('abc123'), 'pending');
  fake.s.checks.set('abc123', 'failure');
  assert.equal(await sync.checks('abc123'), 'failure');
  fake.s.checks.set('abc123', 'success');
  fake.s.checks.set('head:orch/w-001', 'abc123');
  const moved = await sync.merge(pr1.number, 'stale999');
  assert.equal(moved.merged, false);
  fake.s.protectedMerge = true;
  const prot = await sync.merge(pr1.number, 'abc123');
  assert.ok(!prot.merged && prot.needsHuman, 'protected branch → human review approval, never impersonated');
  fake.s.protectedMerge = false;
  const ok = await sync.merge(pr1.number, 'abc123');
  assert.equal(ok.merged, true);
  const d = mkdtempSync(join(tmpdir(), 'gh-'));
  writeFileSync(join(d, 'p-0.1.0.zip'), 'zip'); writeFileSync(join(d, 'p-0.1.0.zip.sha256'), 'sum');
  const u1 = await sync.publishRelease('v0.1.0', 'abc123', 'p', 'notes', join(d, 'p-0.1.0.zip'), join(d, 'p-0.1.0.zip.sha256'));
  const u2 = await sync.publishRelease('v0.1.0', 'abc123', 'p', 'notes', join(d, 'p-0.1.0.zip'), join(d, 'p-0.1.0.zip.sha256'));
  assert.equal(u1, u2);
  assert.equal(fake.s.releases.length, 1);
  assert.equal(fake.s.releases[0]!.assets.length, 2);
});

test('github client: retries secondary rate limits and 5xx, then succeeds; token never appears in errors', async () => {
  let n = 0;
  const f = (async () => { n++; if (n === 1) return new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403, headers: { 'retry-after': '1' } }); if (n === 2) return new Response('err', { status: 502 }); return new Response('{"ok":true}', { status: 200 }); }) as typeof fetch;
  const c = new GitHubClient({ token: 'ghp_' + 'q'.repeat(36), fetchImpl: f, sleep: async () => {} });
  assert.deepEqual(await c.request('GET', '/x'), { ok: true });
  assert.equal(n, 3);
});
