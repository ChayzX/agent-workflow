// Project lifecycle state machine (deterministic). Goal analysis → requirements → backlog →
// dependency resolution → assignment → implementation → gates → independent review →
// remediation → merge verification → integration audit → completion audit → release.
// Every transition is a compare-and-set on durable state and every spawned task has an
// idempotency key, so replays after crashes never duplicate work.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { json } from '../core/db.js';
import { newId, slugify } from '../core/ids.js';
import type { ProjectRow, QualityGate, Severity, TaskRow, WorkItemRow, WorkItemStatus } from '../core/types.js';
import { SEVERITY_RANK } from '../core/types.js';
import { authEnv, git, Workspace } from '../git/git.js';
import { securitySensitive } from '../security/policy.js';
import type { Ctx } from './ctx.js';
import { topLevelTree } from './context.js';
import { DebateEngine } from './debate.js';
import { failedGateText, gateEvidence, runGates } from './gates.js';
import { ACTIONABLE, MessageBus } from './messages.js';
import { buildAndVerifyRelease } from './release.js';
import { defaultRoleFor } from './roles.js';
import { Store, type FindingRow } from './store.js';
import { Team } from './team.js';

const ACTIVE_WI: WorkItemStatus[] = ['implementing', 'gating', 'in_review', 'remediation', 'merge_ready', 'merging'];
const BLOCKING_SEVERITY = SEVERITY_RANK.medium;
const isBlocking = (s: Severity) => SEVERITY_RANK[s] >= BLOCKING_SEVERITY;

export class Workflow {
  readonly store: Store;
  readonly team: Team;
  readonly bus: MessageBus;
  readonly debate: DebateEngine;
  private jobs = new Map<string, Promise<void>>();
  private lastSync = new Map<string, number>();
  private lastRemoteCheck = new Map<string, number>();
  private pushRetryAt = new Map<string, number>(); // work item id → earliest next push attempt (backoff after failures)
  // Git transport credentials for GitHub mode: the same token the API client uses (env-scoped per git call).
  private tokenProvider: () => string | null = () => this.ctx.githubToken?.() ?? null;

  constructor(private ctx: Ctx, private wake: () => void) {
    this.store = new Store(ctx.db, ctx.clock);
    this.team = new Team(ctx.db, ctx.clock);
    this.bus = new MessageBus(ctx.db, ctx.clock, ctx.cfg, ctx.events);
    this.debate = new DebateEngine(ctx, this.store, this.team);
  }

  setTokenProvider(fn: () => string | null): void { this.tokenProvider = fn; }

  ws(p: ProjectRow): Workspace {
    const ws = new Workspace(p.workspace_dir, p.default_branch, () => (p.repo_mode === 'github' ? authEnv(this.tokenProvider()) : {}));
    ws.onTamper = (f) => {
      this.ctx.events.emit('security.git_tamper', `repaired untrusted git metadata: ${f.join('; ')}`.slice(0, 1000), { projectId: p.id, level: 'error' });
      this.ctx.events.audit('supervisor', 'security.git_tamper', { projectId: p.id, detail: { repaired: f } });
    };
    return ws;
  }

  // ---------------------------------------------------------------- jobs
  /** Run deterministic long work (git, gates, merges, packaging) off the tick, at most once per key. */
  job(key: string, projectId: string, fn: () => Promise<void>): void {
    if (this.jobs.has(key)) return;
    const p = (async () => fn())().catch((e: Error) => {
      this.ctx.events.emit('job.error', `${key}: ${e.message}`, { projectId, level: 'error', data: { stack: e.stack?.slice(0, 2000) } });
      this.ctx.log.error('job failed', { key, error: e.message });
    }).finally(() => { this.jobs.delete(key); this.wake(); });
    this.jobs.set(key, p);
  }
  jobCount(projectId?: string): number {
    return projectId ? [...this.jobs.keys()].filter((k) => k.includes(projectId)).length : this.jobs.size;
  }
  async drainJobs(): Promise<void> { await Promise.allSettled([...this.jobs.values()]); }

  // ---------------------------------------------------------------- advance
  /** Deterministic per-project progression. Never calls a model directly. */
  async advance(p: ProjectRow): Promise<void> {
    if (!existsSync(join(p.workspace_dir, 'integration', '.git'))) {
      this.job(`ws:${p.id}`, p.id, async () => { await this.ws(p).ensure(p.repo_mode === 'local' ? p.repo_source : `https://github.com/${p.repo_source}.git`); });
      return;
    }
    switch (p.status) {
      case 'planning': return this.advancePlanning(p);
      case 'debating':
      case 'active': return this.advanceActive(p);
      case 'auditing': return this.advanceAuditing(p);
      case 'releasing': return this.advanceReleasing(p);
      default: return;
    }
  }

  private advancePlanning(p: ProjectRow): void {
    if (p.plan) { this.store.setProjectStatus(p.id, 'active'); return; }
    const attempt = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND kind='plan' AND status IN ('failed','dead')", p.id)!.n;
    const director = this.team.ensureAgent(p.id, 'engineering_director');
    this.ctx.queue.enqueue({
      projectId: p.id, kind: 'plan', role: 'engineering_director', agentId: director.id, idempotencyKey: `plan:${p.id}:${attempt}`,
      input: { attempt }, readOnly: true, complexity: 'high', priority: 0,
    });
  }

  private advanceActive(p: ProjectRow): void {
    const settings = this.store.settings(p);
    // Debates gate dependent work.
    const undecided = this.store.decisions(p.id).filter((d) => d.status !== 'decided' && d.status !== 'blocked');
    for (const d of undecided) this.debate.advance(p, d);
    if (p.status === 'debating' && !undecided.length) this.store.setProjectStatus(p.id, 'active');

    this.processMessages(p);
    this.syncGitHub(p);

    const items = this.store.workItems(p.id);
    const byKey = new Map(items.map((w) => [w.key, w]));
    // backlog → ready / blocked (dependency resolution)
    for (const w of items.filter((x) => x.status === 'backlog')) {
      const deps = json<string[]>(w.depends_on, []);
      let ready = true;
      let blockedBy: string | null = null;
      for (const k of deps) {
        const dw = byKey.get(k);
        if (dw) {
          if (dw.status === 'blocked' || dw.status === 'cancelled') { blockedBy = k; break; }
          if (!['merged', 'done'].includes(dw.status)) ready = false;
          continue;
        }
        const dd = this.store.decisionByKey(p.id, k);
        if (dd) {
          if (dd.status === 'blocked') { blockedBy = k; break; }
          if (dd.status !== 'decided') ready = false;
          continue;
        }
        blockedBy = `${k} (unknown dependency)`;
        break;
      }
      if (blockedBy) this.block(p, w, `dependency ${blockedBy} is blocked or cancelled`);
      else if (ready) this.store.transition(w.id, ['backlog'], 'ready');
    }

    // ready → implementing, bounded WIP and path-conflict avoidance
    const fresh = this.store.workItems(p.id);
    const active = fresh.filter((w) => ACTIVE_WI.includes(w.status));
    const wipLimit = this.ctx.cfg.supervisor.maxPerProject + 1;
    for (const w of fresh.filter((x) => x.status === 'ready').sort((a, b) => a.priority - b.priority)) {
      if (active.length >= wipLimit) break;
      if (conflicts(w, active)) continue;
      active.push(w);
      this.job(`start:${w.id}`, p.id, () => this.startImplementation(p, w));
    }

    for (const w of fresh) {
      switch (w.status) {
        case 'gating': if (w.head_commit && w.gated_commit !== w.head_commit) this.job(`gate:${w.id}:${w.head_commit}`, p.id, () => this.gate(p, w)); break;
        case 'in_review': this.ensureReviews(p, w); break;
        case 'remediation': this.ensureRemediation(p, w); break;
        case 'merge_ready': this.job(`integration:${p.id}`, p.id, () => this.merge(p, w)); break; // integration-worktree ops serialized per project
        case 'merging': {
          // Never let one PR monopolize the per-project integration job (fairness) or poll GitHub every tick.
          const appr = this.ctx.policy.status(`human-review:${p.id}:${w.key}:${w.head_commit}`);
          if (appr?.status === 'pending') break;
          if (appr?.status === 'denied') { this.block(p, w, `required human review on PR #${w.pr_number} was denied by the operator`); break; }
          const now = this.ctx.clock.now();
          if (now - (this.lastRemoteCheck.get(w.id) ?? 0) < 60_000) break;
          this.lastRemoteCheck.set(w.id, now);
          this.job(`integration:${p.id}`, p.id, () => this.continueRemoteMerge(p, w));
          break;
        }
        case 'merged': this.job(`integration:${p.id}`, p.id, () => this.finalize(p, w)); break;
        case 'implementing': this.repairStalled(p, w); break;
      }
    }

    // Periodic integration audit (every N merges).
    const merges = fresh.filter((w) => w.status === 'done').length;
    const every = Math.max(1, settings.integration_audit_every);
    if (merges > 0 && merges % every === 0 && fresh.some((w) => ['backlog', 'ready', ...ACTIVE_WI].includes(w.status))) {
      this.ctx.queue.enqueue({ projectId: p.id, kind: 'integration_audit', role: 'software_architect', agentId: this.team.ensureAgent(p.id, 'software_architect').id,
        idempotencyKey: `intaudit:${p.id}:${merges}`, input: { merges }, readOnly: true, complexity: 'medium', priority: 2 });
    }

    // Completion detection → audit (never just because the backlog is empty: the audit decides).
    const open = this.store.workItems(p.id).filter((w) => !['done', 'cancelled', 'blocked'].includes(w.status));
    const activeTasks = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status IN ('queued','running','waiting_message','waiting_capacity')", p.id)!.n;
    const pendingMsgs = this.bus.actionablePending(p.id).length;
    if (!open.length && !activeTasks && !pendingMsgs && !undecided.length && !this.jobCount(p.id) && fresh.length) {
      const round = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audits WHERE project_id=? AND kind='completion'", p.id)!.n + 1;
      if (round > 6) { this.store.setProjectStatus(p.id, 'blocked', 'completion audit failed 6 times; operator review required'); return; }
      const id = newId('aud');
      this.ctx.db.run("INSERT INTO audits(id, project_id, kind, status, round, created_at, updated_at) VALUES (?,?, 'completion', 'pending', ?,?,?)", id, p.id, round, this.ctx.clock.now(), this.ctx.clock.now());
      this.store.setProjectStatus(p.id, 'auditing', `completion audit round ${round}`);
      this.ctx.events.emit('project.auditing', `backlog complete; starting completion audit round ${round}`, { projectId: p.id });
    }
  }

  private block(p: ProjectRow, w: WorkItemRow, reason: string): void {
    const cur = this.store.workItem(w.id);
    if (!cur || ['done', 'merged', 'cancelled'].includes(cur.status)) return; // never revive a finished or descoped item
    if (!this.store.transition(w.id, [cur.status], 'blocked', {}, reason)) return;
    this.ctx.queue.cancelForWorkItem(w.id, `blocked: ${reason}`);
    for (const rk of json<string[]>(w.requirement_keys, [])) this.store.setRequirementStatus(p.id, rk, 'blocked', [{ blocker: w.key, reason }], `${w.key}: ${reason}`);
    this.ctx.events.emit('workitem.blocked', `${w.key} blocked: ${reason}`, { projectId: p.id, level: 'warn' });
  }

