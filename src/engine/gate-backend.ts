// Where untrusted gate commands run: 'local' (bubblewrap on this host) or 'devvm' (a throwaway VM on the gaming PC).
// The backend is chosen explicitly in config, recorded in the audit log at every supervisor start, and reported by
// `doctor`. A configured backend that is unavailable makes gates WAIT (retried after vm.unavailableRetryMin) or fail
// closed; gates never fall back to running on this host.
import type { Config } from '../core/config.js';
import type { Ctx } from './ctx.js';
import { checkDevVmExecutable, devvm, devvmSupportsStatusFile } from '../vm/devvm.js';

export type GateBackendKind = 'local' | 'devvm';

export class GateBackendUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'GateBackendUnavailableError'; }
}

interface State { checked: boolean; blocked: string | null; recheckAt: number; holdUntil: number; holdReason: string | null }
const states = new WeakMap<Config, State>();
function state(cfg: Config): State {
  let s = states.get(cfg);
  if (!s) { s = { checked: false, blocked: null, recheckAt: 0, holdUntil: 0, holdReason: null }; states.set(cfg, s); }
  return s;
}

export function gateBackendKind(cfg: Config): GateBackendKind {
  return cfg.security.gateBackend ?? 'local';
}

/** Supervisor start: audit the selection, verify the VM backend's executable, and note whether the host is awake. */
export async function gateBackendSelfCheck(ctx: Ctx): Promise<void> {
  const kind = gateBackendKind(ctx.cfg);
  const s = state(ctx.cfg);
  s.checked = true;
  ctx.events.audit('supervisor', 'security.gate_backend', { detail: { backend: kind, ...(kind === 'devvm' ? { command: ctx.cfg.vm.command, network: ctx.cfg.security.gateNetwork } : {}) } });
  if (kind === 'local') return;
  const problem = checkDevVmExecutable(ctx.cfg.vm.command);
  s.blocked = problem ? `VM gate backend unusable: ${problem}. Gates will not run (they never fall back to this host).` : null;
  s.recheckAt = ctx.clock.now() + ctx.cfg.vm.unavailableRetryMin * 60_000;
  if (s.blocked) {
    ctx.events.emit('security.vm_backend_unavailable', s.blocked, { level: 'error' });
    ctx.events.audit('supervisor', 'security.vm_backend_unavailable', { detail: { reason: problem } });
    return;
  }
  const r = await devvm(ctx.cfg.vm.command!, ['reachable'], { timeoutMs: 20_000 });
  let awake: boolean | null = null;
  try { awake = r.exitCode === 0 ? !!JSON.parse(r.stdout).reachable : null; } catch { awake = null; }
  if (awake === null) {
    // devvm itself cannot work (e.g. its config.json is missing): gates will wait; say so plainly at start.
    const why = `devvm cannot query the VM host: ${(r.stderr || r.spawnError || `exit ${r.exitCode}`).trim().slice(0, 300)}`;
    ctx.events.emit('security.vm_backend_unavailable', `${why}. Gates will wait until this is fixed (they never run on this host).`, { level: 'error' });
    ctx.events.audit('supervisor', 'security.vm_backend_unavailable', { detail: { reason: why } });
    return;
  }
  if (!(await devvmSupportsStatusFile(ctx.cfg.vm.command!))) {
    s.blocked = `the devvm at ${ctx.cfg.vm.command} is outdated (no gate --status-file): reinstall it from deploy/devvm/devvm. Gates will not run until then.`;
    ctx.events.emit('security.vm_backend_unavailable', s.blocked, { level: 'error' });
    ctx.events.audit('supervisor', 'security.vm_backend_unavailable', { detail: { reason: 'devvm lacks --status-file' } });
    return;
  }
  const where = awake ? 'host reachable' : 'host asleep or unreachable; gates will wake it on demand';
  ctx.events.emit('security.vm_backend_ok', `quality gates run in throwaway VMs via ${ctx.cfg.vm.command} (${where})`, { level: 'info' });
}

/** Throws GateBackendUnavailableError when gates must not run now (misconfigured backend, or waiting after an outage). */
export function assertGatesRunnable(ctx: Ctx): void {
  if (gateBackendKind(ctx.cfg) === 'local') return;
  const s = state(ctx.cfg);
  if (!s.checked) {
    // Outside a supervisor (CLI, tests): still verify the executable before exporting any source.
    const problem = checkDevVmExecutable(ctx.cfg.vm.command);
    s.blocked = problem ? `VM gate backend unusable: ${problem}` : null;
    s.recheckAt = ctx.clock.now() + ctx.cfg.vm.unavailableRetryMin * 60_000;
    s.checked = true;
  }
  if (s.blocked && ctx.clock.now() >= s.recheckAt) {
    // The operator may have fixed the executable: re-check once per retry interval, no restart needed.
    const problem = checkDevVmExecutable(ctx.cfg.vm.command);
    s.recheckAt = ctx.clock.now() + ctx.cfg.vm.unavailableRetryMin * 60_000;
    if (!problem) { s.blocked = null; ctx.events.emit('security.vm_backend_ok', `VM gate backend usable again: ${ctx.cfg.vm.command}`, { level: 'info' }); }
    else s.blocked = `VM gate backend unusable: ${problem}. Gates will not run (they never fall back to this host).`;
  }
  if (s.blocked) throw new GateBackendUnavailableError(s.blocked);
  if (ctx.clock.now() < s.holdUntil) throw new GateBackendUnavailableError(`VM backend unavailable; retrying after ${new Date(s.holdUntil).toISOString()}: ${s.holdReason}`);
}

/** The backend could not run a gate: wait, and tell the operator once per outage. */
export function holdGates(ctx: Ctx, reason: string): void {
  const s = state(ctx.cfg);
  const first = !s.holdReason;
  s.holdUntil = ctx.clock.now() + ctx.cfg.vm.unavailableRetryMin * 60_000;
  s.holdReason = reason.slice(0, 500);
  if (first) {
    ctx.events.emit('gates.backend_unavailable', `quality gates are waiting for the VM backend: ${s.holdReason}`, { level: 'warn', data: { retryAt: s.holdUntil } });
    ctx.events.audit('supervisor', 'gates.backend_unavailable', { detail: { reason: s.holdReason } });
  }
}

export function gatesRanOk(ctx: Ctx): void {
  const s = state(ctx.cfg);
  if (!s.holdReason) return;
  s.holdReason = null;
  s.holdUntil = 0;
  ctx.events.emit('gates.backend_available', 'the VM backend is running quality gates again', { level: 'info' });
}

export function gateBackendStatus(cfg: Config): { backend: GateBackendKind; command: string | null; blocked: string | null; waitingUntil: number | null; reason: string | null } {
  const s = state(cfg);
  return { backend: gateBackendKind(cfg), command: gateBackendKind(cfg) === 'devvm' ? cfg.vm.command : null, blocked: s.blocked, waitingUntil: s.holdReason ? s.holdUntil : null, reason: s.holdReason };
}
