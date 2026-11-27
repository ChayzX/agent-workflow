// GitHub as the source of truth for requirements and work tracking.
// Idempotency: every orchestrator-created issue carries a hidden marker; the local mapping table
// is a cache. After a crash between "create" and "record", the marker search finds the issue,
// so retries never create duplicates. Same for PRs (by head branch) and releases (by tag).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '../core/db.js';
import { json } from '../core/db.js';
import type { Clock } from '../core/clock.js';
import type { EventLog } from '../core/events.js';
import type { WorkItemRow, WorkItemStatus } from '../core/types.js';
import type { RequirementRow, Store } from '../engine/store.js';
import { GitHubClient, GitHubError } from './client.js';

export const STATUS_OPTIONS = ['Backlog', 'Ready', 'In progress', 'In review', 'Remediation', 'Merging', 'Done', 'Blocked', 'Cancelled'] as const;
export function statusOption(s: WorkItemStatus): (typeof STATUS_OPTIONS)[number] {
  switch (s) {
    case 'backlog': return 'Backlog';
    case 'ready': return 'Ready';
    case 'implementing': return 'In progress';
    case 'gating': case 'in_review': return 'In review';
    case 'remediation': return 'Remediation';
    case 'merge_ready': case 'merging': return 'Merging';
    case 'merged': case 'done': return 'Done';
    case 'blocked': return 'Blocked';
    case 'cancelled': return 'Cancelled';
  }
}

export function marker(projectId: string, kind: string, key: string): string {
  return `<!-- orchestrator:v1 project=${projectId} kind=${kind} key=${key} -->`;
}
const MARKER_RE = /<!-- orchestrator:v1 project=(\S+) kind=(\S+) key=(\S+) -->/;

interface Mapped { number: number | null; node_id: string | null; db_id: number | null; url: string | null; extra: string; synced_at: number }
interface IssueLite { id: number; node_id: string; number: number; state: string; state_reason?: string | null; title: string; body: string | null; html_url: string; pull_request?: unknown; labels: Array<{ name: string }> }

export interface ProjectBoard { projectId: string; statusFieldId: string; statusOptions: Record<string, string>; priorityFieldId: string | null; priorityOptions: Record<string, string> }

export class GitHubSync {
  private issueCache: Map<string, IssueLite> | null = null;
  constructor(
    readonly client: GitHubClient, private db: Db, private clock: Clock, private events: EventLog,
    readonly projectId: string, readonly owner: string, readonly repo: string,
    private opts: { allowCreateProject: boolean; projectTitle: string; mergeMethod: 'merge' | 'squash' | 'rebase' },
  ) {}

  private get r(): string { return `/repos/${this.owner}/${this.repo}`; }

  mapped(kind: string, key: string): Mapped | undefined {
    return this.db.get<Mapped>('SELECT number, node_id, db_id, url, extra, synced_at FROM github_objects WHERE project_id=? AND kind=? AND key=?', this.projectId, kind, key);
  }
  private record(kind: string, key: string, o: { number?: number | null; node_id?: string | null; db_id?: number | null; url?: string | null; extra?: unknown }): void {
    this.db.run(
      `INSERT INTO github_objects(project_id, kind, key, number, node_id, db_id, url, extra, synced_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project_id, kind, key) DO UPDATE SET number=COALESCE(excluded.number, number), node_id=COALESCE(excluded.node_id, node_id),
         db_id=COALESCE(excluded.db_id, db_id), url=COALESCE(excluded.url, url), extra=excluded.extra, synced_at=excluded.synced_at`,
      this.projectId, kind, key, o.number ?? null, o.node_id ?? null, o.db_id ?? null, o.url ?? null, JSON.stringify(o.extra ?? {}), this.clock.now(),
    );
  }

