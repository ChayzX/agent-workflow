// Durable task queue: idempotent enqueue, atomic claim with fenced leases, heartbeats,
// expiry reclaim and bounded retries. All state lives in SQLite so restarts lose nothing.
import type { Db } from '../core/db.js';
import { json } from '../core/db.js';
import type { Clock } from '../core/clock.js';
import { newId } from '../core/ids.js';
import type { Complexity, FailureClass, ProviderId, RoleId, TaskKind, TaskRow, TaskStatus } from '../core/types.js';

export interface TaskSpec {
  projectId: string;
  kind: TaskKind;
  role: RoleId;
  idempotencyKey: string;
  input: Record<string, unknown>;
  workItemId?: string | null;
  agentId?: string | null;
  priority?: number;
  complexity?: Complexity;
  providerPinned?: ProviderId | null;
  excludeProviders?: ProviderId[];
  excludeAgents?: string[];
  notBefore?: number;
  maxAttempts?: number;
  readOnly?: boolean;
  parentTaskId?: string | null;
  workspacePath?: string | null;
  sessionId?: string | null;
  sessionProvider?: ProviderId | null;
}

export const ACTIVE_STATUSES: TaskStatus[] = ['queued', 'running', 'waiting_message', 'waiting_capacity'];

export class TaskQueue {
  constructor(private db: Db, private clock: Clock) {}

