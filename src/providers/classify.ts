// Failure classification. Provider-structured signals (Claude rate_limit_event, Codex
// codexErrorInfo) take precedence over message parsing; parsing is a documented fallback.
import type { FailureClass } from '../core/types.js';
import type { ExecFailure } from './types.js';

const UNIT_MS: Record<string, number> = {
  second: 1000, sec: 1000, s: 1000, minute: 60_000, min: 60_000, m: 60_000, hour: 3_600_000, hr: 3_600_000, h: 3_600_000,
  day: 86_400_000, d: 86_400_000, week: 604_800_000, w: 604_800_000,
};

/** Parse "try again in 2 days 3 hours 5 minutes" / "in 45s" / "resets in 3h 20m" relative durations. */
export function parseRelativeDuration(text: string): number | null {
  const m = /(?:try again in|retry in|resets? in|available in|wait)\s+((?:\d+(?:\.\d+)?\s*(?:weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(text);
  if (!m) return null;
  let total = 0;
  const re = /(\d+(?:\.\d+)?)\s*(weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[1]!))) {
    const unit = p[2]!.toLowerCase().replace(/s$/, '');
    const ms = UNIT_MS[unit] ?? UNIT_MS[unit[0]!];
    if (ms) total += parseFloat(p[1]!) * ms;
  }
  return total > 0 ? total : null;
}

/** Extract an absolute reset time (epoch ms) from provider text, relative to `now`. */
export function parseResetTime(text: string, now: number): { at: number; source: 'parsed' } | null {
  // Legacy Claude format: "Claude AI usage limit reached|1735689600"
  const pipe = /limit reached\|(\d{10,13})/i.exec(text);
  if (pipe) {
    const n = Number(pipe[1]);
    return { at: n < 1e12 ? n * 1000 : n, source: 'parsed' };
  }
  const keyed = /"?(resets_at|resetsAt|reset_at)"?\s*[:=]\s*"?(\d{10,13})/i.exec(text);
  if (keyed) {
    const n = Number(keyed[2]);
    return { at: n < 1e12 ? n * 1000 : n, source: 'parsed' };
  }
  const secs = /"?(resets_in_seconds|retry_after|retry-after)"?\s*[:=]\s*"?(\d+)/i.exec(text);
  if (secs) return { at: now + Number(secs[2]) * 1000, source: 'parsed' };
  const rel = parseRelativeDuration(text);
  if (rel) return { at: now + rel, source: 'parsed' };
  const iso = /(?:try again at|resets? at|resets|until)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (iso) {
    const t = Date.parse(iso[1]!);
    if (Number.isFinite(t)) return { at: t, source: 'parsed' };
  }
  const clock = parseClockTime(text, now);
  if (clock) return { at: clock, source: 'parsed' };
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function to24(h: number, ap: string | undefined): number {
  if (!ap) return h;
  const pm = ap.toLowerCase() === 'pm';
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

/**
 * Parse local-time reset phrases emitted by the provider CLIs (they run on this host, so
 * host-local time is the correct interpretation):
 *   Codex:  "try again at 3:15 PM" | "try again at Dec 3rd, 2026 4:05 PM"
 *   Claude: "resets 3:45pm" | "resets Mon 12:00am" | "resets 3pm (Europe/London)"
 */
export function parseClockTime(text: string, now: number): number | null {
  const full = /(?:try again at|resets?(?: at)?)\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(text);
  if (full) {
    const mon = MONTHS.indexOf(full[1]!.toLowerCase());
    if (mon >= 0) {
      const d = new Date(Number(full[3]), mon, Number(full[2]), to24(Number(full[4]), full[6]), Number(full[5] ?? 0), 0, 0);
      return d.getTime();
    }
  }
  const m = /(?:try again at|resets?(?: at)?)\s+(?:([A-Za-z]{3})[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i.exec(text);
  if (!m) return null;
  const base = new Date(now);
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), to24(Number(m[2]), m[4]), Number(m[3] ?? 0), 0, 0);
  const dow = m[1] ? DAYS.indexOf(m[1].toLowerCase()) : -1;
  if (dow >= 0) {
    let add = (dow - d.getDay() + 7) % 7;
    if (add === 0 && d.getTime() <= now) add = 7;
    d.setDate(d.getDate() + add);
  } else if (d.getTime() <= now) {
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

function limitKind(text: string): string {
  if (/5-hour|five[_ -]hour|session limit/i.test(text)) return 'five_hour';
  if (/weekly|seven[_ -]day|7-day/i.test(text)) return 'seven_day';
  if (/(opus|sonnet|haiku|gpt-[\w.-]+|model)[^.]{0,30}limit/i.test(text)) return 'model';
  return 'unknown';
}

const RULES: Array<[FailureClass, RegExp]> = [
  ['usage_limit', /usage limit|usageLimitExceeded|usage_limit_reached|limit reached|hit your (?:[\w-]+ )?limit|out of (?:usage|credits)|quota exceeded|insufficient_quota|plan limit|weekly limit|credits depleted/i],
  ['auth', /\b401\b|unauthori[sz]ed|authentication[_ ](?:error|failed|required)|not logged in|please run \/?login|invalid api key|oauth token (?:has )?expired|token expired|login required|requiresOpenaiAuth|missing bearer/i],
  ['context_overflow', /context window|contextWindowExceeded|prompt is too long|maximum context length|context_length_exceeded/i],
  ['rate_limit', /\b429\b|rate[ _-]?limit|too many requests|rateLimitExceeded/i],
  ['policy_refusal', /cyberPolicy|bioPolicy|misalignmentPolicy|usage policy|policy violation/i],
  ['transient', /overloaded|\b5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|stream disconnected|network error|internal server error|serverOverloaded|service unavailable|bad gateway/i],
];

export function classifyText(text: string, now: number): ExecFailure {
  for (const [cls, re] of RULES) {
    if (re.test(text)) {
      const f: ExecFailure = { cls, message: text.slice(0, 2000) };
      if (cls === 'usage_limit' || cls === 'rate_limit') {
        const r = parseResetTime(text, now);
        f.resetAt = r?.at ?? null;
        f.resetSource = r ? 'parsed' : 'none';
        f.limitKind = cls === 'usage_limit' ? limitKind(text) : 'short_term';
        const mm = /(opus|sonnet|haiku|gpt-[\w.-]+)/i.exec(text);
        if (f.limitKind === 'model' && mm) f.model = mm[1]!.toLowerCase();
      }
      return f;
    }
  }
  return { cls: 'unknown', message: text.slice(0, 2000) };
}

/** Map Codex app-server/exec CodexErrorInfo codes to failure classes. */
export function classifyCodexErrorInfo(info: unknown): FailureClass | null {
  const code = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : null;
  switch (code) {
    case 'usageLimitExceeded': return 'usage_limit';
    case 'rateLimitExceeded': return 'rate_limit';
    case 'unauthorized': return 'auth';
    case 'contextWindowExceeded': return 'context_overflow';
    case 'apiKeySpendLimitExceeded': case 'projectSpendLimitExceeded': case 'organizationSpendLimitExceeded': case 'sessionBudgetExceeded':
      return 'billing_policy';
    case 'serverOverloaded': case 'internalServerError': case 'httpConnectionFailed': case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected': case 'responseTooManyFailedAttempts': case 'flexUnavailable': case 'policyCapacityUnavailable':
      return 'transient';
    case 'cyberPolicy': case 'bioPolicy': case 'misalignmentPolicyViolation': return 'policy_refusal';
    case 'modelNotFound': return 'tool_missing';
    default: return null;
  }
}

/** Retryability policy used by the scheduler. */
export function isRetryable(cls: FailureClass): boolean {
  return !['auth', 'billing_policy', 'policy_refusal', 'tool_missing'].includes(cls);
}