  /** All orchestrator-managed issues of this project, keyed by kind:key (from markers). */
  private async markedIssues(refresh = false): Promise<Map<string, IssueLite>> {
    if (this.issueCache && !refresh) return this.issueCache;
    const all = await this.client.paginate<IssueLite>(`${this.r}/issues?state=all&labels=orchestrator`, 5000);
    const m = new Map<string, IssueLite>();
    for (const i of all) {
      if (i.pull_request) continue;
      const mk = MARKER_RE.exec(i.body ?? '');
      if (mk && mk[1] === this.projectId) m.set(`${mk[2]}:${mk[3]}`, i);
    }
    this.issueCache = m;
    return m;
  }

  async ensureLabels(): Promise<void> {
    const want: Array<[string, string, string]> = [
      ['orchestrator', '5319e7', 'Managed by Agent Workflow Orchestrator'], ['kind:requirement', '0e8a16', 'Product requirement'],
      ['kind:work-item', '1d76db', 'Implementation work item'], ['type:defect', 'd73a4a', 'Defect found by review, gates or audit'],
      ['type:feature', 'a2eeef', 'Feature work'], ['type:docs', '0075ca', 'Documentation'], ['type:test', 'bfd4f2', 'Tests'], ['type:chore', 'cfd3d7', 'Chore'],
      ['priority:P0', 'b60205', 'Highest priority'], ['priority:P1', 'd93f0b', 'High priority'], ['priority:P2', 'fbca04', 'Normal priority'], ['priority:P3', 'c5def5', 'Low priority'],
      ['blocked', '000000', 'Blocked'], ['adr', '6f42c1', 'Architecture decision record'],
    ];
    const existing = new Set((await this.client.paginate<{ name: string }>(`${this.r}/labels`)).map((l) => l.name.toLowerCase()));
    for (const [name, color, description] of want) {
      if (existing.has(name.toLowerCase())) continue;
      await this.client.request('POST', `${this.r}/labels`, { name, color, description }).catch((e: GitHubError) => { if (e.status !== 422) throw e; });
    }
  }

  async ensureMilestone(title: string): Promise<number> {
    const m = this.mapped('milestone', title);
    if (m?.number) return m.number;
    const all = await this.client.paginate<{ number: number; title: string }>(`${this.r}/milestones?state=all`);
    const found = all.find((x) => x.title === title);
    const ms = found ?? (await this.client.request<{ number: number }>('POST', `${this.r}/milestones`, { title }));
    this.record('milestone', title, { number: ms.number });
    return ms.number;
  }

  /** Create or update an issue identified by (kind, key). Never duplicates. */
  async ensureIssue(kind: string, key: string, spec: { title: string; body: string; labels: string[]; milestone?: number | null; state?: 'open' | 'closed'; stateReason?: 'completed' | 'not_planned' }): Promise<IssueLite> {
    const body = `${spec.body.trim()}\n\n${marker(this.projectId, kind, key)}\n_Managed by Agent Workflow Orchestrator._`;
    const labels = ['orchestrator', ...spec.labels];
    const m = this.mapped(kind, key);
    let issue: IssueLite | undefined;
    if (m?.number) issue = await this.client.request<IssueLite>('GET', `${this.r}/issues/${m.number}`, undefined, { allow404: true }) ?? undefined;
    if (!issue) issue = (await this.markedIssues()).get(`${kind}:${key}`);
    if (!issue) {
      issue = await this.client.request<IssueLite>('POST', `${this.r}/issues`, { title: spec.title, body, labels, milestone: spec.milestone ?? undefined });
      this.issueCache?.set(`${kind}:${key}`, issue);
      this.events.emit('github.issue.created', `#${issue.number} ${spec.title}`, { projectId: this.projectId });
    } else {
      const curLabels = issue.labels.map((l) => l.name).sort().join(',');
      const needs = issue.title !== spec.title || (issue.body ?? '') !== body || curLabels !== [...labels].sort().join(',') || (spec.state && issue.state !== spec.state);
      if (needs) {
        issue = await this.client.request<IssueLite>('PATCH', `${this.r}/issues/${issue.number}`, {
          title: spec.title, body, labels, ...(spec.state ? { state: spec.state, state_reason: spec.state === 'closed' ? spec.stateReason ?? 'completed' : undefined } : {}),
        });
      }
    }
    this.record(kind, key, { number: issue.number, node_id: issue.node_id, db_id: issue.id, url: issue.html_url });
    return issue;
  }