  /** Insert once per idempotency key; returns the existing task on retry/crash replay. */
  enqueue(s: TaskSpec): { task: TaskRow; created: boolean } {
    const now = this.clock.now();
    const existing = this.byKey(s.idempotencyKey);
    if (existing) return { task: existing, created: false };
    const id = newId('task');
    this.db.run(
      `INSERT INTO tasks(id, project_id, work_item_id, kind, role, agent_id, status, priority, complexity, provider_pinned,
        exclude_providers, exclude_agents, not_before, max_attempts, idempotency_key, input, read_only, parent_task_id,
        workspace_path, session_id, session_provider, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'queued', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      id, s.projectId, s.workItemId ?? null, s.kind, s.role, s.agentId ?? null, s.priority ?? 1, s.complexity ?? 'medium',
      s.providerPinned ?? null, JSON.stringify(s.excludeProviders ?? []), JSON.stringify(s.excludeAgents ?? []), s.notBefore ?? 0,
      s.maxAttempts ?? 4, s.idempotencyKey, JSON.stringify(s.input), s.readOnly ? 1 : 0, s.parentTaskId ?? null,
      s.workspacePath ?? null, s.sessionId ?? null, s.sessionProvider ?? null, now, now,
    );
    const t = this.byKey(s.idempotencyKey)!;
    return { task: t, created: t.id === id };
  }

  byKey(key: string): TaskRow | undefined {
    return this.db.get<TaskRow>('SELECT * FROM tasks WHERE idempotency_key = ?', key);
  }
  get(id: string): TaskRow | undefined {
    return this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  }

  /** Candidates eligible for dispatch, highest priority first. */
  dispatchable(limit = 50): TaskRow[] {
    return this.db.all<TaskRow>(
      `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.status = 'queued' AND t.not_before <= ? AND p.status IN ('planning','debating','active','auditing','releasing')
       ORDER BY t.priority ASC, t.created_at ASC LIMIT ?`,
      this.clock.now(), limit,
    );
  }

  /**
   * Atomic claim: succeeds for exactly one caller. The lease owner token fences all later
   * writes, so a stale worker (e.g. from before a restart) can never overwrite state.
   */
  claim(taskId: string, owner: string, provider: ProviderId, leaseMs: number): TaskRow | null {
    const now = this.clock.now();
    const r = this.db.run(
      `UPDATE tasks SET status='running', lease_owner=?, lease_expires_at=?, heartbeat_at=?, provider=?, attempts=attempts+1, updated_at=?
       WHERE id=? AND status='queued' AND not_before <= ?`,
      owner, now + leaseMs, now, provider, now, taskId, now,
    );
    return r.changes === 1 ? this.get(taskId)! : null;
  }

  heartbeat(taskId: string, owner: string, leaseMs: number, pid?: number | null): boolean {
    const now = this.clock.now();
    const r = this.db.run(
      `UPDATE tasks SET lease_expires_at=?, heartbeat_at=?, pid=COALESCE(?, pid), updated_at=? WHERE id=? AND lease_owner=? AND status='running'`,
      now + leaseMs, now, pid ?? null, now, taskId, owner,
    );
    return r.changes === 1;
  }

  setSession(taskId: string, owner: string, sessionId: string, provider: ProviderId): void {
    this.db.run('UPDATE tasks SET session_id=?, session_provider=? WHERE id=? AND lease_owner=?', sessionId, provider, taskId, owner);
  }

  succeed(taskId: string, owner: string, output: unknown): boolean {
    const now = this.clock.now();
    const r = this.db.run(
      `UPDATE tasks SET status='succeeded', output=?, lease_owner=NULL, lease_expires_at=NULL, pid=NULL, error_class=NULL, error_message=NULL, updated_at=?
       WHERE id=? AND lease_owner=? AND status='running'`,
      JSON.stringify(output), now, taskId, owner,
    );
    return r.changes === 1;
  }

  /**
   * Release a running task back to a waiting/queued state.
   * countAttempt=false for capacity/interruption events, which must not burn the retry budget.
   */
  release(taskId: string, owner: string, opts: {
    status: Extract<TaskStatus, 'queued' | 'waiting_capacity' | 'waiting_message'>; notBefore?: number; cls?: FailureClass | null;
    message?: string | null; countAttempt: boolean; pin?: ProviderId | null; clearSession?: boolean;
  }): boolean {
    const now = this.clock.now();
    const r = this.db.run(
      `UPDATE tasks SET status=?, not_before=?, error_class=?, error_message=?, lease_owner=NULL, lease_expires_at=NULL, pid=NULL,
         attempts = attempts - ?, provider_pinned = CASE WHEN ? = 1 THEN ? ELSE provider_pinned END,
         session_id = CASE WHEN ? = 1 THEN NULL ELSE session_id END, updated_at=?
       WHERE id=? AND lease_owner=? AND status='running'`,
      opts.status, opts.notBefore ?? now, opts.cls ?? null, opts.message?.slice(0, 4000) ?? null, opts.countAttempt ? 0 : 1,
      opts.pin !== undefined ? 1 : 0, opts.pin ?? null, opts.clearSession ? 1 : 0, now, taskId, owner,
    );
    return r.changes === 1;
  }

  fail(taskId: string, owner: string | null, status: Extract<TaskStatus, 'failed' | 'dead' | 'cancelled'>, cls: FailureClass, message: string): boolean {
    const now = this.clock.now();
    const r = this.db.run(
      `UPDATE tasks SET status=?, error_class=?, error_message=?, lease_owner=NULL, lease_expires_at=NULL, pid=NULL, updated_at=?
       WHERE id=? AND (lease_owner IS ? OR ? IS NULL)`,
      status, cls, message.slice(0, 4000), now, taskId, owner, owner,
    );
    return r.changes === 1;
  }

  /** Move a waiting task back to the queue (answer arrived / capacity returned). */
  wake(taskId: string, from: TaskStatus[], notBefore = 0): boolean {
    const r = this.db.run(
      `UPDATE tasks SET status='queued', not_before=?, updated_at=? WHERE id=? AND status IN (${from.map(() => '?').join(',')})`,
      notBefore, this.clock.now(), taskId, ...from,
    );
    return r.changes === 1;
  }

  updateInput(taskId: string, patch: Record<string, unknown>): void {
    const t = this.get(taskId);
    if (!t) return;
    const input = { ...json<Record<string, unknown>>(t.input, {}), ...patch };
    this.db.run('UPDATE tasks SET input=?, updated_at=? WHERE id=?', JSON.stringify(input), this.clock.now(), taskId);
  }

  /** Latest task of an idempotency-key family (exact key or `key:<suffix>` retries). */
  latestByPrefix(base: string): TaskRow | undefined {
    return this.db.get<TaskRow>('SELECT * FROM tasks WHERE idempotency_key = ? OR substr(idempotency_key, 1, ?) = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', base, base.length + 1, base + ':');
  }
  countByPrefix(base: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE idempotency_key = ? OR substr(idempotency_key, 1, ?) = ?', base, base.length + 1, base + ':')!.n;
  }

  /** Operator cancellation: only affects tasks that have not finished (never overwrites a recorded outcome). */
  cancel(taskId: string, reason: string): boolean {
    return this.db.run(`UPDATE tasks SET status='cancelled', error_class='interrupted', error_message=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=?
      WHERE id=? AND status IN ('queued','running','waiting_message','waiting_capacity')`, reason.slice(0, 500), this.clock.now(), taskId).changes === 1;
  }

  cancelForWorkItem(workItemId: string, reason: string): number {
    return this.db.run(
      `UPDATE tasks SET status='cancelled', error_message=?, updated_at=? WHERE work_item_id=? AND status IN ('queued','waiting_message','waiting_capacity')`,
      reason, this.clock.now(), workItemId,
    ).changes;
  }

  /** Leases that expired (worker died / supervisor crashed). Returned for recovery handling. */
  expiredLeases(): TaskRow[] {
    return this.db.all<TaskRow>(`SELECT * FROM tasks WHERE status='running' AND lease_expires_at < ?`, this.clock.now());
  }

  /** Force-requeue a task whose lease owner is gone (restart recovery). Attempts are not burned. */
  recoverOrphan(taskId: string, expectedOwner: string | null): boolean {
    const now = this.clock.now();
    const r = this.db.run(
      `UPDATE tasks SET status='queued', lease_owner=NULL, lease_expires_at=NULL, pid=NULL, attempts=MAX(attempts-1,0),
         provider_pinned = CASE WHEN session_id IS NOT NULL THEN session_provider ELSE provider_pinned END,
         error_class='interrupted', error_message='recovered after supervisor/worker loss', not_before=?, updated_at=?
       WHERE id=? AND status='running' AND lease_owner IS ?`,
      now, now, taskId, expectedOwner,
    );
    return r.changes === 1;
  }

  runningCount(filter: { provider?: string; projectId?: string } = {}): number {
    let sql = "SELECT COUNT(*) AS n FROM tasks WHERE status='running'";
    const p: string[] = [];
    if (filter.provider) { sql += ' AND provider = ?'; p.push(filter.provider); }
    if (filter.projectId) { sql += ' AND project_id = ?'; p.push(filter.projectId); }
    return (this.db.get<{ n: number }>(sql, ...p)?.n ?? 0);
  }

  activeForWorkItem(workItemId: string): TaskRow[] {
    return this.db.all<TaskRow>(`SELECT * FROM tasks WHERE work_item_id=? AND status IN ('queued','running','waiting_message','waiting_capacity')`, workItemId);
  }
}
