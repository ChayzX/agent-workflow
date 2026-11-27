// Typed accessors for project-level records (requirements, work items, agents, decisions,
// findings, checkpoints). Keeps SQL out of the lifecycle logic.
import type { Db } from '../core/db.js';
import { json } from '../core/db.js';
import type { Clock } from '../core/clock.js';
import { newId, sha256 } from '../core/ids.js';
import type { ProjectRow, ProjectSettings, ProjectStatus, Severity, WorkItemRow, WorkItemStatus } from '../core/types.js';

export interface RequirementRow {
  id: string; project_id: string; key: string; kind: string; title: string; description: string; acceptance: string;
  mandatory: number; priority: number; status: 'open' | 'implemented' | 'verified' | 'blocked'; evidence: string; blocker: string | null;
  github_issue_number: number | null; created_at: number; updated_at: number;
}
export interface AgentRow {
  id: string; project_id: string; role: string; name: string; status: 'idle' | 'active' | 'waiting' | 'retired'; responsibility: string;
  current_task_id: string | null; last_provider: string | null; activations: number; created_at: number; updated_at: number;
}
export interface FindingRow {
  id: string; project_id: string; work_item_id: string | null; task_id: string | null; reviewer_agent_id: string | null; reviewer_provider: string | null;
  commit_sha: string | null; severity: Severity; category: string; title: string; locations: string; evidence: string; explanation: string;
  remediation: string; verification: string; status: 'open' | 'fixed_claimed' | 'verified' | 'rejected' | 'accepted_risk'; resolution_evidence: string | null;
  defect_work_item_id: string | null; source: string; fingerprint: string; created_at: number; updated_at: number;
}
export interface DecisionRow {
  id: string; project_id: string; key: string; title: string; problem: string; alternatives: string; proposal: string | null;
  status: 'proposing' | 'evaluating' | 'rebutting' | 'final_review' | 'deciding' | 'decided' | 'blocked'; round: number; max_rounds: number;
  proposer_agent_id: string | null; owner_agent_id: string | null; outcome: string | null; rationale: string | null; consequences: string | null;
  security_resolutions: string; adr_path: string | null; created_at: number; updated_at: number;
}
export interface CheckpointRow { id: string; project_id: string; work_item_id: string | null; task_id: string | null; kind: string; summary: string; data: string; created_at: number }

export class Store {
  constructor(private db: Db, private clock: Clock) {}

