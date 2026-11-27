// Durable asynchronous agent communication across providers. Messages are rows, not live
// sessions: a waiting agent yields its slot and is resumed when its answers arrive.
// Loop prevention: dedup hash per sender, delegation depth limit, per-task message cap,
// transfer-cycle detection.
import type { Db } from '../core/db.js';
import type { Clock } from '../core/clock.js';
import type { Config } from '../core/config.js';
import type { EventLog } from '../core/events.js';
import { newId, sha256 } from '../core/ids.js';
import type { MessageType, RoleId } from '../core/types.js';

export interface MessageRow {
  id: string; project_id: string; task_id: string | null; thread_id: string; correlation_id: string; sender_agent_id: string;
  recipient_agent_id: string | null; recipient_role: string | null; type: MessageType; body: string; context: string;
  state: 'pending' | 'delivered' | 'processing' | 'processed' | 'expired' | 'dropped'; blocking: number; depth: number;
  dedup_hash: string; reply_to: string | null; created_at: number; processed_at: number | null;
}

export const ACTIONABLE: ReadonlySet<MessageType> = new Set<MessageType>(['question', 'assist_request', 'challenge', 'revision_request', 'blocker']);

export interface PostSpec {
  projectId: string;
  taskId: string | null;
  senderAgentId: string;
  toRole?: RoleId | null;
  toAgentId?: string | null;
  type: MessageType;
  body: string;
  blocking?: boolean;
  replyTo?: string | null;
  correlationId?: string | null;
  threadId?: string | null;
  depth?: number;
  context?: Record<string, unknown>;
}

export class MessageBus {
  constructor(private db: Db, private clock: Clock, private cfg: Config, private events: EventLog) {}

  post(s: PostSpec): { message: MessageRow | null; created: boolean; reason?: string } {
    const body = s.body.trim().slice(0, 6000);
    if (!body) return { message: null, created: false, reason: 'empty' };
    const depth = s.depth ?? 0;
    if (s.taskId && s.type !== 'answer') {
      const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE task_id=? AND type != 'answer'", s.taskId)!.n;
      if (n >= this.cfg.limits.maxMessagesPerTask) {
        this.events.emit('message.dropped', `message cap reached for task ${s.taskId}`, { projectId: s.projectId, taskId: s.taskId, level: 'warn' });
        return { message: null, created: false, reason: 'per-task message cap' };
      }
    }
    const norm = body.toLowerCase().replace(/\s+/g, ' ');
    const dedup = sha256(`${s.type}|${s.toAgentId ?? s.toRole ?? ''}|${s.replyTo ?? ''}|${norm}`).slice(0, 40);
    const existing = this.db.get<MessageRow>('SELECT * FROM messages WHERE project_id=? AND sender_agent_id=? AND dedup_hash=?', s.projectId, s.senderAgentId, dedup);
    if (existing) return { message: existing, created: false, reason: 'duplicate' };
    const id = newId('msg');
    const correlation = s.correlationId ?? id;
    const tooDeep = depth > this.cfg.limits.maxMessageDepth && ACTIONABLE.has(s.type);
    this.db.run(
      `INSERT INTO messages(id, project_id, task_id, thread_id, correlation_id, sender_agent_id, recipient_agent_id, recipient_role, type, body,
         context, state, blocking, depth, dedup_hash, reply_to, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, s.projectId, s.taskId, s.threadId ?? correlation, correlation, s.senderAgentId, s.toAgentId ?? null, s.toRole ?? null, s.type, body,
      JSON.stringify(s.context ?? {}), tooDeep ? 'expired' : 'pending', s.blocking ? 1 : 0, depth, dedup, s.replyTo ?? null, this.clock.now(),
    );
    const m = this.get(id)!;
    this.events.emit('message.posted', `${s.type} → ${s.toAgentId ?? s.toRole}: ${body.slice(0, 160)}`, { projectId: s.projectId, taskId: s.taskId, data: { id, depth, blocking: !!s.blocking, expired: tooDeep } });
    return { message: m, created: true, reason: tooDeep ? 'delegation depth exceeded' : undefined };
  }

  get(id: string): MessageRow | undefined { return this.db.get<MessageRow>('SELECT * FROM messages WHERE id=?', id); }

  /** Actionable messages that need an answering task. */
  actionablePending(projectId: string): MessageRow[] {
    return this.db.all<MessageRow>(
      `SELECT * FROM messages WHERE project_id=? AND state='pending' AND type IN ('question','assist_request','challenge','revision_request','blocker','transfer') ORDER BY created_at`,
      projectId,
    );
  }

  setState(id: string, state: MessageRow['state']): boolean {
    return this.db.run('UPDATE messages SET state=?, processed_at=CASE WHEN ? IN (\'processed\',\'expired\',\'dropped\') THEN ? ELSE processed_at END WHERE id=?', state, state, this.clock.now(), id).changes === 1;
  }

  /** Atomically move pending → processing so a message spawns at most one answering task. */
  claim(id: string): boolean {
    return this.db.run("UPDATE messages SET state='processing' WHERE id=? AND state='pending'", id).changes === 1;
  }

  /** Informational messages + answers waiting to be shown to an agent (by id or role). */
  inbox(projectId: string, agentId: string, role: string, limit = 10): MessageRow[] {
    return this.db.all<MessageRow>(
      `SELECT * FROM messages WHERE project_id=? AND (recipient_agent_id=? OR (recipient_agent_id IS NULL AND recipient_role=?))
         AND state IN ('pending','delivered') AND type IN ('answer','proposal','finding','decision','revision_request')
       ORDER BY created_at DESC LIMIT ?`,
      projectId, agentId, role, limit,
    ).reverse();
  }

  answersFor(questionIds: string[]): MessageRow[] {
    if (!questionIds.length) return [];
    return this.db.all<MessageRow>(`SELECT * FROM messages WHERE type='answer' AND reply_to IN (${questionIds.map(() => '?').join(',')}) ORDER BY created_at`, ...questionIds);
  }

  /** Blocking questions raised by a task that still have no answer. */
  unansweredBlocking(taskId: string): MessageRow[] {
    return this.db.all<MessageRow>(
      `SELECT q.* FROM messages q WHERE q.task_id=? AND q.blocking=1 AND q.type IN ('question','assist_request','blocker')
         AND q.state NOT IN ('expired','dropped') AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.type='answer' AND a.reply_to=q.id)`,
      taskId,
    );
  }

  thread(threadId: string): MessageRow[] {
    return this.db.all<MessageRow>('SELECT * FROM messages WHERE thread_id=? ORDER BY created_at', threadId);
  }

  markDelivered(ids: string[]): void {
    for (const id of ids) this.db.run("UPDATE messages SET state='delivered' WHERE id=? AND state='pending'", id);
  }

  /** Transfer cycle detection: a task may not be transferred back to a role it already visited. */
  static transferAllowed(history: string[], toRole: string): boolean {
    return !history.includes(toRole) && history.length < 4;
  }
}