  async ensureSubIssue(parentNumber: number, childDbId: number): Promise<void> {
    const subs = await this.client.paginate<{ id: number }>(`${this.r}/issues/${parentNumber}/sub_issues`).catch(() => []);
    if (subs.some((s) => s.id === childDbId)) return;
    await this.client.request('POST', `${this.r}/issues/${parentNumber}/sub_issues`, { sub_issue_id: childDbId }).catch((e: GitHubError) => {
      if (e.status !== 422) this.events.emit('github.warn', `sub-issue link failed: ${e.message}`, { projectId: this.projectId, level: 'warn' });
    });
  }

  async ensureDependency(blockedNumber: number, blockingDbId: number): Promise<void> {
    const existing = await this.client.paginate<{ id: number }>(`${this.r}/issues/${blockedNumber}/dependencies/blocked_by`).catch(() => null);
    if (existing?.some((x) => x.id === blockingDbId)) return;
    await this.client.request('POST', `${this.r}/issues/${blockedNumber}/dependencies/blocked_by`, { issue_id: blockingDbId }).catch((e: GitHubError) => {
      if (e.status !== 422) this.events.emit('github.warn', `dependency link failed (#${blockedNumber}): ${e.message}`, { projectId: this.projectId, level: 'warn' });
    });
  }

  /** Find or create the GitHub Project (v2) and its fields; field ids are discovered dynamically. */
  async ensureBoard(): Promise<ProjectBoard | null> {
    const cached = this.mapped('board', 'main');
    if (cached?.node_id) return json<ProjectBoard>(cached.extra, null as unknown as ProjectBoard);
    const owner = await this.client.graphql<{ repositoryOwner: { __typename: string; id: string; projectsV2: { nodes: Array<{ id: string; title: string }> } } | null }>(
      `query($login:String!){ repositoryOwner(login:$login){ __typename id ... on User { projectsV2(first:50){ nodes{ id title } } } ... on Organization { projectsV2(first:50){ nodes{ id title } } } } }`,
      { login: this.owner },
    );
    if (!owner.repositoryOwner) return null;
    let project = owner.repositoryOwner.projectsV2.nodes.find((p) => p.title === this.opts.projectTitle);
    if (!project) {
      if (!this.opts.allowCreateProject) return null;
      const repoNode = await this.client.request<{ node_id: string }>('GET', this.r);
      const r = await this.client.graphql<{ createProjectV2: { projectV2: { id: string; title: string } } }>(
        `mutation($o:ID!,$t:String!,$r:ID){ createProjectV2(input:{ownerId:$o,title:$t,repositoryId:$r}){ projectV2{ id title } } }`,
        { o: owner.repositoryOwner.id, t: this.opts.projectTitle, r: repoNode.node_id },
      );
      project = r.createProjectV2.projectV2;
      this.events.emit('github.project.created', `GitHub Project "${project.title}"`, { projectId: this.projectId });
    }
    const fieldsQ = `query($p:ID!){ node(id:$p){ ... on ProjectV2 { fields(first:50){ nodes{ ... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { id name options{ id name } } } } } } }`;
    type F = { id: string; name: string; options?: Array<{ id: string; name: string }> };
    const getFields = async () => (await this.client.graphql<{ node: { fields: { nodes: F[] } } }>(fieldsQ, { p: project!.id })).node.fields.nodes;
    let fields = await getFields();
    const ensureSelect = async (name: string, options: readonly string[]) => {
      if (fields.some((f) => f.name === name)) return;
      await this.client.graphql(
        `mutation($p:ID!,$n:String!,$o:[ProjectV2SingleSelectFieldOptionInput!]!){ createProjectV2Field(input:{projectId:$p,dataType:SINGLE_SELECT,name:$n,singleSelectOptions:$o}){ projectV2Field{ ... on ProjectV2SingleSelectField { id } } } }`,
        { p: project!.id, n: name, o: options.map((o) => ({ name: o, color: o === 'Blocked' ? 'RED' : o === 'Done' ? 'GREEN' : 'GRAY', description: '' })) },
      );
      fields = await getFields();
    };
    await ensureSelect('Orchestrator Status', STATUS_OPTIONS);
    await ensureSelect('Orchestrator Priority', ['P0', 'P1', 'P2', 'P3']);
    const st = fields.find((f) => f.name === 'Orchestrator Status')!;
    const pr = fields.find((f) => f.name === 'Orchestrator Priority');
    const board: ProjectBoard = {
      projectId: project.id, statusFieldId: st.id, statusOptions: Object.fromEntries((st.options ?? []).map((o) => [o.name, o.id])),
      priorityFieldId: pr?.id ?? null, priorityOptions: Object.fromEntries((pr?.options ?? []).map((o) => [o.name, o.id])),
    };
    this.record('board', 'main', { node_id: project.id, extra: board });
    return board;
  }

