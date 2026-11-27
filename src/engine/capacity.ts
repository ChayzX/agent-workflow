// Provider availability and usage-limit recovery. Independent state per provider.
// - Usage exhaustion uses provider-reported reset times when available, otherwise bounded backoff.
// - After a reset passes, the provider enters 'recovering': a non-model probe (Codex app-server)
//   or a single canary task (Claude) confirms capacity before full concurrency resumes.
// - Authentication expiry is tracked separately and only cleared by a passing auth check.
import type { Db } from '../core/db.js';
import { json } from '../core/db.js';
import type { Clock } from '../core/clock.js';
import type { Config } from '../core/config.js';
import type { EventLog } from '../core/events.js';
import type { ProviderId, ProviderStatus } from '../core/types.js';
import type { ExecFailure, ProviderAdapter, RateLimitObservation } from '../providers/types.js';

export interface ProviderStateRow {
  provider: string;
  status: ProviderStatus;
  limit_kind: string | null;
  reset_at: number | null;
  next_probe_at: number | null;
  backoff_level: number;
  consecutive_failures: number;
  successes: number;
  failures: number;
  windows: string;
  model_limits: string;
  details: string;
  reset_source: string | null;
  updated_at: number;
}

export class CapacityManager {
  constructor(private db: Db, private clock: Clock, private cfg: Config, private events: EventLog) {}

  get(provider: ProviderId): ProviderStateRow {
    let row = this.db.get<ProviderStateRow>('SELECT * FROM provider_state WHERE provider = ?', provider);
    if (!row) {
      this.db.run("INSERT OR IGNORE INTO provider_state(provider, status, updated_at) VALUES (?, 'available', ?)", provider, this.clock.now());
      row = this.db.get<ProviderStateRow>('SELECT * FROM provider_state WHERE provider = ?', provider)!;
    }
    return row;
  }

  all(): ProviderStateRow[] {
    return this.db.all<ProviderStateRow>('SELECT * FROM provider_state ORDER BY provider');
  }

  private set(provider: ProviderId, patch: Partial<ProviderStateRow>, reason: string): void {
    const before = this.get(provider);
    const next = { ...before, ...patch, updated_at: this.clock.now() };
    this.db.run(
      `UPDATE provider_state SET status=?, limit_kind=?, reset_at=?, next_probe_at=?, backoff_level=?, consecutive_failures=?,
         successes=?, failures=?, windows=?, model_limits=?, details=?, reset_source=?, updated_at=? WHERE provider=?`,
      next.status, next.limit_kind, next.reset_at, next.next_probe_at, next.backoff_level, next.consecutive_failures,
      next.successes, next.failures, next.windows, next.model_limits, next.details, next.reset_source, next.updated_at, provider,
    );
    if (before.status !== next.status) {
      this.events.emit('provider.status', `${provider}: ${before.status} → ${next.status} (${reason})`, {
        level: next.status === 'available' ? 'info' : 'warn',
        data: { provider, from: before.status, to: next.status, resetAt: next.reset_at, resetSource: next.reset_source, limitKind: next.limit_kind },
      });
    }
  }

  /** Can a task be dispatched to this provider now? 'canary' means at most one concurrent task. */
  dispatchability(provider: ProviderId, model?: string | null): 'yes' | 'canary' | 'no' {
    const pc = this.cfg.providers[provider];
    if (!pc?.enabled) return 'no';
    const s = this.get(provider);
    if (model) {
      const ml = json<Record<string, number>>(s.model_limits, {});
      if (ml[model] && ml[model]! > this.clock.now()) return 'no';
    }
    switch (s.status) {
      case 'available': return 'yes';
      case 'recovering': return 'canary';
      default: return 'no';
    }
  }

  modelLimited(provider: ProviderId, model: string): boolean {
    const ml = json<Record<string, number>>(this.get(provider).model_limits, {});
    return !!ml[model] && ml[model]! > this.clock.now();
  }

  /** Expected time until this provider can run work again (ms), or null if unknown/never. */
  expectedWaitMs(provider: ProviderId): number | null {
    const s = this.get(provider);
    if (s.status === 'available' || s.status === 'recovering') return 0;
    if ((s.status === 'exhausted' || s.status === 'throttled') && s.reset_at) return Math.max(0, s.reset_at - this.clock.now());
    return null;
  }