  /**
   * Operator override for a blocked item, with a recorded note. A reviewed and gated commit returns to `merge_ready`
   * (the merge re-verifies the merged tree); anything else returns to `backlog`, so dependency resolution runs again
   * before work restarts. Investigation, remediation and merge-retry limits restart from here.
   */
  unblock(p: ProjectRow, key: string, note: string, by: string): string {
    const w = this.store.workItemByKey(p.id, key);
    if (!w) return `no work item ${key}`;
    if (w.status !== 'blocked') return `${key} is ${w.status}, not blocked`;
    const verified = !!w.head_commit && w.reviewed_commit === w.head_commit && w.gated_commit === w.head_commit;
    const target = verified ? 'merge_ready' : 'backlog';
    if (!this.store.transition(w.id, ['blocked'], target, { remediation_rounds: 0 }, `unblocked by ${by}: ${note}`.slice(0, 500))) return 'state changed concurrently; retry';
    for (const rk of json<string[]>(w.requirement_keys, [])) if (this.store.requirement(p.id, rk)?.status === 'blocked') this.store.setRequirementStatus(p.id, rk, 'open', [{ unblocked: w.key, by }], null);
    this.store.checkpoint({ projectId: p.id, workItemId: w.id, kind: 'operator_unblock', summary: `Operator guidance: ${note}` });
    this.ctx.events.audit(by, 'workitem.unblock', { projectId: p.id, target: w.key, detail: { note } });
    this.ctx.events.emit('workitem.unblocked', `${w.key} unblocked by ${by}: ${note}`, { projectId: p.id });
    if (p.status === 'blocked') this.store.setProjectStatus(p.id, 'active', `${w.key} unblocked by ${by}`);
    return 'ok';
  }

  /** Operator descoping (local equivalent of closing an issue as "not planned"): authorized, recorded, audited. */
  cancelItem(p: ProjectRow, key: string, note: string, by: string): string {
    const w = this.store.workItemByKey(p.id, key);
    if (!w) return `no work item ${key}`;
    // Once integration has started the work may already be on the default branch: descoping it then would be a lie.
    if (['done', 'cancelled', 'merge_ready', 'merging', 'merged'].includes(w.status)) return `${key} is ${w.status}; not cancelled (integration started or finished)`;
    if (!this.store.transition(w.id, [w.status], 'cancelled', {}, `cancelled by ${by}: ${note}`.slice(0, 500))) return 'state changed concurrently; retry';
    this.ctx.queue.cancelForWorkItem(w.id, `cancelled by ${by}`);
    for (const rk of json<string[]>(w.requirement_keys, [])) if (this.store.requirement(p.id, rk)?.status === 'blocked') this.store.setRequirementStatus(p.id, rk, 'open', [{ cancelled: w.key, by }], null);
    this.store.checkpoint({ projectId: p.id, workItemId: w.id, kind: 'operator_cancel', summary: `Cancelled by operator: ${note}` });
    this.ctx.events.audit(by, 'workitem.descoped', { projectId: p.id, target: w.key, detail: { note } });
    this.ctx.events.emit('workitem.cancelled', `${w.key} cancelled by ${by}: ${note}`, { projectId: p.id, level: 'warn' });
    if (p.status === 'blocked') this.store.setProjectStatus(p.id, 'active', `${w.key} cancelled by ${by}`);
    return 'ok';
  }

  private async startImplementation(p: ProjectRow, w: WorkItemRow): Promise<void> {
    const ws = this.ws(p);
    const base = await ws.head();
    const branch = w.branch ?? `orch/${w.key.toLowerCase()}-${slugify(w.title, 30)}`;
    await ws.worktree(w.key, branch, base);
    this.ctx.db.tx(() => {
      if (!this.store.transition(w.id, ['ready'], 'implementing', { branch, base_commit: base })) return;
      const n = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE work_item_id=? AND kind='implement'", w.id)!.n;
      const agent = this.team.ensureAgent(p.id, w.role);
      this.store.patchWorkItem(w.id, { implementer_agent_id: agent.id });
      this.ctx.queue.enqueue({ projectId: p.id, kind: 'implement', role: w.role, agentId: agent.id, workItemId: w.id, idempotencyKey: `impl:${w.id}:${n + 1}`,
        input: { round: n + 1 }, complexity: w.complexity, priority: w.priority, workspacePath: ws.wtPath(w.key) });
    });
  }

  /** An item stuck in implementing with no live task (e.g. task cancelled by an operator) gets a new attempt. */
  private repairStalled(p: ProjectRow, w: WorkItemRow): void {
    if (this.ctx.queue.activeForWorkItem(w.id).length || this.jobs.has(`start:${w.id}`)) return;
    const last = this.ctx.db.get<TaskRow>("SELECT * FROM tasks WHERE work_item_id=? AND kind IN ('implement','investigate','remediate') ORDER BY created_at DESC, rowid DESC LIMIT 1", w.id);
    // Wait while an outcome handler is still pending; a cancelled task is terminal and gets replaced.
    if (last && last.status !== 'cancelled' && !last.processed) return;
    const n = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE work_item_id=? AND kind='implement'", w.id)!.n;
    if (n >= 4) { this.requestInvestigation(p, w, 'implementation attempts exhausted'); return; }
    this.ctx.queue.enqueue({ projectId: p.id, kind: 'implement', role: w.role, agentId: w.implementer_agent_id ?? this.team.ensureAgent(p.id, w.role).id, workItemId: w.id,
      idempotencyKey: `impl:${w.id}:${n + 1}`, input: { round: n + 1 }, complexity: w.complexity, priority: w.priority, workspacePath: this.ws(p).wtPath(w.key) });
  }

  private async gate(p: ProjectRow, w: WorkItemRow): Promise<void> {
    const ws = this.ws(p);
    const dir = ws.wtPath(w.key);
    const head = await ws.head(dir);
    if (head !== w.head_commit) this.store.patchWorkItem(w.id, { head_commit: head });
    const s = await runGates(this.ctx, { projectId: p.id, workItemId: w.id, scope: 'task', cwd: dir, commit: head, gates: this.store.settings(p).gates, gitDir: this.ws(p).bare });
    if (s.passed) {
      const cur = this.store.workItem(w.id)!;
      const blocking = this.store.findings(p.id, { workItemId: w.id, statuses: ['open', 'fixed_claimed'] }).filter((f) => isBlocking(f.severity));
      // Approval carried over by an identical patch-id (clean update from the default branch): no re-review needed.
      if (cur.reviewed_commit === head && !blocking.length) this.store.transition(w.id, ['gating'], 'merge_ready', { gated_commit: head }, 'gates passed; review approval carried over (identical patch)');
      else if (this.store.transition(w.id, ['gating'], 'in_review', { gated_commit: head })) this.store.checkpoint({ projectId: p.id, workItemId: w.id, kind: 'in_review', summary: `review round on ${head.slice(0, 8)}` });
    } else {
      this.store.checkpoint({ projectId: p.id, workItemId: w.id, kind: 'gate_failure', summary: `gates failed on ${head.slice(0, 8)}: ${s.results.filter((r) => r.status !== 'pass').map((r) => r.name).join(', ')}` });
      this.toRemediation(p, w, 'gates', { gateCommit: head });
    }
  }

