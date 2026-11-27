// Execution events (operator-visible timeline) and a hash-chained, append-only audit trail
// for consequential actions (merges, pushes, approvals, releases, policy changes).
import type { Db } from './db.js';
import type { Clock } from './clock.js';
import { sha256 } from './ids.js';
import { redact, redactValue } from './redact.js';

export class EventLog {
  constructor(private db: Db, private clock: Clock) {}

  emit(type: string, message: string, opts: { projectId?: string | null; taskId?: string | null; level?: string; data?: unknown } = {}): void {
    this.db.run(
      'INSERT INTO events(ts, project_id, task_id, level, type, message, data) VALUES (?,?,?,?,?,?,?)',
      this.clock.now(),
      opts.projectId ?? null,
      opts.taskId ?? null,
      opts.level ?? 'info',
      type,
      redact(message).slice(0, 4000),
      JSON.stringify(redactValue(opts.data ?? {})).slice(0, 20000),
    );
  }

  audit(actor: string, action: string, opts: { projectId?: string | null; target?: string | null; detail?: unknown } = {}): void {
    this.db.tx(() => {
      const prev = this.db.get<{ hash: string }>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')?.hash ?? 'genesis';
      const ts = this.clock.now();
      const detail = JSON.stringify(redactValue(opts.detail ?? {}));
      const hash = sha256([prev, ts, actor, action, opts.projectId ?? '', opts.target ?? '', detail].join('|'));
      this.db.run(
        'INSERT INTO audit_log(ts, actor, action, project_id, target, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)',
        ts, actor, action, opts.projectId ?? null, opts.target ?? null, detail, prev, hash,
      );
    });
  }

  /** Verify the audit hash chain has not been tampered with. */
  verifyAuditChain(): { ok: boolean; brokenAt?: number } {
    let prev = 'genesis';
    for (const r of this.db.all<{ id: number; ts: number; actor: string; action: string; project_id: string | null; target: string | null; detail: string; prev_hash: string; hash: string }>(
      'SELECT * FROM audit_log ORDER BY id',
    )) {
      const h = sha256([prev, r.ts, r.actor, r.action, r.project_id ?? '', r.target ?? '', r.detail].join('|'));
      if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAt: r.id };
      prev = r.hash;
    }
    return { ok: true };
  }
}