  recordSuccess(provider: ProviderId, rateLimits: RateLimitObservation[] = []): void {
    const s = this.get(provider);
    this.set(provider, {
      status: 'available', reset_at: null, limit_kind: null, reset_source: null, next_probe_at: null, backoff_level: 0,
      consecutive_failures: 0, successes: s.successes + 1,
      windows: rateLimits.length ? JSON.stringify(mergeWindows(json(s.windows, {}), rateLimits)) : s.windows,
    }, 'task succeeded');
    this.observe(provider, rateLimits);
  }

  /** Observe provider-reported windows (e.g. Claude rate_limit_event) for proactive throttling. */
  observe(provider: ProviderId, rateLimits: RateLimitObservation[]): void {
    if (!rateLimits.length) return;
    const s = this.get(provider);
    const windows = mergeWindows(json(s.windows, {}), rateLimits);
    const rejected = rateLimits.filter((w) => w.status === 'rejected');
    const nearly = rateLimits.filter((w) => (w.utilization ?? 0) >= this.cfg.recovery.proactiveUtilization && w.resetsAt);
    if (rejected.length) {
      const resetAt = Math.max(...rejected.map((w) => w.resetsAt ?? 0)) || null;
      this.markExhausted(provider, { cls: 'usage_limit', message: 'provider reported rejected rate-limit window', resetAt, resetSource: resetAt ? 'provider' : 'none', limitKind: rejected[0]!.window });
      return;
    }
    const details = json<Record<string, unknown>>(s.details, {});
    details.nearLimit = nearly.length ? nearly.map((w) => ({ window: w.window, utilization: w.utilization, resetsAt: w.resetsAt })) : undefined;
    this.db.run('UPDATE provider_state SET windows=?, details=?, updated_at=? WHERE provider=?', JSON.stringify(windows), JSON.stringify(details), this.clock.now(), provider);
  }

  /** True when the provider reports it is nearly exhausted: dispatch conservatively (one at a time). */
  nearLimit(provider: ProviderId): boolean {
    const d = json<{ nearLimit?: unknown[] }>(this.get(provider).details, {});
    return Array.isArray(d.nearLimit) && d.nearLimit.length > 0;
  }

  recordFailure(provider: ProviderId, f: ExecFailure): void {
    const s = this.get(provider);
    const base = { failures: s.failures + 1, consecutive_failures: s.consecutive_failures + 1 };
    switch (f.cls) {
      case 'usage_limit':
        if (f.limitKind === 'model' && f.model) {
          const ml = json<Record<string, number>>(s.model_limits, {});
          ml[f.model] = f.resetAt ?? this.clock.now() + this.backoffMs(s.backoff_level);
          this.db.run('UPDATE provider_state SET model_limits=?, failures=?, updated_at=? WHERE provider=?', JSON.stringify(ml), base.failures, this.clock.now(), provider);
          this.events.emit('provider.model_limit', `${provider}: model ${f.model} limited until ${new Date(ml[f.model]!).toISOString()}`, { level: 'warn' });
          return;
        }
        this.markExhausted(provider, f);
        return;
      case 'rate_limit': {
        const until = f.resetAt ?? this.clock.now() + 60_000 * Math.min(2 ** s.consecutive_failures, 15);
        this.set(provider, { ...base, status: 'throttled', reset_at: until, reset_source: f.resetAt ? 'provider' : 'backoff', limit_kind: 'short_term' }, 'rate limited');
        return;
      }
      case 'auth':
        this.set(provider, { ...base, status: 'auth_required', next_probe_at: this.clock.now() + this.cfg.recovery.authCheckMinutes * 60_000, details: JSON.stringify({ ...json(s.details, {}), auth: f.message.slice(0, 300) }) }, 'authentication required');
        return;
      case 'billing_policy':
        this.set(provider, { ...base, status: 'disabled', details: JSON.stringify({ ...json(s.details, {}), disabledReason: f.message.slice(0, 300) }) }, 'unauthorized billing mode');
        return;
      case 'tool_missing':
        this.set(provider, { ...base, status: 'unavailable', next_probe_at: this.clock.now() + 10 * 60_000 }, 'CLI unavailable');
        return;
      default:
        this.db.run('UPDATE provider_state SET failures=?, consecutive_failures=?, updated_at=? WHERE provider=?', base.failures, base.consecutive_failures, this.clock.now(), provider);
    }
  }