  async setBoardFields(board: ProjectBoard, kind: string, key: string, contentNodeId: string, status: string, priority: number): Promise<void> {
    let item = this.mapped('board-item', `${kind}:${key}`);
    if (!item?.node_id) {
      const r = await this.client.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
        `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }`, { p: board.projectId, c: contentNodeId },
      );
      this.record('board-item', `${kind}:${key}`, { node_id: r.addProjectV2ItemById.item.id, extra: {} });
      item = this.mapped('board-item', `${kind}:${key}`)!;
    }
    const prev = json<{ status?: string; priority?: number }>(item.extra, {});
    const set = (fieldId: string, optionId: string) => this.client.graphql(
      `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }`,
      { p: board.projectId, i: item!.node_id, f: fieldId, o: optionId },
    );
    if (prev.status !== status && board.statusOptions[status]) await set(board.statusFieldId, board.statusOptions[status]!);
    const pkey = `P${Math.min(3, Math.max(0, priority))}`;
    if (board.priorityFieldId && prev.priority !== priority && board.priorityOptions[pkey]) await set(board.priorityFieldId, board.priorityOptions[pkey]!);
    this.record('board-item', `${kind}:${key}`, { node_id: item.node_id, extra: { status, priority } });
  }

  private reqBody(r: RequirementRow): string {
    return `**${r.kind} requirement${r.mandatory ? ' (mandatory)' : ''}**\n\n${r.description}\n\n### Acceptance criteria\n${json<string[]>(r.acceptance, []).map((a) => `- [${r.status === 'verified' ? 'x' : ' '}] ${a}`).join('\n')}\n\nStatus: \`${r.status}\`${r.blocker ? `\n\n**Blocker:** ${r.blocker}` : ''}`;
  }
  private wiBody(w: WorkItemRow): string {
    const done = ['merged', 'done'].includes(w.status);
    return `${w.description}\n\n### Acceptance criteria\n${json<string[]>(w.acceptance, []).map((a) => `- [${done ? 'x' : ' '}] ${a}`).join('\n')}\n\n` +
      `Requirements: ${json<string[]>(w.requirement_keys, []).join(', ') || '—'} · Role: \`${w.role}\` · Complexity: \`${w.complexity}\` · Status: \`${w.status}\`` +
      `${w.branch ? ` · Branch: \`${w.branch}\`` : ''}${w.merged_commit ? ` · Merged: \`${w.merged_commit.slice(0, 10)}\`` : ''}${w.status_reason ? `\n\n> ${w.status_reason}` : ''}`;
  }

  /** Push local state to GitHub for everything changed since the last sync. Idempotent. */
  async syncAll(store: Store): Promise<{ issues: number }> {
    let n = 0;
    await this.ensureLabels();
    const board = await this.ensureBoard().catch((e) => { this.events.emit('github.warn', `project board unavailable: ${(e as Error).message}`, { projectId: this.projectId, level: 'warn' }); return null; });
    for (const r of store.requirements(this.projectId)) {
      const m = this.mapped('requirement', r.key);
      if (m && m.synced_at >= r.updated_at) continue;
      const issue = await this.ensureIssue('requirement', r.key, {
        title: `${r.key}: ${r.title}`, body: this.reqBody(r), labels: ['kind:requirement', `priority:P${Math.min(3, r.priority)}`, ...(r.status === 'blocked' ? ['blocked'] : [])],
        state: r.status === 'verified' ? 'closed' : 'open',
      });
      this.db.run('UPDATE requirements SET github_issue_number=? WHERE id=?', issue.number, r.id);
      n++;
    }
    const items = store.workItems(this.projectId);
    for (const w of items) {
      const m = this.mapped('work-item', w.key);
      if (m && m.synced_at >= w.updated_at) continue;
      const milestone = w.milestone ? await this.ensureMilestone(w.milestone).catch(() => null) : null;
      const issue = await this.ensureIssue('work-item', w.key, {
        title: `${w.key}: ${w.title}`, body: this.wiBody(w), milestone,
        labels: ['kind:work-item', `type:${w.type}`, `priority:P${Math.min(3, w.priority)}`, ...(w.status === 'blocked' ? ['blocked'] : [])],
        state: ['merged', 'done', 'cancelled'].includes(w.status) ? 'closed' : 'open', stateReason: w.status === 'cancelled' ? 'not_planned' : 'completed',
      });
      this.db.run('UPDATE work_items SET github_issue_number=? WHERE id=?', issue.number, w.id);
      for (const rk of json<string[]>(w.requirement_keys, [])) {
        const parent = this.mapped('requirement', rk);
        if (parent?.number) await this.ensureSubIssue(parent.number, issue.id);
      }
      for (const dk of json<string[]>(w.depends_on, [])) {
        const dep = this.mapped('work-item', dk);
        if (dep?.db_id) await this.ensureDependency(issue.number, dep.db_id);
      }
      if (board) await this.setBoardFields(board, 'work-item', w.key, issue.node_id, statusOption(w.status), w.priority).catch((e) => this.events.emit('github.warn', `board update failed: ${(e as Error).message}`, { projectId: this.projectId, level: 'warn' }));
      n++;
    }
    return { issues: n };
  }

  /** Pull external changes: issues closed/reopened by humans. */
  async reconcileExternal(store: Store): Promise<Array<{ key: string; change: 'closed_not_planned' | 'closed' | 'reopened' }>> {
    const marked = await this.markedIssues(true);
    const changes: Array<{ key: string; change: 'closed_not_planned' | 'closed' | 'reopened' }> = [];
    for (const w of store.workItems(this.projectId)) {
      const i = marked.get(`work-item:${w.key}`);
      if (!i) continue;
      const localClosed = ['merged', 'done', 'cancelled'].includes(w.status);
      if (i.state === 'closed' && !localClosed) changes.push({ key: w.key, change: i.state_reason === 'not_planned' ? 'closed_not_planned' : 'closed' });
      if (i.state === 'open' && localClosed && w.status !== 'cancelled') changes.push({ key: w.key, change: 'reopened' });
    }
    return changes;
  }

  async pullState(n: number): Promise<{ state: 'open' | 'closed'; merged: boolean; mergeSha: string | null }> {
    const pr = await this.client.request<{ state: 'open' | 'closed'; merged: boolean; merge_commit_sha: string | null }>('GET', `${this.r}/pulls/${n}`);
    return { state: pr.state, merged: !!pr.merged, mergeSha: pr.merge_commit_sha };
  }

  forgetPullRequest(key: string): void {
    this.db.run("DELETE FROM github_objects WHERE project_id=? AND kind='pr' AND key=?", this.projectId, key);
  }

  async ensurePullRequest(w: WorkItemRow, base: string): Promise<{ number: number; url: string }> {
    const m = this.mapped('pr', w.key);
    if (m?.number) {
      const st = await this.pullState(m.number).catch(() => null);
      if (st && st.state === 'open') return { number: m.number, url: m.url ?? '' };
      this.forgetPullRequest(w.key); // closed or unknown: never reuse
    }
    // Only an OPEN PR for this head branch may be reused (closed PRs are never revived).
    const existing = await this.client.request<Array<{ number: number; html_url: string }>>('GET', `${this.r}/pulls?state=open&head=${encodeURIComponent(`${this.owner}:${w.branch}`)}`);
    let pr = existing?.[0];
    if (!pr) {
      pr = await this.client.request('POST', `${this.r}/pulls`, {
        title: `${w.key}: ${w.title}`, head: w.branch, base,
        body: `Implements ${w.github_issue_number ? `#${w.github_issue_number}` : w.key}.\n\n### Acceptance criteria\n${json<string[]>(w.acceptance, []).map((a) => `- ${a}`).join('\n')}\n\n${marker(this.projectId, 'pr', w.key)}\n_Opened by Agent Workflow Orchestrator after passing local quality gates and independent review._`,
      });
    }
    this.record('pr', w.key, { number: pr!.number, url: pr!.html_url });
    return { number: pr!.number, url: pr!.html_url };
  }

  /** Combined CI state for an exact commit (check runs + commit statuses). */
  async checks(sha: string): Promise<'pending' | 'success' | 'failure' | 'none'> {
    const runs = await this.client.request<{ total_count: number; check_runs: Array<{ status: string; conclusion: string | null; name: string }> }>('GET', `${this.r}/commits/${sha}/check-runs?per_page=100`);
    const status = await this.client.request<{ state: string; total_count: number }>('GET', `${this.r}/commits/${sha}/status`);
    const cr = runs?.check_runs ?? [];
    if (!cr.length && !(status?.total_count)) return 'none';
    if (cr.some((r) => r.status !== 'completed') || status?.state === 'pending' && status.total_count > 0) return 'pending';
    const bad = cr.some((r) => !['success', 'neutral', 'skipped'].includes(r.conclusion ?? '')) || status?.state === 'failure' || status?.state === 'error';
    return bad ? 'failure' : 'success';
  }

  /** Merge only the exact reviewed+tested commit (GitHub rejects the merge if head moved). */
  async merge(prNumber: number, sha: string): Promise<{ merged: true; sha: string } | { merged: false; reason: string; needsHuman: boolean }> {
    try {
      const r = await this.client.request<{ merged: boolean; sha: string; message: string }>('PUT', `${this.r}/pulls/${prNumber}/merge`, { sha, merge_method: this.opts.mergeMethod });
      return r.merged ? { merged: true, sha: r.sha } : { merged: false, reason: r.message, needsHuman: false };
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 405 || e.status === 403)) return { merged: false, reason: e.body.slice(0, 500), needsHuman: /review|approv|protect/i.test(e.body) };
      if (e instanceof GitHubError && e.status === 409) return { merged: false, reason: 'head commit changed (SHA mismatch)', needsHuman: false };
      throw e;
    }
  }

  async comment(issueNumber: number, body: string): Promise<void> {
    await this.client.request('POST', `${this.r}/issues/${issueNumber}/comments`, { body: `${body}\n\n_Agent Workflow Orchestrator_` });
  }

  async publishRelease(tag: string, commit: string, name: string, notes: string, zipPath: string, checksumPath: string): Promise<string> {
    const existing = await this.client.request<{ id: number; html_url: string; upload_url: string; assets: Array<{ name: string }> }>('GET', `${this.r}/releases/tags/${encodeURIComponent(tag)}`, undefined, { allow404: true });
    const rel = existing ?? (await this.client.request('POST', `${this.r}/releases`, { tag_name: tag, target_commitish: commit, name, body: notes, draft: false, prerelease: false }));
    for (const p of [zipPath, checksumPath]) {
      const n = basename(p);
      if (rel.assets?.some((a: { name: string }) => a.name === n)) continue;
      await this.client.upload(`/repos/${this.owner}/${this.repo}/releases/${rel.id}/assets?name=${encodeURIComponent(n)}`, readFileSync(p), n.endsWith('.zip') ? 'application/zip' : 'text/plain');
    }
    return rel.html_url;
  }
}
