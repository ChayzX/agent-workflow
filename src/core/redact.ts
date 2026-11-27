// Redaction of secrets from logs, events, prompts persisted to disk and release artifacts.
const PATTERNS: Array<[RegExp, string]> = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-[REDACTED]'],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA[REDACTED]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox-[REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/(authorization|bearer|token|password|secret|api[_-]?key)(["'\s:=]+)([^\s"',]{8,})/gi, '$1$2[REDACTED]'],
];

const extraSecrets = new Set<string>();
/** Register exact secret values loaded at runtime so they are always scrubbed. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) extraSecrets.add(value);
}

export function redact(input: string): string {
  let out = input;
  for (const s of extraSecrets) out = out.split(s).join('[REDACTED]');
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactValue<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as T;
  if (Array.isArray(v)) return v.map((x) => redactValue(x)) as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      o[k] = /token|secret|password|api[_-]?key|authorization/i.test(k) && typeof val === 'string' ? '[REDACTED]' : redactValue(val);
    }
    return o as T;
  }
  return v;
}