  /** Monotonic per-item counter (number of times the item entered a phase) used to version task keys. */
  private epoch(w: WorkItemRow, kind: string, sinceUnblock = false): number {
    const since = sinceUnblock ? " AND created_at > COALESCE((SELECT MAX(created_at) FROM checkpoints WHERE work_item_id=? AND kind='operator_unblock'), 0)" : '';
    return this.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM checkpoints WHERE work_item_id=? AND kind=?${since}`, ...(sinceUnblock ? [w.id, kind, w.id] : [w.id, kind]))!.n;
  }

  /**
   * Ensure one live task exists for a key family. A dead or cancelled latest task is replaced (bounded);
   * returns null when retries are exhausted so the caller can escalate.
   */
  private ensureFamily(spec: Parameters<Ctx['queue']['enqueue']>[0], maxRetries = 2): TaskRow | null {
    const base = spec.idempotencyKey;
    const latest = this.ctx.queue.latestByPrefix(base);
    if (!latest) return this.ctx.queue.enqueue(spec).task;
    if (!['dead', 'cancelled', 'failed'].includes(latest.status)) return latest;
    if (!latest.processed && latest.status !== 'cancelled') return latest; // let onDead run first
    const n = this.ctx.queue.countByPrefix(base);
    if (n > maxRetries) return null;
    return this.ctx.queue.enqueue({ ...spec, idempotencyKey: `${base}:x${n}` }).task;
  }

  private toRemediation(p: ProjectRow, w: WorkItemRow, reason: 'gates' | 'findings' | 'conflicts' | 'merge_gates' | 'ci', extra: Record<string, unknown> = {}): void {
    const cur = this.store.workItem(w.id)!;
    const rounds = cur.remediation_rounds + 1;
    if (rounds > this.ctx.cfg.limits.maxRemediationRounds) {
      // Park in a state the tick does not re-trigger, then investigate once.
      this.store.transition(w.id, [cur.status], 'remediation', {}, `investigating: remediation rounds exceeded (${reason})`);
      this.requestInvestigation(p, this.store.workItem(w.id)!, `remediation rounds exceeded (${reason})`);
      return;
    }
    if (this.store.transition(w.id, [cur.status], 'remediation', { remediation_rounds: rounds }, reason)) {
      this.store.checkpoint({ projectId: p.id, workItemId: w.id, kind: 'remediation', summary: `round ${rounds}: ${reason}`, data: extra });
    }
  }

  private investigationActive(w: WorkItemRow): boolean {
    return !!this.ctx.db.get("SELECT 1 FROM tasks WHERE work_item_id=? AND kind='investigate' AND (status IN ('queued','running','waiting_message','waiting_capacity') OR (status='succeeded' AND processed=0))", w.id);
  }

  private ensureRemediation(p: ProjectRow, w: WorkItemRow): void {
    if (this.investigationActive(w)) return;
    if (this.ctx.queue.activeForWorkItem(w.id).some((t) => t.kind === 'remediate')) return;
    if (w.status_reason?.startsWith('investigating')) { this.requestInvestigation(p, w, w.status_reason.replace(/^investigating:\s*/, '')); return; }
    const ck = this.store.checkpoints(p.id, w.id, 20).filter((c) => c.kind === 'remediation').at(-1);
    const data = json<Record<string, unknown>>(ck?.data, {});
    // After two rounds with the same agent, bring in a different agent (and preferably provider).
    const fresh = w.remediation_rounds >= 3;
    const agent = fresh ? this.team.ensureAgent(p.id, w.role, { exclude: w.implementer_agent_id ? [w.implementer_agent_id] : [] }) : (w.implementer_agent_id ? this.store.agent(w.implementer_agent_id)! : this.team.ensureAgent(p.id, w.role));
    const t = this.ensureFamily({
      projectId: p.id, kind: 'remediate', role: w.role, agentId: agent.id, workItemId: w.id, idempotencyKey: `remed:${w.id}:e${this.epoch(w, 'remediation')}`,
      input: { round: w.remediation_rounds, reason: w.status_reason, ...data }, complexity: w.remediation_rounds >= 2 ? 'high' : w.complexity, priority: w.priority,
      excludeProviders: fresh && w.implementer_provider ? [w.implementer_provider] : [], workspacePath: this.ws(p).wtPath(w.key),
    });
    if (!t) this.requestInvestigation(p, w, 'remediation task repeatedly failed or was cancelled');
  }

  private ensureReviews(p: ProjectRow, w: WorkItemRow): void {
    const head = w.head_commit!;
    const blockingOpen = this.store.findings(p.id, { workItemId: w.id, statuses: ['open', 'fixed_claimed'] }).filter((f) => isBlocking(f.severity));
    const excludeAgents = [w.implementer_agent_id].filter(Boolean) as string[];
    const excludeProviders = this.ctx.cfg.routing.crossProviderReview && w.implementer_provider ? [w.implementer_provider] : [];
    const ep = this.epoch(w, 'in_review');
    const fam = (k: string) => `${k}:${w.id}:${head.slice(0, 12)}:e${ep}`;
    const escalate = (t: TaskRow | null, kind: string) => { if (!t) this.block(p, w, `${kind} repeatedly failed or was cancelled`); };
    if (blockingOpen.length) {
      const reviewerId = blockingOpen[0]!.reviewer_agent_id;
      const reviewer = reviewerId && !excludeAgents.includes(reviewerId) ? this.store.agent(reviewerId)! : this.team.ensureAgent(p.id, 'code_reviewer', { exclude: excludeAgents });
      escalate(this.ensureFamily({ projectId: p.id, kind: 'verify_fix', role: reviewer.role, agentId: reviewer.id, workItemId: w.id, idempotencyKey: fam('verify'),
        input: { head, findingIds: blockingOpen.map((f) => f.id), since: blockingOpen[0]!.commit_sha }, readOnly: true, excludeAgents, excludeProviders, complexity: w.complexity, priority: w.priority }), 'verify_fix');
      return;
    }
    if (this.ctx.queue.latestByPrefix(fam('review'))) {
      const rev = this.ctx.queue.latestByPrefix(fam('review'))!;
      escalate(this.ensureFamily({ projectId: p.id, kind: 'review', role: 'code_reviewer', agentId: this.team.ensureAgent(p.id, 'code_reviewer', { exclude: [...excludeAgents, rev.agent_id ?? ''] }).id, workItemId: w.id, idempotencyKey: fam('review'),
        input: json(rev.input, {}), readOnly: true, excludeAgents, excludeProviders, complexity: w.complexity, priority: w.priority }), 'review');
      const sec = this.ctx.queue.latestByPrefix(fam('secreview'));
      if (sec) escalate(this.ensureFamily({ projectId: p.id, kind: 'security_review', role: 'security_engineer', agentId: this.team.ensureAgent(p.id, 'security_engineer', { exclude: [...excludeAgents, sec.agent_id ?? ''] }).id, workItemId: w.id, idempotencyKey: fam('secreview'),
        input: json(sec.input, {}), readOnly: true, excludeAgents, excludeProviders, complexity: 'high', priority: w.priority }), 'security_review');
      return;
    }
    this.job(`reviewplan:${w.id}:${head}:e${ep}`, p.id, async () => {
      const ws = this.ws(p);
      const files = await ws.changedFiles(ws.wtPath(w.key), p.default_branch, head);
      const d = await ws.diff(ws.wtPath(w.key), p.default_branch, head, 20_000);
      const needsSecurity = securitySensitive(files, d.text) || this.ctx.policy.touchesProtected(files).length > 0 || w.role === 'security_engineer';
      const reviewer = this.team.ensureAgent(p.id, 'code_reviewer', { exclude: excludeAgents });
      this.ctx.queue.enqueue({ projectId: p.id, kind: 'review', role: 'code_reviewer', agentId: reviewer.id, workItemId: w.id, idempotencyKey: fam('review'),
        input: { head, files }, readOnly: true, excludeAgents, excludeProviders, complexity: w.complexity, priority: w.priority });
      if (needsSecurity) {
        const sec = this.team.ensureAgent(p.id, 'security_engineer', { exclude: excludeAgents });
        this.ctx.queue.enqueue({ projectId: p.id, kind: 'security_review', role: 'security_engineer', agentId: sec.id, workItemId: w.id, idempotencyKey: fam('secreview'),
          input: { head, files }, readOnly: true, excludeAgents, excludeProviders, complexity: 'high', priority: w.priority });
      }
    });
  }

  /** After a review-type task completes: decide remediation vs merge once all reviews for the head are in. */
  private concludeReview(p: ProjectRow, w: WorkItemRow, currentTaskId: string): void {
    const head = w.head_commit!;
    const ep = this.epoch(w, 'in_review');
    const keys = ['review', 'secreview', 'verify'].map((k) => `${k}:${w.id}:${head.slice(0, 12)}:e${ep}`);
    const tasks = keys.map((k) => this.ctx.queue.latestByPrefix(k)).filter((t): t is TaskRow => !!t);
    if (!tasks.length) return;
    // Every sibling must have succeeded AND had its findings recorded (processed), except the one being processed now.
    if (tasks.some((t) => t.status !== 'succeeded' || (!t.processed && t.id !== currentTaskId))) return;
    const blocking = this.store.findings(p.id, { workItemId: w.id, statuses: ['open', 'fixed_claimed'] }).filter((f) => isBlocking(f.severity));
    if (blocking.length) this.toRemediation(p, w, 'findings', { findingIds: blocking.map((f) => f.id) });
    else if (this.store.transition(w.id, ['in_review'], 'merge_ready', { reviewed_commit: head })) {
      this.store.checkpoint({ projectId: p.id, workItemId: w.id, kind: 'review_passed', summary: `${w.key} approved at ${head.slice(0, 8)} by ${tasks.map((t) => `${t.kind}@${t.provider}`).join(', ')}` });
    }
  }

  // ---------------------------------------------------------------- merge
  /**
   * A rejected push is never retried in a tight loop. Credential/permission rejections block the item at once with the
   * exact operator action; other failures back off exponentially (30 s → 30 min) and block after 5 consecutive failures.
   */
  private onPushFailure(p: ProjectRow, w: WorkItemRow, message: string): void {
    this.store.checkpoint({ projectId: p.id, workItemId: w.id, kind: 'push_failed', summary: message.slice(0, 1000) });
    this.ctx.events.emit('git.push_failed', `${w.key}: push failed: ${message.slice(0, 300)}`, { projectId: p.id, level: 'warn' });
    if (/without `?workflow`? scope/i.test(message)) {
      this.block(p, w, `GitHub refused the push because it changes .github/workflows and the token lacks the \`workflow\` scope. Add the \`workflow\` scope to the PAT (or drop the workflow change), then run \`orchestrator unblock ${w.key} --note "token has workflow scope"\``);
      return;
    }
    if (/could not read Username|Authentication failed|Invalid username or token|returned error: 40[13]|Permission to .* denied/i.test(message)) {
      this.block(p, w, `GitHub rejected the push credentials (${message.slice(0, 160)}). Check the token in ORCH_HOME/secrets/github-token (classic PAT: repo, project, workflow scopes), then run \`orchestrator unblock ${w.key} --note "token fixed"\``);
      return;
    }
    const n = this.epoch(w, 'push_failed', true);
    if (n >= 5) { this.block(p, w, `push failed ${n} times since the last operator unblock: ${message.slice(0, 200)}`); return; }
    this.pushRetryAt.set(w.id, this.ctx.clock.now() + Math.min(30 * 60_000, 30_000 * 2 ** (n - 1)));
  }

  private async merge(p: ProjectRow, w0: WorkItemRow): Promise<void> {
    const w = this.store.workItem(w0.id)!;
    if (w.status !== 'merge_ready') return;
    const ws = this.ws(p);
    // Exact-commit invariant: the commit merged is the commit gated and reviewed.
    if (!(w.head_commit && w.head_commit === w.gated_commit && w.head_commit === w.reviewed_commit)) {
      this.store.transition(w.id, ['merge_ready'], 'gating', { gated_commit: null }, 'commit changed after review; re-verifying');
      return;
    }
    const blocking = this.store.findings(p.id, { workItemId: w.id, statuses: ['open', 'fixed_claimed'] }).filter((f) => isBlocking(f.severity));
    if (blocking.length) { this.store.transition(w.id, ['merge_ready'], 'in_review'); return; }

    const dir = ws.wtPath(w.key);
    // Nothing to integrate (e.g. a defect verified as already resolved): record the current default branch as the result.
    if ((await ws.gitIn(dir, ['merge-base', '--is-ancestor', w.head_commit, p.default_branch], { allowFail: true })).code === 0) {
      const main = await ws.head();
      this.store.transition(w.id, ['merge_ready'], 'merged', { merged_commit: main }, 'no changes to integrate (verified no-op)');
      return;
    }
    // Bring the default branch into the task branch first so the merged result is what was verified.
    const before = await ws.head(dir);
    const patchBefore = await patchId(ws, dir, p.default_branch, before);
    const m = await ws.mergeDefaultInto(dir);
    if (!m.ok) {
      this.toRemediation(p, w, 'conflicts', { conflicts: m.conflicts });
      return;
    }
    const after = await ws.head(dir);
    if (after !== before) {
      const patchAfter = await patchId(ws, dir, p.default_branch, after);
      // A clean merge that leaves the item's own diff unchanged keeps the review approval; gates re-run.
      const carry = patchBefore && patchBefore === patchAfter ? { reviewed_commit: after } : {};
      this.store.transition(w.id, ['merge_ready'], 'gating', { head_commit: after, gated_commit: null, ...carry }, 'updated with default branch; re-running gates');
      return;
    }

    if (p.repo_mode === 'github') {
      const gh = this.ctx.github(p.id);
      if (!gh) { this.block(p, w, 'GitHub mode but GitHub client unavailable (token missing?)'); return; }
      if ((this.pushRetryAt.get(w.id) ?? 0) > this.ctx.clock.now()) return; // backing off after a failed push
      try {
        await ws.push(w.branch!, true);
        this.pushRetryAt.delete(w.id);
      } catch (e) {
        this.onPushFailure(p, w, (e as Error).message);
        return;
      }
      const pr = await gh.ensurePullRequest(w, p.default_branch);
      this.store.transition(w.id, ['merge_ready'], 'merging', { pr_number: pr.number }, `PR #${pr.number} awaiting checks`);
      this.ctx.events.audit('supervisor', 'git.push', { projectId: p.id, target: w.branch, detail: { pr: pr.number, sha: w.head_commit } });
      return;
    }

    // Local mode: merge, then verify the merged commit with gates before accepting it.
    const staged = await ws.stageMerge(w.branch!);
    if (!staged.ok) { this.toRemediation(p, w, 'conflicts', { conflicts: staged.conflicts }); return; }
    const prevMain = await ws.head();
    const mergeSha = await ws.commitMerge(`Merge ${w.key}: ${w.title}`);
    const s = await runGates(this.ctx, { projectId: p.id, workItemId: w.id, scope: 'merge', cwd: ws.integration, commit: mergeSha, gates: this.store.settings(p).gates, gitDir: this.ws(p).bare });
    if (!s.passed) {
      await ws.gitIn(ws.integration, ['reset', '--hard', prevMain]);
      this.store.checkpoint({ projectId: p.id, workItemId: w.id, kind: 'merge_gate_failure', summary: `merge verification failed: ${s.results.filter((r) => r.status !== 'pass').map((r) => r.name).join(', ')}` });
      this.toRemediation(p, w, 'merge_gates', { gateCommit: mergeSha });
      return;
    }
    this.store.transition(w.id, ['merge_ready'], 'merged', { merged_commit: mergeSha });
    this.ctx.events.audit('supervisor', 'git.merge', { projectId: p.id, target: w.key, detail: { branch: w.branch, reviewed: w.reviewed_commit, merge: mergeSha } });
  }

  private async continueRemoteMerge(p: ProjectRow, w: WorkItemRow): Promise<void> {
    const gh = this.ctx.github(p.id);
    if (!gh || !w.pr_number || !w.head_commit) return;
    const approvalKey = `human-review:${p.id}:${w.key}:${w.head_commit}`;
    const appr = this.ctx.policy.status(approvalKey);
    if (appr?.status === 'pending') return;
    // Idempotent after crashes: an already-merged PR is recorded, a closed one is never reused.
    const state = await gh.pullState(w.pr_number);
    if (state.merged) {
      this.store.transition(w.id, ['merging'], 'merged', { merged_commit: state.mergeSha ?? w.head_commit }, 'PR already merged');
    } else {
      if (state.state === 'closed') { gh.forgetPullRequest(w.key); this.store.transition(w.id, ['merging'], 'merge_ready', { pr_number: null }, `PR #${w.pr_number} was closed without merging; opening a new one`); return; }
      const checks = await gh.checks(w.head_commit);
      if (checks === 'pending') return;
      if (checks === 'failure') { this.toRemediation(p, w, 'ci', { pr: w.pr_number }); return; }
      const r = await gh.merge(w.pr_number, w.head_commit);
      if (!r.merged) {
        if (r.needsHuman) {
          if (appr?.status === 'approved') {
            // The operator approved here, but GitHub still demands a review: the orchestrator never impersonates one.
            this.store.checkpoint({ projectId: p.id, workItemId: w.id, kind: 'merge_rejected_after_approval', summary: r.reason });
            if (this.epoch(w, 'merge_rejected_after_approval', true) >= 3) this.block(p, w, `PR #${w.pr_number} still requires a GitHub review after operator approval: review it on GitHub, then run \`orchestrator unblock ${w.key} --note "reviewed on GitHub"\` to retry the merge`);
            return;
          }
          this.ctx.policy.request('human_review_required', `PR #${w.pr_number} (${w.key}) requires a human review per repository rules: ${r.reason}. Review and approve the PR on GitHub first (the orchestrator never impersonates reviewers), then approve here to let the merge proceed.`, { projectId: p.id, requestedBy: 'supervisor', dedup: approvalKey, payload: { pr: w.pr_number } });
          this.store.patchWorkItem(w.id, { status_reason: `awaiting required human review on PR #${w.pr_number}` });
        } else {
          this.store.checkpoint({ projectId: p.id, workItemId: w.id, kind: 'merge_rejected', summary: r.reason });
          if (this.epoch(w, 'merge_rejected', true) >= 3) this.block(p, w, `merge rejected 3 times since the last operator unblock: ${r.reason}`);
          else this.store.transition(w.id, ['merging'], 'merge_ready', {}, `merge rejected: ${r.reason}`);
        }
        return;
      }
      // Record the merge before any further network operation so a crash cannot cause a second merge attempt.
      this.store.transition(w.id, ['merging'], 'merged', { merged_commit: r.sha });
      this.ctx.events.audit('supervisor', 'github.merge', { projectId: p.id, target: `PR#${w.pr_number}`, detail: { sha: w.head_commit, merge: r.sha } });
    }
    // Post-merge sync and gates happen in finalize(), which retries until they succeed.
  }

  /** GitHub mode: the local default branch must match the remote and pass gates before an item is done. */
  private async postMergeVerify(p: ProjectRow, w: WorkItemRow): Promise<void> {
    if (this.epoch(w, 'post_merge_verified') > 0) return;
    const ws = this.ws(p);
    const main = await ws.syncDefaultFromRemote(); // throws → job error → retried next tick (item stays merged)
    const s = await runGates(this.ctx, { projectId: p.id, workItemId: w.id, scope: 'post-merge', cwd: ws.integration, commit: main, gates: this.store.settings(p).gates, gitDir: this.ws(p).bare });
    if (!s.passed) this.createDefect(p, { title: `Default branch fails quality gates after merging ${w.key}`, description: failedGateText(s), severity: 'high', paths: json(w.paths, []), source: 'post-merge-gates', acceptance: ['All required quality gates pass on the default branch'] });
    this.store.checkpoint({ projectId: p.id, workItemId: w.id, kind: 'post_merge_verified', summary: `default branch synced to ${main.slice(0, 8)}; gates ${s.passed ? 'pass' : 'FAIL (defect opened)'}` });
  }

  private async finalize(p: ProjectRow, w: WorkItemRow): Promise<void> {
    if (p.repo_mode === 'github') await this.postMergeVerify(p, w);
    const evidence = gateEvidence(this.ctx, p.id, w.merged_commit ?? '').map((g) => `${g.name}=${g.status}`).join(',');
    for (const rk of json<string[]>(w.requirement_keys, [])) {
      const all = this.store.workItems(p.id).filter((x) => json<string[]>(x.requirement_keys, []).includes(rk) && x.status !== 'cancelled');
      const done = all.every((x) => x.id === w.id || ['merged', 'done'].includes(x.status));
      this.store.setRequirementStatus(p.id, rk, done ? 'implemented' : 'open', [{ workItem: w.key, commit: w.merged_commit?.slice(0, 12), gates: evidence }]);
    }
    await this.ws(p).removeWorktree(w.key).catch(() => undefined);
    this.store.transition(w.id, ['merged'], 'done');
  }

  // ---------------------------------------------------------------- messages
  private processMessages(p: ProjectRow): void {
    for (const m of this.bus.actionablePending(p.id)) {
      if (!this.bus.claim(m.id)) continue;
      if (m.type === 'transfer') { this.bus.setState(m.id, 'processed'); continue; } // applied by the sender's result handler
      const recipientRole = m.type === 'blocker' ? 'engineering_director' : (m.recipient_role ?? 'engineering_director');
      const recipient = m.recipient_agent_id ? this.store.agent(m.recipient_agent_id)! : this.team.ensureAgent(p.id, recipientRole, { exclude: [m.sender_agent_id] });
      const t = m.task_id ? this.ctx.queue.get(m.task_id) : undefined;
      this.ctx.queue.enqueue({ projectId: p.id, kind: 'answer', role: recipient.role, agentId: recipient.id, workItemId: t?.work_item_id ?? null, idempotencyKey: `answer:${m.id}`,
        input: { messageId: m.id }, readOnly: true, complexity: 'medium', priority: 0, excludeProviders: t?.provider ? [t.provider] : [] });
    }
    // Expired (too deep) blocking questions get a deterministic reply so the asker can continue.
    for (const m of this.ctx.db.all<{ id: string; sender_agent_id: string; task_id: string | null; correlation_id: string; depth: number }>(
      "SELECT * FROM messages q WHERE project_id=? AND state='expired' AND blocking=1 AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.reply_to=q.id)", p.id)) {
      this.bus.post({ projectId: p.id, taskId: null, senderAgentId: 'supervisor', toAgentId: m.sender_agent_id, type: 'answer', replyTo: m.id, correlationId: m.correlation_id, depth: m.depth,
        body: 'No answer available: the delegation depth limit was reached. Proceed with your best judgment, document assumptions in notes, and flag risks.' });
      if (m.task_id) this.maybeWakeAsker(m.task_id);
    }
    // Stalled waits: a question unanswered for too long is released the same way.
    const stall = this.ctx.clock.now() - this.ctx.cfg.supervisor.stallMs;
    for (const t of this.ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE project_id=? AND status='waiting_message' AND updated_at < ?", p.id, stall)) {
      const pending = this.bus.unansweredBlocking(t.id);
      const answering = pending.some((q) => { const at = this.ctx.queue.byKey(`answer:${q.id}`); return at && ['queued', 'running', 'waiting_capacity'].includes(at.status); });
      if (answering) continue;
      for (const q of pending) this.bus.post({ projectId: p.id, taskId: null, senderAgentId: 'supervisor', toAgentId: t.agent_id, type: 'answer', replyTo: q.id, correlationId: q.correlation_id, body: 'No answer arrived in time. Proceed with documented assumptions.' });
      this.maybeWakeAsker(t.id);
    }
  }

  private maybeWakeAsker(taskId: string): void {
    const t = this.ctx.queue.get(taskId);
    if (!t || t.status !== 'waiting_message') return;
    if (this.bus.unansweredBlocking(taskId).length) return;
    this.ctx.queue.updateInput(taskId, { resume_reason: 'answers to your questions arrived (see New information)' });
    this.ctx.queue.wake(taskId, ['waiting_message']);
    this.ctx.events.emit('task.resumed', `task ${t.kind} resumed after answers`, { projectId: t.project_id, taskId });
  }

  /** Post agent-authored messages from a result; returns ids of blocking questions created. */
  postOutbound(task: TaskRow, msgs: Array<{ to_role: string; type: string; body: string; blocking: boolean }> | undefined): string[] {
    const blocking: string[] = [];
    const parentDepth = (() => { const i = json<{ messageId?: string }>(task.input, {}); return i.messageId ? (this.bus.get(i.messageId)?.depth ?? 0) + 1 : 0; })();
    for (const m of msgs ?? []) {
      if (!m?.body) continue;
      const role = String(m.to_role || 'engineering_director').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      const r = this.bus.post({ projectId: task.project_id, taskId: task.id, senderAgentId: task.agent_id ?? 'unknown', toRole: role, type: m.type as never, body: m.body, blocking: !!m.blocking && ACTIONABLE.has(m.type as never), depth: parentDepth });
      if (r.message && m.blocking && ACTIONABLE.has(m.type as never) && r.message.state !== 'expired') blocking.push(r.message.id);
      if (r.message && r.message.state === 'expired' && m.blocking) blocking.push(r.message.id);
    }
    return blocking;
  }

  // ---------------------------------------------------------------- GitHub
  private syncGitHub(p: ProjectRow): void {
    const gh = this.ctx.github(p.id);
    if (!gh) return;
    const last = this.lastSync.get(p.id) ?? 0;
    if (this.ctx.clock.now() - last < 60_000) return;
    this.lastSync.set(p.id, this.ctx.clock.now());
    this.job(`ghsync:${p.id}`, p.id, async () => {
      for (const c of await gh.reconcileExternal(this.store)) {
        const w = this.store.workItemByKey(p.id, c.key)!;
        const integrating = ['merge_ready', 'merging', 'merged', 'done'].includes(w.status);
        if (c.change === 'closed_not_planned' && !integrating && w.status !== 'cancelled') {
          // An operator descoping work on GitHub is an authorized requirement change: honour and record it.
          this.store.transition(w.id, [w.status], 'cancelled', {}, 'closed as not planned on GitHub by operator');
          this.ctx.queue.cancelForWorkItem(w.id, 'cancelled on GitHub');
          this.ctx.events.audit('github', 'workitem.descoped', { projectId: p.id, target: w.key });
        } else if (c.change === 'reopened' && ['cancelled', 'merged', 'done'].includes(w.status)) {
          // A human reopened an issue the orchestrator had closed: the work is wanted (again). Dependencies re-resolve.
          this.store.transition(w.id, [w.status], 'backlog', { remediation_rounds: 0 }, `reopened on GitHub (was ${w.status})`);
          this.ctx.events.audit('github', 'workitem.reopened', { projectId: p.id, target: w.key, detail: { from: w.status } });
          this.ctx.events.emit('workitem.reopened', `${w.key} reopened on GitHub (was ${w.status})`, { projectId: p.id, level: 'warn' });
        } else {
          // Anything else (closed as completed without verification, descoping work already being integrated, a reopen of
          // an item that is still in progress): local state is authoritative; the next sync restores the issue state.
          this.store.patchWorkItem(w.id, {});
          this.ctx.events.audit('github', 'workitem.external_change_reverted', { projectId: p.id, target: w.key, detail: { change: c.change, status: w.status } });
          this.ctx.events.emit('github.warn', `${w.key}: ${c.change.replace(/_/g, ' ')} on GitHub ignored while ${w.status}; issue state will be restored`, { projectId: p.id, level: 'warn' });
        }
      }
      await gh.syncAll(this.store);
    });
  }

  // ---------------------------------------------------------------- defects
  createDefect(p: ProjectRow, d: { title: string; description: string; severity: string; paths: string[]; source: string; acceptance: string[]; requirementKeys?: string[]; role?: string }): WorkItemRow {
    const key = this.store.nextKey(p.id, 'D');
    const w = this.store.createWorkItem(p.id, {
      key, type: 'defect', title: d.title, description: `${d.description}\n\nSeverity: ${d.severity}. Source: ${d.source}.`, acceptance: d.acceptance.length ? d.acceptance : ['The defect is fixed and covered by a regression test'],
      requirement_keys: d.requirementKeys ?? [], depends_on: [], paths: d.paths, role: d.role ?? guessRole(d.paths), complexity: SEVERITY_RANK[d.severity as Severity] >= 3 ? 'high' : 'medium',
      priority: SEVERITY_RANK[d.severity as Severity] >= 3 ? 0 : 1, milestone: 'Remediation', source: d.source,
    });
    for (const rk of d.requirementKeys ?? []) this.store.setRequirementStatus(p.id, rk, 'open');
    this.ctx.events.emit('defect.created', `${key}: ${d.title}`, { projectId: p.id, level: 'warn' });
    return w;
  }

  private requestInvestigation(p: ProjectRow, w: WorkItemRow, why: string): void {
    if (['done', 'merged', 'cancelled', 'blocked'].includes(this.store.workItem(w.id)?.status ?? 'cancelled')) return;
    if (this.investigationActive(w)) return; // single-flight
    const n = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE work_item_id=? AND kind='investigate' AND status IN ('succeeded','dead') AND created_at > COALESCE((SELECT MAX(created_at) FROM checkpoints WHERE work_item_id=? AND kind='operator_unblock'), 0)", w.id, w.id)!.n;
    if (n >= 3) { this.block(p, w, `repeated failures after ${n} investigations: ${why}`); return; }
    this.ctx.queue.cancelForWorkItem(w.id, 'superseded by investigation');
    this.ctx.queue.enqueue({ projectId: p.id, kind: 'investigate', role: 'engineering_director', agentId: this.team.ensureAgent(p.id, 'engineering_director').id, workItemId: w.id,
      idempotencyKey: `inv:${w.id}:${this.ctx.queue.countByPrefix(`inv:${w.id}`) + 1}`, input: { why }, readOnly: true, complexity: 'high', priority: 0 });
    this.store.patchWorkItem(w.id, { status_reason: `investigating: ${why}` });
  }

  // ---------------------------------------------------------------- audits / release
  private advanceAuditing(p: ProjectRow): void {
    const audit = this.ctx.db.get<{ id: string; status: string; round: number; commit_sha: string | null }>("SELECT * FROM audits WHERE project_id=? AND kind='completion' ORDER BY created_at DESC LIMIT 1", p.id);
    if (!audit) { this.store.setProjectStatus(p.id, 'active'); return; }
    if (audit.status === 'pending') {
      this.job(`integration:${p.id}`, p.id, async () => {
        const ws = this.ws(p);
        if (p.repo_mode === 'github') await ws.syncDefaultFromRemote();
        const head = await ws.head();
        const s = await runGates(this.ctx, { projectId: p.id, workItemId: null, scope: 'audit', cwd: ws.integration, commit: head, gates: this.store.settings(p).gates, gitDir: this.ws(p).bare });
        this.ctx.db.run("UPDATE audits SET status='running', commit_sha=?, result=?, updated_at=? WHERE id=?", head, JSON.stringify({ gatesPassed: s.passed }), this.ctx.clock.now(), audit.id);
        const enabled = [...this.ctx.adapters.keys()].filter((k) => this.ctx.cfg.providers[k]?.enabled && this.ctx.capacity.get(k).status !== 'disabled');
        const pins = enabled.length >= 2 ? [enabled[0]!, enabled[1]!] : [null, null];
        ['a', 'b'].forEach((slot, i) => {
          const agent = this.team.ensureAgent(p.id, i === 0 ? 'quality_engineer' : 'code_reviewer');
          this.ctx.queue.enqueue({ projectId: p.id, kind: 'completion_audit', role: agent.role, agentId: agent.id, idempotencyKey: `caudit:${audit.id}:${slot}`, input: { auditId: audit.id, commit: head },
            readOnly: true, complexity: 'high', priority: 0, providerPinned: pins[i] });
        });
      });
      return;
    }
    if (audit.status !== 'running') return;
    const tasks: TaskRow[] = [];
    for (const [i, slot] of ['a', 'b'].entries()) {
      const base = `caudit:${audit.id}:${slot}`;
      const latest = this.ctx.queue.latestByPrefix(base);
      if (!latest) return;
      if (latest.status === 'succeeded') { if (!latest.processed) return; tasks.push(latest); continue; }
      if (!['dead', 'cancelled', 'failed'].includes(latest.status)) return;
      // Replace a failed auditor (independent agent, any provider) up to twice before concluding without it.
      const agent = this.team.ensureAgent(p.id, i === 0 ? 'quality_engineer' : 'code_reviewer', { exclude: [latest.agent_id ?? ''] });
      const t = this.ensureFamily({ projectId: p.id, kind: 'completion_audit', role: agent.role, agentId: agent.id, idempotencyKey: base, input: json(latest.input, {}), readOnly: true, complexity: 'high', priority: 0 });
      if (t) return;
      tasks.push(latest);
    }
    this.concludeAudit(p, audit.id, audit.commit_sha!, tasks);
  }

  private concludeAudit(p: ProjectRow, auditId: string, commit: string, tasks: TaskRow[]): void {
    const result = json<{ gatesPassed?: boolean }>(this.ctx.db.get<{ result: string }>('SELECT result FROM audits WHERE id=?', auditId)!.result, {});
    const reqs = this.store.requirements(p.id);
    const problems: string[] = [];
    const gaps = new Map<string, string>();
    const defects: Array<{ severity: string; title: string; description: string; paths: string[]; acceptance: string[] }> = [];
    if (!result.gatesPassed) problems.push('required quality gates fail on the audited commit');
    const blockingFindings = this.store.findings(p.id, { statuses: ['open', 'fixed_claimed'] }).filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high);
    if (blockingFindings.length) problems.push(`${blockingFindings.length} critical/high findings remain open`);
    const succeeded = tasks.filter((t) => t.status === 'succeeded');
    if (succeeded.length < 2) problems.push(`independent auditor(s) failed: only ${succeeded.length} of 2 completed`);
    for (const t of succeeded) {
      const o = json<any>(t.output, {});
      for (const r of o.requirements ?? []) {
        const req = reqs.find((x) => x.key === r.key);
        if (!req?.mandatory) continue;
        if (r.status === 'unsatisfied') gaps.set(r.key, `${gaps.get(r.key) ? gaps.get(r.key) + ' | ' : ''}${t.provider}: ${r.gap}`);
        if (r.status === 'blocked' && req.status !== 'blocked') gaps.set(r.key, `${t.provider} claims blocked without recorded blocker: ${r.gap}`);
      }
      for (const d of o.defects ?? []) if (SEVERITY_RANK[d.severity as Severity] >= SEVERITY_RANK.medium) defects.push(d);
      if (!o.release_recommended) problems.push(`${t.provider} auditor does not recommend release`);
      // Boolean verdicts are summaries of the auditor's own defects: they never create work items themselves. A false
      // verdict with no concrete defect is an unsupported decline (re-audited with feedback; see below).
      const concrete = (o.defects ?? []).some((d: any) => SEVERITY_RANK[d.severity as Severity] >= SEVERITY_RANK.medium);
      if ((o.docs_accurate === false || o.install_reproducible === false) && !concrete) problems.push(`${t.provider} auditor reported inaccurate docs or non-reproducible install without a concrete defect`);
    }
    for (const r of reqs.filter((x) => x.mandatory)) {
      const covered = (o: TaskRow) => (json<any>(o.output, {}).requirements ?? []).some((x: any) => x.key === r.key);
      if (succeeded.some((t) => !covered(t)) && r.status !== 'blocked') gaps.set(r.key, `${gaps.get(r.key) ?? ''} auditor omitted requirement`.trim());
    }
    const declines = succeeded.filter((t) => { const o = json<any>(t.output, {}); return !o.release_recommended || o.docs_accurate === false || o.install_reproducible === false; });
    const onlyDeclines = !gaps.size && !defects.length && problems.length > 0 && problems.every((x) => x.endsWith('does not recommend release') || x.endsWith('without a concrete defect') || x.startsWith('independent auditor(s) failed'));
    if (onlyDeclines) {
      // A decline without a concrete unsatisfied requirement or defect is not actionable: re-audit with feedback, then escalate.
      const prev = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audits WHERE project_id=? AND kind='completion' AND status='inconclusive' AND created_at > COALESCE((SELECT MAX(created_at) FROM audits WHERE project_id=? AND kind='completion' AND status IN ('failed','passed')), 0)", p.id, p.id)!.n;
      const feedback = declines.map((t) => `${t.provider} auditor declined without concrete findings: ${String(json<any>(t.output, {}).summary).slice(0, 600)}`);
      this.ctx.db.run("UPDATE audits SET status='inconclusive', result=?, updated_at=? WHERE id=?", JSON.stringify({ ...result, problems, feedback }), this.ctx.clock.now(), auditId);
      if (prev + 1 >= 2) { this.store.setProjectStatus(p.id, 'blocked', 'completion auditors repeatedly declined release without citing concrete gaps; operator review required'); return; }
      this.store.setProjectStatus(p.id, 'active', 'completion audit inconclusive; re-auditing with feedback');
      this.ctx.events.emit('audit.inconclusive', `completion audit inconclusive (decline without concrete findings); re-auditing`, { projectId: p.id, level: 'warn' });
      return;
    }
    const pass = !problems.length && !gaps.size && !defects.length;
    this.ctx.db.run('UPDATE audits SET status=?, result=?, updated_at=? WHERE id=?', pass ? 'passed' : 'failed',
      JSON.stringify({ ...result, problems, gaps: Object.fromEntries(gaps), defects: defects.map((d) => d.title), auditors: succeeded.map((t) => t.provider) }), this.ctx.clock.now(), auditId);
    if (pass) {
      for (const r of reqs) if (r.status !== 'blocked') this.store.setRequirementStatus(p.id, r.key, 'verified', [{ audit: auditId, commit: commit.slice(0, 12) }]);
      this.store.setProjectStatus(p.id, 'releasing', 'completion audit passed');
      this.ctx.events.emit('audit.passed', `completion audit passed on ${commit.slice(0, 8)} (${succeeded.map((t) => t.provider).join(' + ')})`, { projectId: p.id });
      return;
    }
    // Reopen development with concrete remediation work.
    for (const [key, gap] of gaps) {
      const r = reqs.find((x) => x.key === key)!;
      this.createDefect(p, { title: `Requirement ${key} not satisfied: ${r.title}`, description: `Completion audit gap: ${gap}`, severity: 'high', paths: [], source: 'completion-audit', acceptance: json<string[]>(r.acceptance, []), requirementKeys: [key] });
    }
    for (const d of defects) this.createDefect(p, { ...d, source: 'completion-audit' });
    if (!result.gatesPassed && !gaps.size && !defects.length) this.createDefect(p, { title: 'Quality gates fail on default branch', description: 'Required gates failed during the completion audit.', severity: 'high', paths: [], source: 'completion-audit', acceptance: ['All required gates pass on the default branch'] });
    if (blockingFindings.length && !gaps.size && !defects.length) for (const f of blockingFindings) this.createDefect(p, { title: f.title, description: f.explanation, severity: f.severity, paths: json<Array<{ path: string }>>(f.locations, []).map((l) => l.path), source: 'completion-audit', acceptance: [f.verification] });
    this.store.setProjectStatus(p.id, 'active', `completion audit failed: ${[...problems, ...[...gaps.keys()].map((k) => `${k} unsatisfied`)].join('; ').slice(0, 500)}`);
    this.ctx.events.emit('audit.failed', `completion audit failed; reopened development (${gaps.size} gaps, ${defects.length} defects)`, { projectId: p.id, level: 'warn' });
  }

  private advanceReleasing(p: ProjectRow): void {
    this.job(`integration:${p.id}`, p.id, async () => {
      const audit = this.ctx.db.get<{ commit_sha: string }>("SELECT commit_sha FROM audits WHERE project_id=? AND kind='completion' AND status='passed' ORDER BY created_at DESC LIMIT 1", p.id);
      const ws = this.ws(p);
      const head = await ws.head();
      if (!audit || audit.commit_sha !== head) { this.store.setProjectStatus(p.id, 'active', 'default branch moved after audit; re-auditing'); return; }
      const settings = this.store.settings(p);
      const n = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM releases WHERE project_id=? AND status='verified'", p.id)!.n;
      const version = settings.version ?? `0.${n + 1}.0`;
      const out = await buildAndVerifyRelease(this.ctx, this.store, p, ws, head, version);
      if (!out.ok) {
        this.createDefect(p, { title: `Release package verification failed (${version})`, description: out.problems.join('\n'), severity: 'high', paths: [], source: 'release', acceptance: ['Release package builds, contains no secrets, and installs from a clean environment using the documented procedure'] });
        this.store.setProjectStatus(p.id, 'active', `release verification failed: ${out.problems.join('; ').slice(0, 300)}`);
        return;
      }
      const gh = this.ctx.github(p.id);
      let url: string | null = null;
      if (gh && this.ctx.cfg.github.allowPublishRelease) {
        url = await gh.publishRelease(`v${version}`, head, `${p.name} v${version}`, `Verified release built from ${head}.`, out.zipPath!, `${out.zipPath}.sha256`).catch((e) => { this.ctx.events.emit('github.warn', `release publish failed: ${(e as Error).message}`, { projectId: p.id, level: 'warn' }); return null; });
        if (url) this.ctx.db.run("UPDATE releases SET github_release_url=?, status='published' WHERE id=?", url, out.releaseId);
      }
      const blocked = this.store.requirements(p.id).filter((r) => r.mandatory && r.status === 'blocked');
      if (blocked.length) this.store.setProjectStatus(p.id, 'blocked', `partial release ${version}: blocked requirements ${blocked.map((r) => r.key).join(', ')}`);
      else this.store.setProjectStatus(p.id, 'completed', `verified release ${version}: ${out.zipPath}${url ? ` (${url})` : ''}`);
      this.ctx.events.emit('project.completed', `release ${version} verified at ${out.zipPath}`, { projectId: p.id });
    });
  }

  // ---------------------------------------------------------------- task outcomes
  /** Apply a succeeded task's validated output. Idempotent (may be replayed after a crash). */
  async onSuccess(task: TaskRow): Promise<void> {
    const p = this.store.project(task.project_id)!;
    const out = json<any>(task.output, {});
    const w = task.work_item_id ? this.store.workItem(task.work_item_id) : undefined;
    if (task.agent_id) this.team.setStatus(task.agent_id, 'idle');
    switch (task.kind) {
      case 'plan': return this.applyPlan(p, task, out);
      case 'implement':
      case 'remediate': {
        if (!w) return;
        this.postOutbound(task, out.messages);
        const transfer = (out.messages ?? []).find((m: any) => m.type === 'transfer');
        if (out.status === 'blocked') {
          // "Blocked" is a claim. If the worktree holds changes (or an in-progress merge the agent cannot finish
          // because git is read-only for it), deterministic gates and independent review decide instead.
          const ws0 = this.ws(p);
          const dir0 = ws0.wtPath(w.key);
          const mergeInProgress = existsSync(join(ws0.bare, 'worktrees', w.key, 'MERGE_HEAD'));
          if (!(mergeInProgress || (await ws0.isDirty(dir0).catch(() => false)))) {
            this.requestInvestigation(p, w, `agent reported blocked: ${String(out.notes).slice(0, 500)}`);
            return;
          }
          this.store.checkpoint({ projectId: p.id, workItemId: w.id, taskId: task.id, kind: 'blocked_claim_overridden', summary: `agent said blocked but left changes${mergeInProgress ? ' (merge in progress)' : ''}; verifying with gates and review: ${String(out.notes).slice(0, 300)}` });
        }
        if (transfer && task.kind === 'implement') {
          const history = json<string[]>(json<any>(task.input, {}).transfers ?? '[]', []);
          const toRole = String(transfer.to_role).toLowerCase();
          if (MessageBus.transferAllowed([...history, w.role], toRole)) {
            this.store.patchWorkItem(w.id, { role: toRole });
            const agent = this.team.ensureAgent(p.id, toRole);
            this.ctx.queue.enqueue({ projectId: p.id, kind: 'implement', role: toRole, agentId: agent.id, workItemId: w.id, idempotencyKey: `impl:${w.id}:transfer:${task.id}`,
              input: { transfers: [...history, w.role], guidance: `Transferred from ${w.role}: ${transfer.body}` }, complexity: w.complexity, priority: w.priority, workspacePath: this.ws(p).wtPath(w.key) });
            this.store.patchWorkItem(w.id, { implementer_agent_id: agent.id });
            return;
          }
          this.ctx.events.emit('message.transfer_rejected', `transfer of ${w.key} to ${toRole} rejected (cycle/limit)`, { projectId: p.id, level: 'warn' });
        }
        const ws = this.ws(p);
        const dir = ws.wtPath(w.key);
        const sha = await ws.commitAll(dir, `${task.kind === 'implement' ? 'feat' : 'fix'}(${w.key}): ${(out.summary ?? w.title).split('\n')[0].slice(0, 72)}\n\nAgent: ${task.agent_id} via ${task.provider}\nTask: ${task.id}`);
        const head = await ws.head(dir);
        if (task.kind === 'implement' && head === w.base_commit) {
          if (w.type === 'defect' && out.status === 'completed') {
            // "Already resolved" is a claim: verify it with gates + independent review instead of trusting it.
            this.store.transition(w.id, ['implementing'], 'gating', { head_commit: head, gated_commit: null, implementer_provider: task.provider }, 'no change required per implementer; verifying the defect is already resolved');
            this.store.checkpoint({ projectId: p.id, workItemId: w.id, taskId: task.id, kind: 'implement', summary: `no-change resolution claimed: ${String(out.summary).slice(0, 400)}` });
            return;
          }
          this.requestInvestigation(p, w, 'implementation produced no changes');
          return;
        }
        if (task.kind === 'remediate') for (const fid of out.addressed_finding_ids ?? []) {
          const f = this.ctx.db.get<FindingRow>('SELECT * FROM findings WHERE id=? AND work_item_id=?', fid, w.id);
          if (f && f.status === 'open') this.store.setFindingStatus(f.id, 'fixed_claimed', `claimed by ${task.agent_id}: ${out.root_cause}`);
        }
        this.store.transition(w.id, ['implementing', 'remediation'], 'gating', { head_commit: head, gated_commit: null, implementer_provider: task.kind === 'implement' ? task.provider : w.implementer_provider });
        this.store.checkpoint({ projectId: p.id, workItemId: w.id, taskId: task.id, kind: task.kind, summary: `${task.kind} by ${task.agent_id}@${task.provider}: ${String(out.summary).slice(0, 600)}${sha ? ` (commit ${sha.slice(0, 8)})` : ''}`, data: { files: out.files_changed, tests: out.tests_added } });
        return;
      }
      case 'review':
      case 'security_review': {
        if (!w) return;
        for (const f of out.findings ?? []) this.recordFinding(p, task, w, f, 'review');
        this.postOutbound(task, out.messages);
        this.store.checkpoint({ projectId: p.id, workItemId: w.id, taskId: task.id, kind: task.kind, summary: `${task.kind} (${task.provider}) verdict ${out.verdict}: ${String(out.summary).slice(0, 400)}` });
        if (this.store.workItem(w.id)!.status === 'in_review') this.concludeReview(p, this.store.workItem(w.id)!, task.id);
        return;
      }
      case 'verify_fix': {
        if (!w) return;
        const input = json<{ findingIds: string[] }>(task.input, { findingIds: [] });
        const resolved = new Set<string>(out.resolved_finding_ids ?? []);
        for (const fid of input.findingIds) {
          if (resolved.has(fid)) this.store.setFindingStatus(fid, 'verified', `verified by ${task.agent_id}@${task.provider} at ${w.head_commit?.slice(0, 8)}`);
          else this.store.setFindingStatus(fid, 'open');
        }
        for (const f of out.new_findings ?? []) this.recordFinding(p, task, w, f, 'verify');
        this.postOutbound(task, out.messages);
        if (this.store.workItem(w.id)!.status === 'in_review') this.concludeReview(p, this.store.workItem(w.id)!, task.id);
        return;
      }
      case 'answer': {
        const input = json<{ messageId: string }>(task.input, { messageId: '' });
        const q = this.bus.get(input.messageId);
        if (!q) return;
        this.bus.post({ projectId: p.id, taskId: task.id, senderAgentId: task.agent_id ?? 'unknown', toAgentId: q.sender_agent_id, type: 'answer', replyTo: q.id, correlationId: q.correlation_id, threadId: q.thread_id, depth: q.depth,
          body: `${out.answer}${out.references?.length ? `\nReferences: ${out.references.join(', ')}` : ''} (confidence: ${out.confidence})` });
        this.bus.setState(q.id, 'processed');
        this.postOutbound(task, out.messages);
        if (q.task_id) this.maybeWakeAsker(q.task_id);
        return;
      }
      case 'investigate': {
        if (!w) return;
        this.store.checkpoint({ projectId: p.id, workItemId: w.id, taskId: task.id, kind: 'investigation', summary: `root cause: ${out.root_cause}; strategy: ${out.strategy}`, data: out });
        if (['done', 'merged', 'cancelled', 'blocked'].includes(this.store.workItem(w.id)!.status)) return;
        if (out.strategy === 'block') { this.block(p, w, out.blocker || out.root_cause); return; }
        const role = out.strategy === 'reassign_specialist' && out.recommended_role ? String(out.recommended_role).toLowerCase().replace(/[^a-z0-9_]+/g, '_') : w.role;
        const n = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE work_item_id=? AND kind='implement'", w.id)!.n;
        const agent = this.team.ensureAgent(p.id, role, { exclude: out.strategy === 'retry_same' ? [] : [w.implementer_agent_id ?? ''] });
        this.ctx.db.tx(() => {
          if (!this.store.transition(w.id, ['implementing', 'remediation', 'gating', 'in_review', 'merge_ready', 'merging'], 'implementing', { role, remediation_rounds: 0, gated_commit: null, implementer_agent_id: agent.id }, `restarted after investigation (${out.strategy})`)) return;
          this.ctx.queue.enqueue({ projectId: p.id, kind: 'implement', role, agentId: agent.id, workItemId: w.id, idempotencyKey: `impl:${w.id}:${n + 1}`,
            input: { round: n + 1, guidance: `${out.guidance}\nRoot cause of earlier failures: ${out.root_cause}` }, complexity: 'high', priority: w.priority,
            excludeProviders: out.strategy !== 'retry_same' && w.implementer_provider ? [w.implementer_provider] : [], workspacePath: this.ws(p).wtPath(w.key) });
        });
        return;
      }
      case 'integration_audit':
        for (const i of out.issues ?? []) {
          if (SEVERITY_RANK[i.severity as Severity] < SEVERITY_RANK.medium) continue;
          this.createDefect(p, { title: i.title, description: i.description, severity: i.severity, paths: i.paths ?? [], source: 'integration-audit', acceptance: i.acceptance ?? [], requirementKeys: (i.requirement_keys ?? []).filter((k: string) => this.store.requirement(p.id, k)) });
        }
        return;
      case 'completion_audit':
        return; // concluded deterministically in advanceAuditing once both auditors finish
      default:
        if (task.kind.startsWith('debate_')) {
          const r = this.debate.onResult(task, out);
          if (r.decided) await this.persistAdr(p, r.decided.id, out.adr_markdown);
          if (r.error) this.ctx.events.emit('decision.retry', r.error, { projectId: p.id, level: 'warn' });
        }
    }
  }

  private recordFinding(p: ProjectRow, task: TaskRow, w: WorkItemRow, f: any, source: string): void {
    if (!f?.title) return;
    this.store.addFinding({
      project_id: p.id, work_item_id: w.id, task_id: task.id, reviewer_agent_id: task.agent_id, reviewer_provider: task.provider, commit_sha: w.head_commit,
      severity: (['critical', 'high', 'medium', 'low', 'info'].includes(f.severity) ? f.severity : 'medium') as Severity, category: f.category ?? 'general', title: f.title,
      locations: JSON.stringify(f.locations ?? []), evidence: f.evidence ?? '', explanation: f.explanation ?? '', remediation: f.remediation ?? '', verification: f.verification ?? '', source,
    });
  }

  private async persistAdr(p: ProjectRow, decisionId: string, md: string): Promise<void> {
    const d = this.store.decision(decisionId)!;
    const content = this.debate.adrMarkdown(d, md);
    if (p.repo_mode !== 'local') return; // GitHub mode: ADR ships in the release package and is linked from the decision record
    const ws = this.ws(p);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const dir = join(ws.integration, 'docs', 'adr');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${d.key}.md`);
    writeFileSync(path, content);
    await ws.gitIn(ws.integration, ['add', path]);
    await ws.gitIn(ws.integration, ['commit', '--no-verify', '-m', `docs(adr): ${d.key} ${d.title}`], { allowFail: true });
    this.ctx.db.run('UPDATE decisions SET adr_path=? WHERE id=?', `docs/adr/${d.key}.md`, d.id);
  }

  /** Apply a validated plan (from a plan task, or an operator-supplied plan file). */
  applyPlan(p: ProjectRow, task: TaskRow | { agent_id: string | null; input: string; id: string }, out: any): void {
    const errors = validatePlan(out);
    if (errors.length) {
      const attempt = json<{ attempt: number }>(task.input, { attempt: 0 }).attempt + 1;
      if (attempt >= 3) { this.store.setProjectStatus(p.id, 'blocked', `plan invalid after 3 attempts: ${errors.join('; ').slice(0, 400)}`); return; }
      this.ctx.queue.enqueue({ projectId: p.id, kind: 'plan', role: 'engineering_director', agentId: task.agent_id, idempotencyKey: `plan:${p.id}:${attempt}`,
        input: { attempt, guidance: `Your previous plan was rejected by deterministic validation: ${errors.join('; ')}` }, readOnly: true, complexity: 'high', priority: 0 });
      return;
    }
    this.ctx.db.tx(() => {
      for (const r of out.requirements) this.store.upsertRequirement(p.id, { ...r, acceptance: r.acceptance ?? [] });
      const blocks = new Map<string, string[]>();
      for (const d of out.decisions ?? []) {
        this.debate.create(p.id, d);
        for (const b of d.blocks ?? []) blocks.set(b, [...(blocks.get(b) ?? []), d.key]);
      }
      for (const w of out.work_items) {
        this.store.createWorkItem(p.id, {
          key: w.key, type: w.type, title: w.title, description: w.description, acceptance: w.acceptance, requirement_keys: w.requirement_keys,
          depends_on: [...(w.depends_on ?? []), ...(blocks.get(w.key) ?? [])], paths: w.paths ?? [], role: String(w.role).toLowerCase().replace(/[^a-z0-9_]+/g, '_') || defaultRoleFor('implement'),
          complexity: w.complexity, priority: Math.min(3, Math.max(0, w.priority ?? 1)), milestone: w.milestone || null, source: 'plan',
        });
      }
      this.team.assemble(p.id, out.team ?? []);
      const gates: QualityGate[] = (out.gates ?? []).filter((g: QualityGate) => g.command?.trim()).map((g: QualityGate) => ({ ...g, timeout_sec: g.timeout_sec ?? 900 }));
      const cur = this.store.settings(p);
      this.store.updateSettings(p.id, { gates: cur.gates.length ? cur.gates : gates, verify_commands: cur.verify_commands.length ? cur.verify_commands : out.verify_commands ?? [] });
      this.ctx.db.run('UPDATE projects SET plan=?, name=COALESCE(NULLIF(?, \'\'), name), updated_at=? WHERE id=?', JSON.stringify({ product_name: out.product_name, summary: out.summary, milestones: out.milestones }), out.product_name ?? '', this.ctx.clock.now(), p.id);
      this.store.setProjectStatus(p.id, (out.decisions ?? []).length ? 'debating' : 'active', `planned: ${out.requirements.length} requirements, ${out.work_items.length} work items`);
      this.store.checkpoint({ projectId: p.id, taskId: task.id, kind: 'plan', summary: `plan accepted: ${out.summary}`.slice(0, 1000) });
    });
    this.ctx.events.audit(`agent:${task.agent_id}`, 'plan.accepted', { projectId: p.id, detail: { requirements: out.requirements.length, workItems: out.work_items.length } });
  }

  /** Bounded failure handling once a task exhausted its retries. */
  async onDead(task: TaskRow): Promise<void> {
    const p = this.store.project(task.project_id)!;
    const w = task.work_item_id ? this.store.workItem(task.work_item_id) : undefined;
    if (task.agent_id) this.team.setStatus(task.agent_id, 'idle');
    switch (task.kind) {
      case 'plan': this.store.setProjectStatus(p.id, 'blocked', `planning failed: ${task.error_message}`); return;
      case 'implement': case 'remediate': if (w) this.requestInvestigation(p, w, `${task.kind} failed: ${task.error_class} ${task.error_message?.slice(0, 300)}`); return;
      case 'investigate': if (w) this.block(p, w, `investigation failed: ${task.error_message}`); return;
      case 'review': case 'security_review': case 'verify_fix':
        return; // ensureReviews replaces dead review tasks (bounded) and blocks the item when exhausted
      case 'answer': {
        const q = this.bus.get(json<{ messageId: string }>(task.input, { messageId: '' }).messageId);
        if (q) {
          this.bus.post({ projectId: p.id, taskId: null, senderAgentId: 'supervisor', toAgentId: q.sender_agent_id, type: 'answer', replyTo: q.id, correlationId: q.correlation_id, body: 'The recipient could not answer. Proceed with documented assumptions.' });
          this.bus.setState(q.id, 'processed');
          if (q.task_id) this.maybeWakeAsker(q.task_id);
        }
        return;
      }
      case 'completion_audit': return; // concluded with whatever auditors finished; missing auditor → audit fails and reopens
      case 'integration_audit': return;
      default:
        if (task.kind.startsWith('debate_')) {
          const d = this.store.decision(json<{ decisionId: string }>(task.input, { decisionId: '' }).decisionId);
          if (d) this.ctx.db.run("UPDATE decisions SET status='blocked', rationale=? WHERE id=?", `debate task failed: ${task.error_message}`, d.id);
        }
    }
  }

  // ---------------------------------------------------------------- prepare
  /** Working directory, sandbox mode and kind-specific material for a task about to run. */
  async prepare(task: TaskRow): Promise<{ cwd: string; extra: Record<string, string> }> {
    const p = this.store.project(task.project_id)!;
    const ws = this.ws(p);
    const w = task.work_item_id ? this.store.workItem(task.work_item_id) : undefined;
    const input = json<any>(task.input, {});
    const extra: Record<string, string> = {};
    let cwd = ws.integration;
    if (w && w.branch && ['implement', 'remediate', 'review', 'security_review', 'verify_fix', 'answer', 'investigate'].includes(task.kind)) {
      const r = await ws.worktree(w.key, w.branch, w.base_commit ?? (await ws.head()));
      cwd = r.path;
    }
    switch (task.kind) {
      case 'plan':
        extra.tree = topLevelTree(ws.integration);
        if (input.guidance) extra['Validation feedback'] = input.guidance;
        break;
      case 'remediate': {
        const parts: string[] = [];
        const blocking = this.store.findings(p.id, { workItemId: w!.id, statuses: ['open', 'fixed_claimed'] }).filter((f) => isBlocking(f.severity));
        if (blocking.length) parts.push('### Review findings\n' + blocking.map((f) => `- id ${f.id} [${f.severity}] ${f.title}\n  locations: ${json<Array<{ path: string; line: number }>>(f.locations, []).map((l) => `${l.path}:${l.line}`).join(', ')}\n  ${f.explanation}\n  remediation: ${f.remediation}\n  verify: ${f.verification}`).join('\n'));
        if (input.gateCommit || ['gates', 'merge_gates'].includes(w!.status_reason ?? '')) {
          const fails = this.ctx.db.all<{ name: string; command: string; exit_code: number; output_excerpt: string }>("SELECT * FROM gate_runs WHERE project_id=? AND commit_sha=? AND status != 'pass' AND required=1 ORDER BY started_at DESC LIMIT 5", p.id, input.gateCommit ?? w!.head_commit);
          if (fails.length) parts.push('### Failing quality gates\n' + fails.map((f) => `- ${f.name} (\`${f.command}\`, exit ${f.exit_code})\n\`\`\`\n${f.output_excerpt}\n\`\`\``).join('\n'));
        }
        if (input.conflicts?.length) parts.push(`### Merge conflicts with ${p.default_branch}\nA merge of ${p.default_branch} into this branch is in progress. Edit the files to remove every conflict marker (<<<<<<<, =======, >>>>>>>) in: ${input.conflicts.join(', ')}, keeping both sides' intended behavior, and make the tests pass. Do NOT stage or commit — git is read-only for you; the supervisor completes the merge commit after you finish. Report status "completed" once the files are resolved.`);
        if (input.reason === 'ci' || w!.status_reason === 'ci') parts.push(`### CI checks failed on PR #${w!.pr_number}\nInspect the failing checks' reproduction steps locally (run the project's test commands).`);
        extra.remediation = parts.join('\n\n') || 'Re-run the quality gates and fix whatever fails.';
        break;
      }
      case 'review': case 'security_review': {
        const d = await ws.diff(cwd, p.default_branch, w!.head_commit ?? 'HEAD', this.ctx.cfg.limits.maxDiffChars);
        extra.diff = '```diff\n' + d.text + '\n```';
        extra['Quality gates already run by the supervisor on this exact commit (first-hand evidence; no need to re-run them)'] =
          gateEvidence(this.ctx, p.id, w!.head_commit ?? '').map((g) => `- ${g.name}: ${g.status} (\`${g.command}\`, exit ${g.exit_code})`).join('\n') || '(none recorded)';
        break;
      }
      case 'verify_fix': {
        const findings = this.store.findings(p.id, { workItemId: w!.id }).filter((f) => (input.findingIds ?? []).includes(f.id));
        extra.findings = findings.map((f) => `- id ${f.id} [${f.severity}] ${f.title} @ ${json<Array<{ path: string; line: number }>>(f.locations, []).map((l) => `${l.path}:${l.line}`).join(', ')}\n  ${f.explanation}\n  expected verification: ${f.verification}${f.resolution_evidence ? `\n  implementer says: ${f.resolution_evidence}` : ''}`).join('\n');
        const since = input.since && (await ws.commitExists(input.since)) ? input.since : p.default_branch;
        const d = await ws.diff(cwd, since, w!.head_commit ?? 'HEAD', this.ctx.cfg.limits.maxDiffChars);
        extra.diff = '```diff\n' + d.text + '\n```';
        break;
      }
      case 'answer': {
        const q = this.bus.get(input.messageId);
        if (q) {
          const sender = this.store.agent(q.sender_agent_id);
          extra.question = `From ${sender?.name ?? q.sender_agent_id} (${sender?.role ?? 'agent'}), type ${q.type}:\n${q.body}`;
          extra.thread = this.bus.thread(q.thread_id).filter((m) => m.id !== q.id).slice(-6).map((m) => `- ${m.type}: ${m.body.slice(0, 600)}`).join('\n');
        }
        break;
      }
      case 'investigate': {
        const hist = this.ctx.db.all<{ kind: string; provider: string; error_class: string; error_message: string; status: string }>('SELECT kind, provider, error_class, error_message, status FROM tasks WHERE work_item_id=? ORDER BY created_at DESC LIMIT 8', w!.id);
        const gates = this.ctx.db.all<{ name: string; output_excerpt: string }>("SELECT name, output_excerpt FROM gate_runs WHERE work_item_id=? AND status!='pass' ORDER BY started_at DESC LIMIT 2", w!.id);
        extra.failures = `Reason: ${input.why}\n` + hist.map((h) => `- ${h.kind} on ${h.provider}: ${h.status} ${h.error_class ?? ''} ${(h.error_message ?? '').slice(0, 300)}`).join('\n') + (gates.length ? `\nLatest failing gates:\n${gates.map((g) => `${g.name}:\n${g.output_excerpt.slice(-1500)}`).join('\n')}` : '');
        break;
      }
      case 'integration_audit':
        extra.requirements = this.store.requirements(p.id).map((r) => `- ${r.key} [${r.status}] ${r.title}`).join('\n');
        extra.merged = this.store.workItems(p.id, ['done', 'merged']).map((x) => `- ${x.key} [${x.status}, merged ${x.merged_commit?.slice(0, 8) ?? '-'}] ${x.type === 'defect' ? 'fixed defect: ' : ''}${x.title}`).join('\n')
          + '\n(Defect titles describe the problem that was reported and has since been fixed and merged; they are not open issues.)';
        extra.files = await ws.trackedFiles(ws.integration, 'HEAD');
        break;
      case 'completion_audit': {
        extra.requirements = this.store.requirements(p.id).map((r) => `- ${r.key}${r.mandatory ? ' (mandatory)' : ''} [${r.status}] ${r.title}\n  acceptance: ${json<string[]>(r.acceptance, []).join('; ')}\n  evidence: ${json<unknown[]>(r.evidence, []).slice(-4).map((e) => JSON.stringify(e)).join('; ')}${r.blocker ? `\n  BLOCKER: ${r.blocker}` : ''}`).join('\n');
        extra.gates = gateEvidence(this.ctx, p.id, input.commit).map((g) => `- ${g.name}: ${g.status} (\`${g.command}\`)`).join('\n') || '(no gate results)';
        extra.findings = this.store.findings(p.id, { statuses: ['open', 'fixed_claimed'] }).map((f) => `- [${f.severity}] ${f.title}`).join('\n');
        extra.files = await ws.trackedFiles(ws.integration, input.commit ?? 'HEAD');
        const last = this.ctx.db.get<{ result: string }>("SELECT result FROM audits WHERE project_id=? AND kind='completion' AND status='inconclusive' ORDER BY created_at DESC LIMIT 1", p.id);
        const fb = json<{ feedback?: string[] }>(last?.result, {}).feedback;
        if (fb?.length) extra['Feedback from the previous inconclusive audit'] = fb.map((f) => `- ${f}`).join('\n') + '\nDeclining release now requires citing a specific unsatisfied requirement key or a defect with evidence. A docs_accurate or install_reproducible value of false must be backed by a concrete defect (file, line, observed behaviour) in the defects array.';
        break;
      }
      default:
        if (task.kind.startsWith('debate_')) {
          const d = this.store.decision(input.decisionId);
          if (d) { extra.decision = this.debate.render(d); extra.decisionKey = d.key; }
        }
    }
    return { cwd, extra };
  }
}

