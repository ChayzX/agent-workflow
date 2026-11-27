// Deterministic policy enforcement. Agent output, repository content, issues and messages are
// untrusted data: they can *request* consequential actions but only this code (plus operator
// approvals) can authorize them. Prompts are never the enforcement mechanism.
import type { Db } from '../core/db.js';
import type { Clock } from '../core/clock.js';
import type { Config } from '../core/config.js';
import type { EventLog } from '../core/events.js';
import { newId, sha256 } from '../core/ids.js';

export type ApprovalAction =
  | 'production_deploy' | 'destructive_operation' | 'protected_infrastructure' | 'unrelated_repository'
  | 'credential_expansion' | 'additional_spending' | 'public_publication' | 'security_policy_change'
  | 'provider_reauthentication' | 'human_review_required' | 'repository_creation' | 'requirement_change';

export interface ApprovalRow {
  id: string; project_id: string | null; action: ApprovalAction; reason: string; payload: string; status: 'pending' | 'approved' | 'denied';
  requested_by: string; decided_by: string | null; dedup_key: string; created_at: number; decided_at: number | null;
}

export class Policy {
  constructor(private db: Db, private clock: Clock, private cfg: Config, private events: EventLog) {}

  requiresApproval(action: ApprovalAction): boolean {
    return this.cfg.security.approvalRequiredFor.includes(action) || ['provider_reauthentication', 'human_review_required', 'repository_creation', 'requirement_change'].includes(action);
  }

  /** Request (idempotently) an operator approval. Returns current status. */
  request(action: ApprovalAction, reason: string, opts: { projectId?: string | null; payload?: unknown; requestedBy: string; dedup?: string }): ApprovalRow {
    const dedup = opts.dedup ?? sha256(`${opts.projectId ?? ''}|${action}|${JSON.stringify(opts.payload ?? {})}`);
    const existing = this.db.get<ApprovalRow>('SELECT * FROM approvals WHERE dedup_key = ?', dedup);
    if (existing) return existing;
    const id = newId('appr');
    this.db.run(
      'INSERT INTO approvals(id, project_id, action, reason, payload, requested_by, dedup_key, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, opts.projectId ?? null, action, reason.slice(0, 2000), JSON.stringify(opts.payload ?? {}), opts.requestedBy, dedup, this.clock.now(),
    );
    this.events.emit('approval.requested', `Approval required: ${action} — ${reason}`, { projectId: opts.projectId, level: 'warn', data: { id, action } });
    this.events.audit(opts.requestedBy, 'approval.requested', { projectId: opts.projectId, target: id, detail: { action, reason } });
    return this.db.get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id)!;
  }

  status(dedup: string): ApprovalRow | undefined {
    return this.db.get<ApprovalRow>('SELECT * FROM approvals WHERE dedup_key = ?', dedup);
  }

  decide(id: string, approve: boolean, by: string): ApprovalRow {
    const r = this.db.run("UPDATE approvals SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'", approve ? 'approved' : 'denied', by, this.clock.now(), id);
    if (r.changes !== 1) throw new Error(`approval ${id} not found or already decided`);
    const row = this.db.get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id)!;
    this.events.audit(by, approve ? 'approval.approved' : 'approval.denied', { projectId: row.project_id, target: id, detail: { action: row.action } });
    return row;
  }

  pending(projectId?: string): ApprovalRow[] {
    return projectId
      ? this.db.all<ApprovalRow>("SELECT * FROM approvals WHERE status='pending' AND (project_id=? OR project_id IS NULL) ORDER BY created_at", projectId)
      : this.db.all<ApprovalRow>("SELECT * FROM approvals WHERE status='pending' ORDER BY created_at");
  }

  /** Repository allowlist: empty list means only repositories registered as projects. */
  repoAllowed(repo: string, registered: string[]): boolean {
    const allowed = [...this.cfg.security.allowedRepos, ...registered].map((r) => r.toLowerCase());
    return allowed.includes(repo.toLowerCase());
  }

  /** Changes touching protected paths need security review and cannot auto-merge without it. */
  touchesProtected(files: string[]): string[] {
    const res = this.cfg.security.protectedPathGlobs.map(globToRegExp);
    return files.filter((f) => res.some((re) => re.test(f)));
  }
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if ('.+^${}()|[]\\?'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

/** Heuristic for routing extra security review (does not replace the general review). */
export function securitySensitive(files: string[], text: string): boolean {
  return files.some((f) => /auth|login|session|token|secret|crypt|password|permission|rbac|oauth|jwt|sanitiz|security|\.env|docker|workflow/i.test(f))
    || /\b(eval|exec|spawn|child_process|innerHTML|dangerouslySetInnerHTML|deserializ|pickle|SQL|query\()/i.test(text);
}
