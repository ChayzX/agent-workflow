// The supervisor: a persistent, deterministic control loop. It owns leases, dispatch,
// provider capacity, recovery and shutdown. Autonomy is event-driven: a tick does only
// database work and launches bounded agent invocations; it never "asks a model to continue".
import { closeSync, existsSync, linkSync, openSync, readFileSync, unlinkSync, writeSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { json } from '../core/db.js';
import { newId, randomToken } from '../core/ids.js';
import type { ExecFailure, ExecResult } from '../providers/types.js';
import { killTree } from '../providers/process.js';
import type { FailureClass, ProjectRow, TaskRow } from '../core/types.js';
import { agentEnv, agentSandboxMode, ClaudeStateGuard, relaxAgentSandbox, wrapAgentCommand } from '../security/sandbox.js';
import { validate } from '../util/validate.js';
import { buildPrompt } from './context.js';
import type { Ctx } from './ctx.js';
import type { RouteDecision } from './router.js';
import { schemaFor } from './schemas.js';
import { Workflow } from './workflow.js';
import { gateBackendSelfCheck } from './gate-backend.js';

const RUNNABLE_PROJECT = ['planning', 'debating', 'active', 'auditing', 'releasing'];
/** Lock contents held by live Supervisor instances in this process (a same-pid lock not in here is stale). */
const LIVE_LOCKS = new Set<string>();

export interface SupervisorOptions { onIdle?: () => void; lock?: boolean }

export class Supervisor {
  readonly instanceId = `sup_${hostname()}_${process.pid}_${randomToken(4)}`;
  readonly workflow: Workflow;
  private running = new Map<string, { ac: AbortController; promise: Promise<void>; provider: string }>();
  private stopping = false;
  private stopped = false;
  private wakeFn: (() => void) | null = null;
  private lastCapacityTick = 0;
  private lockPath: string;
  private loopPromise: Promise<void> | null = null;
  ticks = 0;

  constructor(private ctx: Ctx, private opts: SupervisorOptions = {}) {
    this.workflow = new Workflow(ctx, () => this.wake());
    this.lockPath = join(ctx.paths.home, 'supervisor.lock');
  }

  wake(): void { this.wakeFn?.(); }

  // ------------------------------------------------------------ lifecycle
  /**
   * Single-instance lock. Acquisition is an atomic link() of a fully written temp file (fails if the lock
   * exists); a stale lock is removed only if it still has the exact stale content, then acquisition retries.
   */
  acquireLock(): void {
    const mine = `${process.pid} ${this.instanceId}`;
    const tmp = `${this.lockPath}.${process.pid}.${randomToken(4)}`;
    const fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, mine);
    closeSync(fd);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { linkSync(tmp, this.lockPath); break; } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          let content = '';
          try { content = readFileSync(this.lockPath, 'utf8'); } catch { continue; }
          const pid = Number(content.split(' ')[0]);
          const held = pid === process.pid ? LIVE_LOCKS.has(content) : pid > 0 && isAlive(pid);
          if (held) throw new Error(`another supervisor is running (pid ${pid}); refusing to start a second one`);
          // Stale: remove only if unchanged since we read it (another starter may have replaced it).
          try { if (readFileSync(this.lockPath, 'utf8') === content) unlinkSync(this.lockPath); } catch { /* raced */ }
          if (attempt === 2) throw new Error('could not acquire supervisor lock');
        }
      }
      if (readFileSync(this.lockPath, 'utf8') !== mine) throw new Error('supervisor lock was taken by another instance');
      LIVE_LOCKS.add(mine);
    } finally {
      try { unlinkSync(tmp); } catch { /* gone */ }
    }
  }

  releaseLock(): void {
    LIVE_LOCKS.delete(`${process.pid} ${this.instanceId}`);
    try { if (readFileSync(this.lockPath, 'utf8').includes(this.instanceId)) unlinkSync(this.lockPath); } catch { /* gone */ }
  }

  /** Restart recovery: reap orphaned agent processes and requeue tasks owned by dead instances. */
  async recover(): Promise<{ requeued: number; killed: number; gitFixes: string[] }> {
    let requeued = 0;
    let killed = 0;
    for (const t of this.ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE status='running'")) {
      if (t.lease_owner === this.instanceId) continue;
      if (t.pid && t.pid !== process.pid && isOrphanAgent(t.pid, t.id)) { killTree(t.pid, 'SIGTERM'); killed++; }
      if (this.ctx.queue.recoverOrphan(t.id, t.lease_owner)) requeued++;
    }
    const gitFixes: string[] = [];
    for (const p of this.workflow.store.projects()) {
      if (!existsSync(join(p.workspace_dir, 'repo.git'))) continue;
      gitFixes.push(...(await this.workflow.ws(p).recover().catch(() => [])));
    }
    this.ctx.db.setMeta('supervisor_instance', this.instanceId);
    this.ctx.events.emit('supervisor.recovered', `recovery: requeued ${requeued} task(s), reaped ${killed} orphan process(es), ${gitFixes.length} git repair(s)`, { data: { gitFixes } });
    return { requeued, killed, gitFixes };
  }

  /** Verify each provider still authenticates inside the agent sandbox; relax (audited) only when required. */
  readonly claudeState = new ClaudeStateGuard();

  async sandboxSelfCheck(): Promise<void> {
    this.claudeState.snapshot();
    if (this.ctx.cfg.security.sandbox === 'none') {
      this.ctx.events.emit('security.sandbox', 'quality-gate sandbox disabled by configuration (security.sandbox="none"): gate commands run unconfined', { level: 'warn' });
      this.ctx.events.audit('supervisor', 'security.gate_sandbox_disabled', {});
    }
    let mode: 'bwrap' | 'none';
    try { mode = agentSandboxMode(this.ctx.cfg); } catch (e) {
      // Fail closed: no agent runs until confinement works or the operator explicitly opts out (agentSandbox="none").
      this.sandboxBlocked = (e as Error).message;
      this.ctx.events.emit('security.sandbox_unavailable', `agents will not run: ${this.sandboxBlocked}`, { level: 'error' });
      this.ctx.events.audit('supervisor', 'security.sandbox_unavailable', { detail: { reason: this.sandboxBlocked } });
      return;
    }
    if (mode === 'none') {
      this.ctx.events.emit('security.sandbox', 'agent sandbox disabled by configuration (security.agentSandbox="none"): agents run with a scrubbed environment only', { level: 'warn' });
      this.ctx.events.audit('supervisor', 'security.sandbox_disabled', {});
      return;
    }
    this.ctx.events.emit('security.sandbox_ok', 'agent and gate sandbox self-check passed (bubblewrap with /proc, /tmp and namespaces)', { level: 'info' });
    for (const [id, a] of this.ctx.adapters) {
      if (id !== 'claude' && id !== 'codex') continue;
      const strict = await a.checkAuth().catch(() => ({ ok: false }));
      if (strict.ok) continue;
      relaxAgentSandbox(id, true);
      const relaxed = await a.checkAuth().catch(() => ({ ok: false }));
      relaxAgentSandbox(id, false);
      if (!relaxed.ok) continue; // genuinely not logged in: strict confinement stays; auth handling takes over
      const dedup = `sandbox-relax:${id}`;
      const authorized = (this.ctx.cfg.security.agentSandboxRelaxFor ?? []).includes(id) || this.ctx.policy.status(dedup)?.status === 'approved';
      if (authorized) {
        relaxAgentSandbox(id, true);
        this.ctx.events.emit('security.sandbox_relaxed', `${id}: authentication depends on files outside the service user's home; other accounts' homes are visible to ${id} agents by operator authorization (ORCH_HOME and the service home remain hidden)`, { level: 'warn' });
        this.ctx.events.audit('supervisor', 'security.sandbox_relaxed', { detail: { provider: id } });
      } else {
        // Fail closed: do not widen credential exposure without the operator.
        this.ctx.policy.request('credential_expansion', `${id} cannot authenticate inside the agent sandbox on this host: its login lives outside the service user's home. Approving lets ${id} agents read other accounts' home directories (ORCH_HOME stays hidden). Prefer re-running \`${id === 'claude' ? 'claude login' : 'codex login'}\` as the service user instead.`, { requestedBy: 'supervisor', dedup, payload: { provider: id } });
        this.ctx.capacity.recordFailure(id, { cls: 'auth', message: 'provider cannot authenticate inside the agent sandbox (approval credential_expansion pending)' });
        this.sandboxPending.add(id);
      }
    }
  }

  private sandboxPending = new Set<string>();
  /** Set when confinement is required but unavailable: no agent task is dispatched (fail closed). */
  sandboxBlocked: string | null = null;
  /** Apply an operator's approval of a pending sandbox relaxation without restarting. */
  private applySandboxApprovals(): void {
    for (const id of [...this.sandboxPending]) {
      if (this.ctx.policy.status(`sandbox-relax:${id}`)?.status !== 'approved') continue;
      relaxAgentSandbox(id, true);
      this.sandboxPending.delete(id);
      this.ctx.capacity.reset(id, 'sandbox relaxation approved by operator');
      this.ctx.events.audit('supervisor', 'security.sandbox_relaxed', { detail: { provider: id, via: 'approval' } });
    }
  }

  async start(): Promise<void> {
    if (this.opts.lock !== false) this.acquireLock();
    await this.sandboxSelfCheck();
    await gateBackendSelfCheck(this.ctx);
    await this.recover();
    this.ctx.events.audit('supervisor', 'supervisor.start', { detail: { instance: this.instanceId } });
    this.ctx.log.info('supervisor started', { instance: this.instanceId });
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.tick();
      } catch (e) {
        this.ctx.log.error('tick failed', { error: (e as Error).message, stack: (e as Error).stack });
        this.ctx.events.emit('supervisor.error', `tick failed: ${(e as Error).message}`, { level: 'error' });
      }
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.ctx.cfg.supervisor.tickMs);
        this.wakeFn = () => { clearTimeout(t); resolve(); };
      });
      this.wakeFn = null;
    }
  }

  /** Graceful shutdown: stop dispatching, let agents finish within the grace period, then interrupt them (resumable). */
  async stop(graceMs = this.ctx.cfg.supervisor.shutdownGraceMs): Promise<void> {
    if (this.stopped) return;
    this.stopping = true;
    this.wake();
    const all = [...this.running.values()].map((r) => r.promise);
    const timer = new Promise<void>((r) => setTimeout(r, graceMs).unref());
    await Promise.race([Promise.allSettled(all), timer]);
    for (const r of this.running.values()) r.ac.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
    await this.loopPromise;
    await this.workflow.drainJobs();
    this.ctx.events.audit('supervisor', 'supervisor.stop', { detail: { instance: this.instanceId } });
    this.releaseLock();
    this.stopped = true;
  }

  // ------------------------------------------------------------ tick
  async tick(): Promise<void> {
    this.ticks++;
    this.processCommands();
    this.applySandboxApprovals();
    const now = this.ctx.clock.now();
    if (now - this.lastCapacityTick >= 30_000 || this.ticks === 1) {
      this.lastCapacityTick = now;
      await this.ctx.capacity.tick(this.ctx.adapters);
    }
    // Leases that expired without being ours (worker hung or a previous instance died mid-run).
    for (const t of this.ctx.queue.expiredLeases()) {
      if (this.running.has(t.id)) continue;
      if (t.pid && t.pid !== process.pid && isOrphanAgent(t.pid, t.id)) killTree(t.pid, 'SIGTERM');
      this.ctx.queue.recoverOrphan(t.id, t.lease_owner);
      this.ctx.events.emit('task.lease_expired', `lease expired for ${t.kind} ${t.id}; requeued`, { projectId: t.project_id, taskId: t.id, level: 'warn' });
    }
    this.wakeWaitingCapacity();
    await this.processOutcomes();
    for (const p of this.workflow.store.projects().filter((x) => RUNNABLE_PROJECT.includes(x.status))) {
      await this.workflow.advance(p);
    }
    await this.processOutcomes();
    this.dispatch();
    this.updateWaitReasons();
    if (!this.running.size && !this.workflow.jobCount() && !this.ctx.queue.dispatchable(1).length) this.opts.onIdle?.();
  }

  /** Tasks waiting for capacity become eligible once their provider (or an eligible alternative) can run. */
  private wakeWaitingCapacity(): void {
    const now = this.ctx.clock.now();
    for (const t of this.ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE status='waiting_capacity' AND not_before <= ?", now)) {
      this.ctx.queue.wake(t.id, ['waiting_capacity'], 0);
    }
    for (const t of this.ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE status='waiting_capacity' AND not_before > ?", now)) {
      // Failover: if the pinned provider will be out longer than the threshold and another provider is usable, release early.
      const pinned = t.provider_pinned;
      const wait = pinned ? this.ctx.capacity.expectedWaitMs(pinned) : null;
      const alt = [...this.ctx.adapters.keys()].some((k) => k !== pinned && this.ctx.capacity.dispatchability(k) !== 'no');
      if (alt && (wait === null || wait > this.ctx.cfg.routing.failoverAfterMinutes * 60_000)) this.ctx.queue.wake(t.id, ['waiting_capacity'], 0);
      else if (pinned && this.ctx.capacity.dispatchability(pinned) !== 'no') this.ctx.queue.wake(t.id, ['waiting_capacity'], 0);
    }
  }

  private outcomesInFlight: Promise<void> | null = null;
  /** Single-flight: outcome handlers (git commits, transitions) must never run concurrently. */
  private processOutcomes(): Promise<void> {
    if (this.outcomesInFlight) return this.outcomesInFlight.then(() => this.processOutcomes());
    this.outcomesInFlight = this.processOutcomesOnce().finally(() => { this.outcomesInFlight = null; });
    return this.outcomesInFlight;
  }

  private async processOutcomesOnce(): Promise<void> {
    const rows = this.ctx.db.all<TaskRow>("SELECT * FROM tasks WHERE processed=0 AND status IN ('succeeded','dead','failed') ORDER BY updated_at LIMIT 50");
    for (const t of rows) {
      try {
        if (t.status === 'succeeded') await this.workflow.onSuccess(t);
        else await this.workflow.onDead(t);
        this.ctx.db.run('UPDATE tasks SET processed=1 WHERE id=?', t.id);
      } catch (e) {
        this.ctx.events.emit('task.process_error', `processing ${t.kind} ${t.id} failed: ${(e as Error).message}`, { projectId: t.project_id, taskId: t.id, level: 'error' });
        this.ctx.log.error('outcome processing failed', { task: t.id, error: (e as Error).message, stack: (e as Error).stack });
        // Leave processed=0 for a retry on the next tick, but avoid hot-looping on a poison task.
        const tries = json<{ processTries?: number }>(t.input, {}).processTries ?? 0;
        this.ctx.queue.updateInput(t.id, { processTries: tries + 1 });
        if (tries >= 5) this.ctx.db.run('UPDATE tasks SET processed=1, error_message=? WHERE id=?', `outcome processing failed repeatedly: ${(e as Error).message}`, t.id);
      }
    }
  }

  private dispatch(): void {
    if (this.stopping) return;
    if (this.sandboxBlocked) return; // fail closed (see sandboxSelfCheck); tasks stay queued and resume after a fixed restart
    const max = this.ctx.cfg.supervisor.maxConcurrentAgents;
    for (const t of this.ctx.queue.dispatchable(100)) {
      if (this.running.size >= max) return;
      if (this.ctx.queue.runningCount({ projectId: t.project_id }) >= this.ctx.cfg.supervisor.maxPerProject) continue;
      const project = this.workflow.store.project(t.project_id)!;
      const route = this.ctx.router.route(t, this.workflow.store.settings(project).provider_preference);
      if ('wait' in route) {
        if (route.until && route.until > this.ctx.clock.now()) {
          this.ctx.db.run("UPDATE tasks SET status='waiting_capacity', not_before=?, error_message=?, updated_at=? WHERE id=? AND status='queued'", route.until, route.wait, this.ctx.clock.now(), t.id);
        }
        continue;
      }
      const claimed = this.ctx.queue.claim(t.id, this.instanceId, route.provider, this.ctx.cfg.supervisor.leaseMs);
      if (!claimed) continue; // someone else got it (idempotent dispatch)
      const ac = new AbortController();
      const promise = this.runTask(claimed, route, ac).catch((e) => {
        this.ctx.log.error('runTask crashed', { task: t.id, error: (e as Error).message, stack: (e as Error).stack });
        this.ctx.queue.release(t.id, this.instanceId, { status: 'queued', cls: 'unknown', message: (e as Error).message, countAttempt: true, notBefore: this.ctx.clock.now() + 30_000 });
      }).finally(() => { this.running.delete(t.id); this.wake(); });
      this.running.set(t.id, { ac, promise, provider: route.provider });
    }
  }

  private updateWaitReasons(): void {
    for (const p of this.workflow.store.projects().filter((x) => RUNNABLE_PROJECT.includes(x.status))) {
      const waiting = this.ctx.db.get<{ n: number; nb: number }>("SELECT COUNT(*) AS n, MIN(not_before) AS nb FROM tasks WHERE project_id=? AND status='waiting_capacity'", p.id)!;
      const runningOrQueued = this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status IN ('running','queued')", p.id)!.n;
      if (waiting.n && !runningOrQueued && !this.workflow.jobCount(p.id)) {
        const reason = `waiting for provider capacity (${waiting.n} task(s)); next check ${new Date(waiting.nb).toISOString()}`;
        if (p.status_reason !== reason) this.ctx.db.run('UPDATE projects SET status_reason=? WHERE id=?', reason, p.id);
      } else if (p.status_reason?.startsWith('waiting for provider capacity') && runningOrQueued) {
        this.ctx.db.run('UPDATE projects SET status_reason=? WHERE id=?', 'capacity restored; work resumed', p.id);
      }
    }
  }

  // ------------------------------------------------------------ commands from CLI / dashboard
  processCommands(): void {
    for (const c of this.ctx.db.all<{ id: number; project_id: string | null; command: string; args: string; issued_by: string }>("SELECT * FROM commands WHERE status='pending' ORDER BY id")) {
      let result = 'ok';
      try {
        const args = json<Record<string, any>>(c.args, {});
        const p = c.project_id ? this.workflow.store.project(c.project_id) : undefined;
        switch (c.command) {
          case 'pause':
            if (p && RUNNABLE_PROJECT.includes(p.status)) { this.ctx.db.setMeta(`prev_status:${p.id}`, p.status); this.workflow.store.setProjectStatus(p.id, 'paused', `paused by ${c.issued_by}`); }
            break;
          case 'resume':
            if (p && ['paused', 'stopped', 'blocked', 'failed'].includes(p.status)) {
              const prev = this.ctx.db.meta(`prev_status:${p.id}`);
              this.workflow.store.setProjectStatus(p.id, prev && RUNNABLE_PROJECT.includes(prev) ? (prev as ProjectRow['status']) : p.plan ? 'active' : 'planning', `resumed by ${c.issued_by}`);
            }
            break;
          case 'stop':
            if (p) {
              this.ctx.db.setMeta(`prev_status:${p.id}`, p.status);
              this.workflow.store.setProjectStatus(p.id, 'stopped', `stopped by ${c.issued_by}`);
              for (const [tid, r] of this.running) if (this.ctx.queue.get(tid)?.project_id === p.id) r.ac.abort();
            }
            break;
          case 'cancel_task': {
            // Mark first (fences the running worker's later writes), then interrupt it.
            if (!this.ctx.queue.cancel(args.taskId, `cancelled by ${c.issued_by}`)) result = 'task already finished; not cancelled';
            this.running.get(args.taskId)?.ac.abort();
            break;
          }
          case 'kill_agent': {
            // Test/ops hook: hard-kill the provider process of a running task (recovery is automatic).
            const t = this.ctx.queue.get(args.taskId);
            if (t?.pid && t.pid !== process.pid) killTree(t.pid, 'SIGKILL');
            else this.running.get(args.taskId)?.ac.abort();
            break;
          }
          case 'cancel_item':
            if (p) {
              result = this.workflow.cancelItem(p, String(args.key), String(args.note ?? ''), c.issued_by);
              const w = result === 'ok' ? this.workflow.store.workItemByKey(p.id, String(args.key)) : undefined;
              // Running tasks are fenced (cancelled first, so their late results are ignored), then interrupted.
              if (w) for (const [tid, r] of this.running) if (this.ctx.queue.get(tid)?.work_item_id === w.id) { this.ctx.queue.cancel(tid, `work item cancelled by ${c.issued_by}`); r.ac.abort(); }
            }
            break;
          case 'unblock_item':
            if (p) result = this.workflow.unblock(p, String(args.key), String(args.note ?? ''), c.issued_by);
            break;
          case 'provider_reset':
            this.ctx.capacity.reset(args.provider, `operator reset by ${c.issued_by}`);
            break;
          case 'set_concurrency':
            if (Number.isInteger(args.maxConcurrentAgents) && args.maxConcurrentAgents > 0) this.ctx.cfg.supervisor.maxConcurrentAgents = args.maxConcurrentAgents;
            if (Number.isInteger(args.maxPerProject) && args.maxPerProject > 0) this.ctx.cfg.supervisor.maxPerProject = args.maxPerProject;
            for (const [prov, n] of Object.entries(args.providers ?? {})) if (this.ctx.cfg.providers[prov] && Number.isInteger(n)) this.ctx.cfg.providers[prov]!.maxConcurrent = n as number;
            break;
          default:
            result = `unknown command ${c.command}`;
        }
        this.ctx.events.audit(c.issued_by, `command.${c.command}`, { projectId: c.project_id, detail: args });
      } catch (e) {
        result = `error: ${(e as Error).message}`;
      }
      this.ctx.db.run("UPDATE commands SET status='done', result=?, processed_at=? WHERE id=?", result, this.ctx.clock.now(), c.id);
    }
  }

  // ------------------------------------------------------------ execution
  private async runTask(task: TaskRow, route: Extract<RouteDecision, { provider: string }>, ac: AbortController): Promise<void> {
    const ctx = this.ctx;
    const adapter = ctx.adapters.get(route.provider)!;
    const project = this.workflow.store.project(task.project_id)!;
    const agent = task.agent_id ? this.workflow.store.agent(task.agent_id) : undefined;
    if (agent) this.workflow.team.activate(agent.id, task.id, route.provider);
    const wasRecovering = ctx.capacity.get(route.provider).status === 'recovering';

    let cwd: string;
    let extra: Record<string, string>;
    try {
      ({ cwd, extra } = await this.workflow.prepare(task));
    } catch (e) {
      ctx.queue.release(task.id, this.instanceId, { status: 'queued', cls: 'transient', message: `prepare failed: ${(e as Error).message}`, countAttempt: true, notBefore: ctx.clock.now() + 30_000 });
      return;
    }
    const canResume = route.resume && adapter.capabilities().resume && !!task.session_id && task.session_provider === route.provider;
    const reconstructed = !canResume && (!!task.session_id || task.attempts > 1 || task.error_class === 'interrupted');
    if (!canResume && task.session_id && task.session_provider !== route.provider) {
      ctx.events.emit('task.failover', `${task.kind} ${task.id}: ${task.session_provider} → ${route.provider} (context reconstructed from checkpoints)`, { projectId: task.project_id, taskId: task.id, level: 'warn' });
    }
    const built = buildPrompt({ cfg: ctx.cfg, store: this.workflow.store, bus: this.workflow.bus, project, task, agentName: agent?.name ?? task.role, resume: canResume, reconstructed, extra });
    const sessionRow = newId('ses');
    ctx.db.run('INSERT INTO sessions(id, task_id, project_id, agent_id, provider, provider_session_id, model, mode, status, prompt_chars, started_at, transcript_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      sessionRow, task.id, task.project_id, task.agent_id, route.provider, canResume ? task.session_id : null, route.model, canResume ? 'resume' : reconstructed ? 'reconstructed' : 'new', 'running', built.prompt.length, ctx.clock.now(),
      join(ctx.paths.transcripts, task.project_id, `${task.id}-${sessionRow}.jsonl`));
    ctx.events.emit('task.started', `${task.kind}${task.work_item_id ? ` ${this.workflow.store.workItem(task.work_item_id)?.key}` : ''} → ${route.provider}${route.model ? `/${route.model}` : ''} (${canResume ? 'resume' : reconstructed ? 'reconstructed' : 'new'}${route.note ? `, ${route.note}` : ''})`, { projectId: task.project_id, taskId: task.id });

    let pid: number | null = null;
    const hb = setInterval(() => {
      if (!ctx.queue.heartbeat(task.id, this.instanceId, ctx.cfg.supervisor.leaseMs, pid)) ac.abort(); // lost lease → stop work
    }, ctx.cfg.supervisor.heartbeatMs);
    let result: ExecResult;
    try {
      result = await adapter.execute({
        prompt: built.prompt, cwd, mode: task.read_only ? 'read-only' : 'workspace-write', model: route.model, effort: route.effort,
        outputSchema: schemaFor(task.kind), resumeSessionId: canResume ? task.session_id : null,
        timeoutMs: (ctx.cfg.providers[route.provider]?.timeoutSec ?? 2700) * 1000, signal: ac.signal,
        env: agentEnv(ctx.cfg, route.provider, { ORCH_TASK_ID: task.id }),
        transcriptPath: join(ctx.paths.transcripts, task.project_id, `${task.id}-${sessionRow}.jsonl`),
        onSpawn: (p) => { pid = p; ctx.queue.heartbeat(task.id, this.instanceId, ctx.cfg.supervisor.leaseMs, p); },
        onEvent: (e) => {
          if (e.kind === 'session') {
            const sid = (e.data as { sessionId?: string })?.sessionId;
            if (sid) { ctx.queue.setSession(task.id, this.instanceId, sid, route.provider); ctx.db.run('UPDATE sessions SET provider_session_id=? WHERE id=?', sid, sessionRow); }
          }
          if (e.kind === 'rate_limit') ctx.events.emit('provider.rate_limit_event', `${route.provider} rate-limit event`, { projectId: task.project_id, taskId: task.id, level: 'debug', data: e.data });
        },
        maxTurns: ctx.cfg.providers[route.provider]?.maxTurns,
        osReadOnly: !!task.read_only && (() => { try { return agentSandboxMode(ctx.cfg) === 'bwrap'; } catch { return false; } })(),
        wrap: (cmd, args, extra) => {
          // The shared repository (including this worktree's admin dir) is read-only for agents and the
          // worktree's `.git` pointer is re-bound read-only: agents edit files, the supervisor owns git.
          const repoGit = join(project.workspace_dir, 'repo.git');
          return wrapAgentCommand(ctx.cfg, {
            orchHome: ctx.paths.home, provider: route.provider,
            writable: [...(task.read_only ? [] : [cwd]), ...extra],
            readOnly: [repoGit, ...(task.read_only ? [cwd] : [])],
            readOnlyLast: [join(cwd, '.git')],
          }, cmd, args);
        },
        meta: { taskId: task.id, taskKind: task.kind, role: task.role, projectId: task.project_id, workItemKey: task.work_item_id ? this.workflow.store.workItem(task.work_item_id)?.key : null, attempt: task.attempts, agentId: task.agent_id },
      });
    } finally {
      clearInterval(hb);
    }
    if (route.provider === 'claude' && this.claudeState.verifyAndRestore()) {
      ctx.events.emit('security.provider_config_tamper', `reverted mcpServers changes in ~/.claude.json after task ${task.id}`, { projectId: task.project_id, taskId: task.id, level: 'error' });
      ctx.events.audit('supervisor', 'security.provider_config_tamper', { projectId: task.project_id, target: task.id });
    }
    if (result.sessionId) ctx.queue.setSession(task.id, this.instanceId, result.sessionId, route.provider);
    ctx.db.run('UPDATE sessions SET status=?, failure_class=?, exit_code=?, ended_at=?, provider_session_id=COALESCE(provider_session_id, ?) WHERE id=?',
      result.ok ? 'succeeded' : 'failed', result.failure?.cls ?? null, result.exitCode, ctx.clock.now(), result.sessionId, sessionRow);
    if (result.usage) {
      ctx.db.run('INSERT INTO usage(ts, project_id, task_id, session_id, provider, model, input_tokens, output_tokens, cached_tokens, reported_cost_usd, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ctx.clock.now(), task.project_id, task.id, sessionRow, route.provider, result.usage.model ?? route.model, result.usage.inputTokens ?? null, result.usage.outputTokens ?? null,
        result.usage.cachedTokens ?? null, result.usage.costUsd ?? null, `${route.provider}-reported`);
    }
    if (!result.ok) ctx.capacity.observe(route.provider, result.rateLimits);
    this.workflow.bus.markDelivered(built.deliveredMessageIds);

    if (result.ok) {
      const schema = schemaFor(task.kind);
      const errs = validate(schema, result.structured);
      if (errs.length) {
        return this.handleFailure(task, route.provider, { cls: 'invalid_output', message: `output failed schema validation: ${errs.slice(0, 5).join('; ')}` }, wasRecovering);
      }
      const out = result.structured as Record<string, any>;
      ctx.capacity.recordSuccess(route.provider, result.rateLimits);
      if ((task.kind === 'implement' || task.kind === 'remediate') && out.status === 'needs_input') {
        const blocking = this.workflow.postOutbound(task, out.messages);
        if (blocking.length) {
          ctx.queue.release(task.id, this.instanceId, { status: 'waiting_message', countAttempt: false, pin: canResume || result.sessionId ? route.provider : undefined, message: `waiting for ${blocking.length} answer(s)` });
          if (agent) this.workflow.team.setStatus(agent.id, 'waiting', task.id);
          ctx.events.emit('task.waiting_message', `${task.kind} yielded capacity awaiting ${blocking.length} answer(s)`, { projectId: task.project_id, taskId: task.id });
          return;
        }
        return this.handleFailure(task, route.provider, { cls: 'task_failure', message: 'agent reported needs_input without a deliverable question' }, false);
      }
      if (!ctx.queue.succeed(task.id, this.instanceId, out)) {
        ctx.events.emit('task.fenced', `result for ${task.id} discarded: lease lost`, { projectId: task.project_id, taskId: task.id, level: 'warn' });
        return;
      }
      ctx.events.emit('task.succeeded', `${task.kind} succeeded on ${route.provider}`, { projectId: task.project_id, taskId: task.id });
      await this.processOutcomes();
      return;
    }
    return this.handleFailure(task, route.provider, result.failure ?? { cls: 'unknown', message: 'no failure detail' }, wasRecovering);
  }

  private handleFailure(task: TaskRow, provider: string, f: ExecFailure, wasRecovering: boolean): void {
    const ctx = this.ctx;
    const now = ctx.clock.now();
    const cur = ctx.queue.get(task.id)!;
    ctx.events.emit('task.failed', `${task.kind} on ${provider}: ${f.cls} — ${f.message.slice(0, 300)}`, { projectId: task.project_id, taskId: task.id, level: 'warn', data: { cls: f.cls, resetAt: f.resetAt } });
    const release = (o: Parameters<Ctx['queue']['release']>[2]) => ctx.queue.release(task.id, this.instanceId, o);
    switch (f.cls as FailureClass) {
      case 'usage_limit': {
        if (wasRecovering) ctx.capacity.canaryFailed(provider, f); else ctx.capacity.recordFailure(provider, f);
        const st = ctx.capacity.get(provider);
        const until = f.limitKind === 'model' ? now : (st.reset_at ?? now + 15 * 60_000);
        // Preserve session, worktree and ownership; resume natively when capacity returns (or fail over).
        release({ status: 'waiting_capacity', notBefore: until, cls: f.cls, message: f.message, countAttempt: false, pin: cur.session_id ? provider : null });
        return;
      }
      case 'rate_limit':
        ctx.capacity.recordFailure(provider, f);
        release({ status: 'queued', notBefore: ctx.capacity.get(provider).reset_at ?? now + 60_000, cls: f.cls, message: f.message, countAttempt: false });
        return;
      case 'auth':
        ctx.capacity.recordFailure(provider, f);
        ctx.policy.request('provider_reauthentication', `${provider} authentication is missing or expired. Re-authenticate on the server: ${provider === 'claude' ? '`claude login` (or `claude setup-token`)' : '`codex login --device-auth`'}`, { requestedBy: 'supervisor', dedup: `reauth:${provider}:${ctx.capacity.get(provider).failures}` });
        release({ status: 'queued', notBefore: now + 60_000, cls: f.cls, message: f.message, countAttempt: false, pin: null });
        return;
      case 'billing_policy':
        ctx.capacity.recordFailure(provider, f);
        ctx.policy.request('additional_spending', `${provider} would bill an API key; refused. Authorize API billing in config (providers.${provider}.allowApiKeyBilling) or remove the key.`, { requestedBy: 'supervisor', dedup: `billing:${provider}` });
        release({ status: 'queued', cls: f.cls, message: f.message, countAttempt: false, pin: null, clearSession: true });
        return;
      case 'interrupted':
        release({ status: 'queued', cls: f.cls, message: f.message, countAttempt: false });
        return;
      case 'tool_missing':
        ctx.capacity.recordFailure(provider, f);
        release({ status: 'queued', cls: f.cls, message: f.message, countAttempt: false, pin: null, clearSession: true });
        return;
      default: {
        ctx.capacity.recordFailure(provider, f);
        if (f.cls === 'policy_refusal' || cur.attempts >= cur.max_attempts) {
          ctx.queue.fail(task.id, this.instanceId, 'dead', f.cls, f.message);
          ctx.events.emit('task.dead', `${task.kind} exhausted ${cur.attempts} attempt(s): ${f.cls}`, { projectId: task.project_id, taskId: task.id, level: 'error' });
          return;
        }
        const steps = ctx.cfg.recovery.transientBackoffSec;
        const delay = steps[Math.min(cur.attempts - 1, steps.length - 1)]! * 1000;
        if (f.cls === 'invalid_output') ctx.queue.updateInput(task.id, { resume_reason: `your previous final answer was rejected: ${f.message}. Return a corrected JSON object.` });
        else ctx.queue.updateInput(task.id, { resume_reason: `previous attempt ended with ${f.cls}: ${f.message.slice(0, 300)}` });
        release({ status: 'queued', notBefore: now + delay, cls: f.cls, message: f.message, countAttempt: true, clearSession: f.cls === 'context_overflow' });
      }
    }
  }

  runningTasks(): string[] { return [...this.running.keys()]; }

  /** Wait until all in-flight agent runs and deterministic jobs have finished (tests / drain). */
  async settle(): Promise<void> {
    for (let i = 0; i < 100 && (this.running.size || this.workflow.jobCount()); i++) {
      await Promise.allSettled([...this.running.values()].map((r) => r.promise));
      await this.workflow.drainJobs();
    }
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Only reap processes that were started for this exact task (verified via their environment). */
function isOrphanAgent(pid: number, taskId: string): boolean {
  if (!isAlive(pid)) return false;
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`ORCH_TASK_ID=${taskId}`);
  } catch {
    return false;
  }
}

export function listOrphanCandidates(): number[] {
  try { return readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number); } catch { return []; }
}