  // ---- projects
  project(id: string): ProjectRow | undefined { return this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id); }
  projects(): ProjectRow[] { return this.db.all<ProjectRow>('SELECT * FROM projects ORDER BY created_at'); }
  settings(p: ProjectRow): ProjectSettings {
    return { gates: [], verify_commands: [], auto_merge: true, integration_audit_every: 5, ...json<Partial<ProjectSettings>>(p.settings, {}) };
  }
  setProjectStatus(id: string, status: ProjectStatus, reason: string | null = null): void {
    this.db.run('UPDATE projects SET status=?, status_reason=?, updated_at=? WHERE id=?', status, reason, this.clock.now(), id);
  }
  updateSettings(id: string, patch: Partial<ProjectSettings>): void {
    const p = this.project(id)!;
    this.db.run('UPDATE projects SET settings=?, updated_at=? WHERE id=?', JSON.stringify({ ...this.settings(p), ...patch }), this.clock.now(), id);
  }

  // ---- requirements
  requirements(projectId: string): RequirementRow[] { return this.db.all<RequirementRow>('SELECT * FROM requirements WHERE project_id=? ORDER BY key', projectId); }
  requirement(projectId: string, key: string): RequirementRow | undefined { return this.db.get<RequirementRow>('SELECT * FROM requirements WHERE project_id=? AND key=?', projectId, key); }
  upsertRequirement(projectId: string, r: { key: string; kind: string; title: string; description: string; acceptance: string[]; mandatory: boolean; priority: number }): void {
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO requirements(id, project_id, key, kind, title, description, acceptance, mandatory, priority, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id, key) DO NOTHING`,
      newId('req'), projectId, r.key, r.kind, r.title, r.description, JSON.stringify(r.acceptance), r.mandatory ? 1 : 0, r.priority, now, now,
    );
  }
  setRequirementStatus(projectId: string, key: string, status: RequirementRow['status'], evidence?: unknown[], blocker?: string | null): void {
    const r = this.requirement(projectId, key);
    if (!r) return;
    const ev = evidence ? JSON.stringify([...json<unknown[]>(r.evidence, []), ...evidence].slice(-30)) : r.evidence;
    this.db.run('UPDATE requirements SET status=?, evidence=?, blocker=?, updated_at=? WHERE id=?', status, ev, blocker === undefined ? r.blocker : blocker, this.clock.now(), r.id);
  }

  // ---- work items
  workItems(projectId: string, statuses?: WorkItemStatus[]): WorkItemRow[] {
    if (!statuses) return this.db.all<WorkItemRow>('SELECT * FROM work_items WHERE project_id=? ORDER BY priority, key', projectId);
    return this.db.all<WorkItemRow>(`SELECT * FROM work_items WHERE project_id=? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY priority, key`, projectId, ...statuses);
  }
  workItem(id: string): WorkItemRow | undefined { return this.db.get<WorkItemRow>('SELECT * FROM work_items WHERE id=?', id); }
  workItemByKey(projectId: string, key: string): WorkItemRow | undefined { return this.db.get<WorkItemRow>('SELECT * FROM work_items WHERE project_id=? AND key=?', projectId, key); }
  createWorkItem(projectId: string, w: {
    key: string; type: WorkItemRow['type']; title: string; description: string; acceptance: string[]; requirement_keys: string[]; depends_on: string[];
    paths: string[]; role: string; complexity: WorkItemRow['complexity']; priority: number; milestone: string | null; source: string;
  }): WorkItemRow {
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO work_items(id, project_id, key, type, title, description, acceptance, requirement_keys, depends_on, paths, role, complexity,
         priority, milestone, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'backlog', ?,?,?)
       ON CONFLICT(project_id, key) DO NOTHING`,
      newId('wi'), projectId, w.key, w.type, w.title.slice(0, 300), w.description.slice(0, 8000), JSON.stringify(w.acceptance), JSON.stringify(w.requirement_keys),
      JSON.stringify(w.depends_on), JSON.stringify(w.paths), w.role, w.complexity, w.priority, w.milestone, w.source, now, now,
    );
    return this.workItemByKey(projectId, w.key)!;
  }
  /** Compare-and-set status transition; returns false if the item was not in an expected state. */
  transition(id: string, from: WorkItemStatus[], to: WorkItemStatus, patch: Partial<WorkItemRow> = {}, reason: string | null = null): boolean {
    const sets = ['status=?', 'status_reason=?', 'updated_at=?'];
    const vals: Array<string | number | null> = [to, reason, this.clock.now()];
    for (const [k, v] of Object.entries(patch)) { sets.push(`${k}=?`); vals.push(v as string | number | null); }
    const r = this.db.run(`UPDATE work_items SET ${sets.join(', ')} WHERE id=? AND status IN (${from.map(() => '?').join(',')})`, ...vals, id, ...from);
    return r.changes === 1;
  }
  patchWorkItem(id: string, patch: Partial<WorkItemRow>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.run(`UPDATE work_items SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map((k) => (patch as Record<string, string | number | null>)[k]!), this.clock.now(), id);
  }
  nextKey(projectId: string, prefix: string): string {
    const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM work_items WHERE project_id=? AND key LIKE ?", projectId, `${prefix}-%`)!.n;
    return `${prefix}-${String(n + 1).padStart(3, '0')}`;
  }

  // ---- agents
  agents(projectId: string): AgentRow[] { return this.db.all<AgentRow>('SELECT * FROM agents WHERE project_id=? ORDER BY created_at', projectId); }
  agent(id: string): AgentRow | undefined { return this.db.get<AgentRow>('SELECT * FROM agents WHERE id=?', id); }

  // ---- findings
  addFinding(f: Omit<FindingRow, 'id' | 'status' | 'resolution_evidence' | 'defect_work_item_id' | 'created_at' | 'updated_at' | 'fingerprint'>): FindingRow {
    const fingerprint = sha256([f.work_item_id ?? '', f.category, f.title.toLowerCase().trim(), f.locations].join('|')).slice(0, 32);
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO findings(id, project_id, work_item_id, task_id, reviewer_agent_id, reviewer_provider, commit_sha, severity, category, title, locations,
         evidence, explanation, remediation, verification, source, fingerprint, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id, fingerprint) DO UPDATE SET status='open', commit_sha=excluded.commit_sha, updated_at=excluded.updated_at
       WHERE findings.status IN ('fixed_claimed')`,
      newId('fnd'), f.project_id, f.work_item_id, f.task_id, f.reviewer_agent_id, f.reviewer_provider, f.commit_sha, f.severity, f.category.slice(0, 80),
      f.title.slice(0, 300), f.locations, f.evidence.slice(0, 6000), f.explanation.slice(0, 4000), f.remediation.slice(0, 4000), f.verification.slice(0, 2000), f.source,
      fingerprint, now, now,
    );
    return this.db.get<FindingRow>('SELECT * FROM findings WHERE project_id=? AND fingerprint=?', f.project_id, fingerprint)!;
  }
  findings(projectId: string, opts: { workItemId?: string; statuses?: FindingRow['status'][] } = {}): FindingRow[] {
    let sql = 'SELECT * FROM findings WHERE project_id=?';
    const p: string[] = [projectId];
    if (opts.workItemId) { sql += ' AND work_item_id=?'; p.push(opts.workItemId); }
    if (opts.statuses) { sql += ` AND status IN (${opts.statuses.map(() => '?').join(',')})`; p.push(...opts.statuses); }
    return this.db.all<FindingRow>(sql + ' ORDER BY created_at', ...p);
  }
  setFindingStatus(id: string, status: FindingRow['status'], evidence?: string): void {
    this.db.run('UPDATE findings SET status=?, resolution_evidence=COALESCE(?, resolution_evidence), updated_at=? WHERE id=?', status, evidence ?? null, this.clock.now(), id);
  }

  // ---- decisions
  decisions(projectId: string): DecisionRow[] { return this.db.all<DecisionRow>('SELECT * FROM decisions WHERE project_id=? ORDER BY key', projectId); }
  decision(id: string): DecisionRow | undefined { return this.db.get<DecisionRow>('SELECT * FROM decisions WHERE id=?', id); }
  decisionByKey(projectId: string, key: string): DecisionRow | undefined { return this.db.get<DecisionRow>('SELECT * FROM decisions WHERE project_id=? AND key=?', projectId, key); }

  // ---- checkpoints
  checkpoint(c: { projectId: string; workItemId?: string | null; taskId?: string | null; kind: string; summary: string; data?: unknown }): void {
    this.db.run('INSERT INTO checkpoints(id, project_id, work_item_id, task_id, kind, summary, data, created_at) VALUES (?,?,?,?,?,?,?,?)',
      newId('ckpt'), c.projectId, c.workItemId ?? null, c.taskId ?? null, c.kind, c.summary.slice(0, 4000), JSON.stringify(c.data ?? {}).slice(0, 20000), this.clock.now());
  }
  checkpointsOfKind(projectId: string, workItemId: string, kind: string): CheckpointRow[] {
    return this.db.all<CheckpointRow>('SELECT * FROM checkpoints WHERE project_id=? AND work_item_id=? AND kind=? ORDER BY created_at', projectId, workItemId, kind);
  }
  checkpoints(projectId: string, workItemId?: string | null, limit = 8): CheckpointRow[] {
    return workItemId
      ? this.db.all<CheckpointRow>('SELECT * FROM checkpoints WHERE project_id=? AND work_item_id=? ORDER BY created_at DESC LIMIT ?', projectId, workItemId, limit).reverse()
      : this.db.all<CheckpointRow>('SELECT * FROM checkpoints WHERE project_id=? AND work_item_id IS NULL ORDER BY created_at DESC LIMIT ?', projectId, limit).reverse();
  }
}