function conflicts(w: WorkItemRow, active: WorkItemRow[]): boolean {
  const mine = json<string[]>(w.paths, []).map(norm).filter(Boolean);
  if (!mine.length) return false;
  return active.some((a) => json<string[]>(a.paths, []).map(norm).some((q) => mine.some((m) => m === q || m.startsWith(q + '/') || q.startsWith(m + '/'))));
}
const norm = (s: string) => s.replace(/^\.\//, '').replace(/\/+$/, '').replace(/\*.*$/, '').replace(/\/$/, '');

function guessRole(paths: string[]): string {
  const s = paths.join(' ');
  if (/ui|web|frontend|client|\.tsx|\.css/i.test(s)) return 'frontend_engineer';
  if (/migrat|schema|\.sql/i.test(s)) return 'database_engineer';
  if (/doc|readme/i.test(s)) return 'documentation_engineer';
  return 'backend_engineer';
}

async function patchId(ws: Workspace, dir: string, base: string, head: string): Promise<string | null> {
  const d = await ws.gitIn(dir, ['diff', '--no-ext-diff', '--no-textconv', `${base}...${head}`], { allowFail: true });
  if (d.code !== 0 || !d.stdout) return null;
  const r = await ws.gitIn(dir, ['patch-id', '--stable'], { allowFail: true, input: d.stdout });
  return r.stdout.split(' ')[0] || null;
}

export function validatePlan(out: any): string[] {
  const errs: string[] = [];
  if (!Array.isArray(out?.requirements) || !out.requirements.length) errs.push('at least one requirement is required');
  if (!Array.isArray(out?.work_items) || !out.work_items.length) errs.push('at least one work item is required');
  if (errs.length) return errs;
  const reqKeys = new Set<string>();
  for (const r of out.requirements) { if (reqKeys.has(r.key)) errs.push(`duplicate requirement key ${r.key}`); reqKeys.add(r.key); }
  const wiKeys = new Set<string>();
  for (const w of out.work_items) { if (wiKeys.has(w.key)) errs.push(`duplicate work item key ${w.key}`); wiKeys.add(w.key); }
  const decKeys = new Set<string>((out.decisions ?? []).map((d: any) => d.key));
  for (const w of out.work_items) {
    for (const d of w.depends_on ?? []) if (!wiKeys.has(d) && !decKeys.has(d)) errs.push(`${w.key} depends on unknown key ${d}`);
    for (const r of w.requirement_keys ?? []) if (!reqKeys.has(r)) errs.push(`${w.key} references unknown requirement ${r}`);
    if (!w.acceptance?.length) errs.push(`${w.key} has no acceptance criteria`);
  }
  for (const r of out.requirements.filter((x: any) => x.mandatory)) {
    if (!out.work_items.some((w: any) => (w.requirement_keys ?? []).includes(r.key))) errs.push(`mandatory requirement ${r.key} has no work item`);
  }
  // Cycle detection (deadlock prevention at planning time).
  const graph = new Map<string, string[]>(out.work_items.map((w: any) => [w.key, (w.depends_on ?? []).filter((d: string) => wiKeys.has(d))]));
  const state = new Map<string, number>();
  const visit = (k: string, stack: string[]): boolean => {
    if (state.get(k) === 1) { errs.push(`dependency cycle: ${[...stack, k].join(' → ')}`); return true; }
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const d of graph.get(k) ?? []) if (visit(d, [...stack, k])) return true;
    state.set(k, 2);
    return false;
  };
  for (const k of graph.keys()) if (visit(k, [])) break;
  if (!(out.gates ?? []).some((g: any) => g.required && g.command?.trim())) errs.push('at least one required quality gate with a real command is needed');
  return errs;
}