  private markExhausted(provider: ProviderId, f: ExecFailure): void {
    const s = this.get(provider);
    const now = this.clock.now();
    const level = f.resetAt ? s.backoff_level : s.backoff_level + 1;
    // Never trust a reset in the past or absurdly far away; clamp to [1 min, 8 days].
    const resetAt = f.resetAt ? Math.min(Math.max(f.resetAt, now + 60_000), now + 8 * 86_400_000) : now + this.backoffMs(s.backoff_level);
    this.set(provider, {
      status: 'exhausted', reset_at: resetAt, reset_source: f.resetAt ? (f.resetSource ?? 'provider') : 'backoff', limit_kind: f.limitKind ?? 'unknown',
      backoff_level: level, failures: s.failures + 1, consecutive_failures: s.consecutive_failures + 1, next_probe_at: resetAt,
    }, `usage limit (${f.limitKind ?? 'unknown'})`);
  }

  private backoffMs(level: number): number {
    const steps = this.cfg.recovery.backoffMinutes;
    return steps[Math.min(level, steps.length - 1)]! * 60_000;
  }

  /** Canary failed again after recovery: escalate backoff. */
  canaryFailed(provider: ProviderId, f: ExecFailure): void {
    this.markExhausted(provider, f);
  }

  /**
   * Periodic deterministic maintenance — no model calls:
   *  exhausted/throttled + reset passed → recovering (Codex: non-model probe first)
   *  auth_required/unavailable → re-check with CLI status commands
   */
  async tick(adapters: Map<string, ProviderAdapter>): Promise<void> {
    const now = this.clock.now();
    for (const [id, adapter] of adapters) {
      if (!this.cfg.providers[id]?.enabled) continue;
      const s = this.get(id);
      if ((s.status === 'exhausted' || s.status === 'throttled') && s.reset_at && s.reset_at <= now) {
        if (adapter.capabilities().capacityProbe === 'non-model') {
          const p = await adapter.probeCapacity().catch(() => null);
          if (p?.available === false) {
            const resetAt = p.resetAt && p.resetAt > now ? p.resetAt : null;
            this.markExhausted(id, { cls: 'usage_limit', message: p.detail ?? 'probe: still limited', resetAt, resetSource: resetAt ? 'provider' : 'none', limitKind: s.limit_kind });
            continue;
          }
          if (p?.windows.length) this.db.run('UPDATE provider_state SET windows=? WHERE provider=?', JSON.stringify(mergeWindows(json(s.windows, {}), p.windows)), id);
          this.set(id, { status: p?.available ? 'available' : 'recovering', next_probe_at: null }, p?.available ? 'probe confirmed capacity' : 'reset time passed');
        } else {
          this.set(id, { status: 'recovering', next_probe_at: null }, 'reset time passed; canary task allowed');
        }
      } else if ((s.status === 'auth_required' || s.status === 'unavailable') && (s.next_probe_at ?? 0) <= now) {
        const ok = s.status === 'auth_required' ? (await adapter.checkAuth().catch(() => ({ ok: false }))).ok : (await adapter.detect().catch(() => ({ installed: false }))).installed;
        if (ok) this.set(id, { status: 'available', next_probe_at: null, consecutive_failures: 0 }, 'auth/CLI check passed');
        else this.db.run('UPDATE provider_state SET next_probe_at=? WHERE provider=?', now + this.cfg.recovery.authCheckMinutes * 60_000, id);
      }
      // Prune expired model-specific limits.
      const ml = json<Record<string, number>>(s.model_limits, {});
      const pruned = Object.fromEntries(Object.entries(ml).filter(([, t]) => t > now));
      if (Object.keys(pruned).length !== Object.keys(ml).length) this.db.run('UPDATE provider_state SET model_limits=? WHERE provider=?', JSON.stringify(pruned), id);
    }
  }

  /** Earliest time at which some unavailable provider may become available (for sleeping). */
  nextChangeAt(): number | null {
    const times = this.all().filter((s) => s.status !== 'available' && s.status !== 'disabled').map((s) => s.reset_at ?? s.next_probe_at ?? null).filter((t): t is number => !!t);
    return times.length ? Math.min(...times) : null;
  }

  /** Operator: re-enable a provider (e.g. after re-authentication or authorizing billing). */
  reset(provider: ProviderId, reason = 'operator reset'): void {
    this.set(provider, { status: 'available', reset_at: null, next_probe_at: null, backoff_level: 0, consecutive_failures: 0, limit_kind: null, reset_source: null }, reason);
  }
}

function mergeWindows(prev: Record<string, RateLimitObservation>, obs: RateLimitObservation[]): Record<string, RateLimitObservation> {
  const out = { ...prev };
  for (const o of obs) out[o.window] = o;
  return out;
}
