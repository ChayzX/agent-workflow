// Deterministic simulated provider for repeatable failure testing and offline demos.
// It is clearly labelled 'simulated' everywhere it appears; it is never evidence of real
// subscription compatibility. A behaviour function decides each invocation's outcome and may
// edit files in the task's worktree exactly as a real agent would.
import { randomUUID } from 'node:crypto';
import type { Clock } from '../core/clock.js';
import type {
  AuthResult, CapacityProbe, DetectResult, ExecFailure, ExecRequest, ExecResult, ProviderAdapter, ProviderCapabilities, RateLimitObservation,
} from './types.js';

export interface SimOutcome {
  structured?: unknown;
  text?: string;
  failure?: ExecFailure;
  rateLimits?: RateLimitObservation[];
  delayMs?: number;          // simulated execution time (real wall clock; keep small in tests)
  hang?: boolean;            // never finishes until aborted (tests kill/timeout handling)
}

export type SimBehaviour = (req: ExecRequest, ctx: { provider: string; call: number; sessionId: string; resumed: boolean }) => SimOutcome | Promise<SimOutcome>;

export interface SimCall { provider: string; req: ExecRequest; sessionId: string; resumed: boolean; at: number }

export class SimulatedAdapter implements ProviderAdapter {
  calls: SimCall[] = [];
  authOk = true;
  capacity: CapacityProbe | null = null;
  private n = 0;
  constructor(readonly id: string, private clock: Clock, public behaviour: SimBehaviour, private caps: Partial<ProviderCapabilities> = {}) {}

  capabilities(): ProviderCapabilities {
    return {
      nonInteractive: true, structuredOutput: 'json-schema', streamingEvents: true, sessionIds: true, resume: true,
      modelSelection: true, reasoningSelection: true, workdirIsolation: true, sandboxModes: ['read-only', 'workspace-write'],
      cancellation: true, authValidation: true, usageLimitDetection: 'provider-reset-time', capacityProbe: this.capacity ? 'non-model' : 'none',
      usageReporting: 'tokens', ...this.caps,
    };
  }

  async detect(): Promise<DetectResult> { return { installed: true, version: `simulated-${this.id}` }; }
  async checkAuth(): Promise<AuthResult> { return { ok: this.authOk, method: 'simulated', apiKeyBilling: false }; }
  async probeCapacity(): Promise<CapacityProbe | null> { return this.capacity; }

  async execute(req: ExecRequest): Promise<ExecResult> {
    const started = Date.now();
    const resumed = !!req.resumeSessionId;
    const sessionId = req.resumeSessionId ?? randomUUID();
    this.calls.push({ provider: this.id, req, sessionId, resumed, at: this.clock.now() });
    req.onSpawn?.(process.pid);
    req.onEvent?.({ kind: 'session', data: { sessionId } });
    const out = await this.behaviour(req, { provider: this.id, call: ++this.n, sessionId, resumed });
    if (out.hang || out.delayMs) {
      const aborted = await new Promise<boolean>((resolve) => {
        if (req.signal?.aborted) return resolve(true);
        const t = out.hang ? null : setTimeout(() => resolve(false), out.delayMs);
        const to = setTimeout(() => resolve(true), req.timeoutMs);
        req.signal?.addEventListener('abort', () => { if (t) clearTimeout(t); clearTimeout(to); resolve(true); }, { once: true });
      });
      if (aborted) {
        return { ok: false, sessionId, structured: null, text: '', rateLimits: [], exitCode: null, durationMs: Date.now() - started,
          failure: { cls: req.signal?.aborted ? 'interrupted' : 'timeout', message: req.signal?.aborted ? 'cancelled' : 'timed out' } };
      }
    }
    const usage = { inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: 200, cachedTokens: 0, model: req.model ?? `${this.id}-sim` };
    if (out.failure) {
      return { ok: false, sessionId, structured: null, text: out.text ?? '', rateLimits: out.rateLimits ?? [], exitCode: 1, durationMs: Date.now() - started, failure: out.failure, usage };
    }
    return { ok: true, sessionId, structured: out.structured ?? null, text: out.text ?? JSON.stringify(out.structured ?? {}), rateLimits: out.rateLimits ?? [], exitCode: 0, durationMs: Date.now() - started, usage };
  }
}
