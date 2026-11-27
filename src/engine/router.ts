// Provider routing: required capability, complexity, availability, observed reliability,
// workload, model availability, operator preference and cross-provider review preference.
import type { Config } from '../core/config.js';
import { json } from '../core/db.js';
import type { Complexity, ProviderId, TaskRow } from '../core/types.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { CapacityManager } from './capacity.js';
import type { TaskQueue } from './queue.js';

export type RouteDecision =
  | { provider: ProviderId; model: string | null; effort: string | null; resume: boolean; note?: string }
  | { wait: string; until?: number | null };

const ESCALATE: Partial<Record<TaskRow['kind'], Complexity>> = {
  plan: 'high', security_review: 'high', debate_decide: 'high', investigate: 'high', completion_audit: 'high',
  integration_audit: 'medium', answer: 'medium',
};

export class Router {
  constructor(private cfg: Config, private adapters: Map<string, ProviderAdapter>, private capacity: CapacityManager, private queue: TaskQueue) {}

  effectiveComplexity(t: TaskRow): Complexity {
    const esc = ESCALATE[t.kind];
    const rank = { low: 0, medium: 1, high: 2 } as const;
    return esc && rank[esc] > rank[t.complexity] ? esc : t.complexity;
  }

  private slotFree(p: ProviderId): boolean {
    const pc = this.cfg.providers[p];
    if (!pc) return false;
    const running = this.queue.runningCount({ provider: p });
    const d = this.capacity.dispatchability(p);
    if (d === 'no') return false;
    const limit = d === 'canary' || this.capacity.nearLimit(p) ? 1 : pc.maxConcurrent;
    return running < limit;
  }

  /** Choose a model for the complexity tier, downgrading only when the task is not security-critical. */
  private pickModel(p: ProviderId, c: Complexity, t: TaskRow): { model: string | null; effort: string | null } | null {
    const pc = this.cfg.providers[p]!;
    const tiers: Complexity[] = c === 'high' ? ['high', 'medium'] : c === 'medium' ? ['medium', 'high', 'low'] : ['low', 'medium'];
    const allowDowngrade = t.kind !== 'security_review' && c !== 'high';
    for (const tier of allowDowngrade ? tiers : [c]) {
      const m = pc.models[tier];
      if (!m || !this.capacity.modelLimited(p, m)) return { model: m, effort: pc.effort[c] };
    }
    return null;
  }

  route(t: TaskRow, preference: ProviderId[] = this.cfg.routing.preferOrder): RouteDecision {
    const enabled = [...this.adapters.keys()].filter((p) => this.cfg.providers[p]?.enabled);
    if (!enabled.length) return { wait: 'no providers enabled' };
    const complexity = this.effectiveComplexity(t);
    const excluded = new Set(json<string[]>(t.exclude_providers, []));

    // Session continuity: a pinned task resumes natively on its provider unless failover is justified.
    if (t.provider_pinned && enabled.includes(t.provider_pinned)) {
      const p = t.provider_pinned;
      const mm = this.pickModel(p, complexity, t);
      if (this.slotFree(p) && mm) return { provider: p, ...mm, resume: !!t.session_id && t.session_provider === p };
      const wait = this.capacity.expectedWaitMs(p);
      const others = enabled.filter((o) => o !== p && this.capacity.dispatchability(o) !== 'no');
      const failoverMs = this.cfg.routing.failoverAfterMinutes * 60_000;
      if (wait !== null && wait <= failoverMs) return { wait: `waiting ${Math.round(wait / 60000)}m for ${p} (session continuity)`, until: this.capacity.get(p).reset_at };
      if (!others.length) return { wait: `pinned provider ${p} unavailable; no alternative`, until: this.capacity.get(p).reset_at };
      // fall through: failover with context reconstruction from checkpoints (resume=false)
    }

    type Cand = { p: ProviderId; score: number; mm: { model: string | null; effort: string | null } };
    const cands: Cand[] = [];
    for (const p of enabled) {
      if (!this.slotFree(p)) continue;
      const mm = this.pickModel(p, complexity, t);
      if (!mm) continue;
      const s = this.capacity.get(p);
      const reliability = (s.successes + 1) / (s.successes + s.failures + 2);
      const pc = this.cfg.providers[p]!;
      const load = this.queue.runningCount({ provider: p }) / Math.max(1, pc.maxConcurrent);
      const prefIdx = preference.indexOf(p);
      const pref = prefIdx < 0 ? 0 : (preference.length - prefIdx) * 0.05;
      let score = reliability - load * 0.5 + pref;
      if (excluded.has(p)) score -= 10; // cross-provider review preference
      cands.push({ p, score, mm });
    }
    if (!cands.length) {
      // Busy (slots full on an available provider) → stay queued; only park until a reset when no provider can run.
      const anyUsable = enabled.some((p) => this.capacity.dispatchability(p) !== 'no');
      if (anyUsable) return { wait: 'all usable providers are busy' };
      return { wait: 'no provider capacity available', until: this.capacity.nextChangeAt() };
    }
    cands.sort((a, b) => b.score - a.score);
    const best = cands[0]!;
    if (excluded.has(best.p)) {
      // Only excluded providers have a free slot. Wait briefly for the preferred one when it is merely busy
      // or about to reset; otherwise proceed (agent-level independence is still enforced).
      const preferred = enabled.filter((p) => !excluded.has(p));
      const soon = preferred.some((p) => {
        const w = this.capacity.expectedWaitMs(p);
        return w !== null && w <= this.cfg.routing.failoverAfterMinutes * 60_000;
      });
      if (soon) return { wait: 'waiting for cross-provider reviewer capacity' };
      return { provider: best.p, ...best.mm, resume: false, note: 'same provider as excluded (cross-provider unavailable)' };
    }
    const resume = !!t.session_id && t.session_provider === best.p;
    return { provider: best.p, ...best.mm, resume, note: t.provider_pinned && t.provider_pinned !== best.p ? `failover from ${t.provider_pinned}` : undefined };
  }
}
