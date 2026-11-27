// Claude Code adapter: drives the unmodified official `claude` CLI in print mode with
// stream-json output, native session ids/resume, JSON-schema structured output and
// provider-reported rate-limit events. Authentication is whatever the operator configured
// for the CLI (subscription OAuth via `claude login` / `claude setup-token`); no tokens are read.
import { uuid } from '../core/ids.js';
import type { Clock } from '../core/clock.js';
import type { ProviderConfig } from '../core/config.js';
import { classifyText } from './classify.js';
import { runProcess, runQuick } from './process.js';
import type {
  AuthResult, CapacityProbe, DetectResult, ExecRequest, ExecResult, ProviderAdapter, ProviderCapabilities, RateLimitObservation,
} from './types.js';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'];
const WRITE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite', 'Bash'];
// Defense in depth only: the agent has no GitHub credentials, and the supervisor alone pushes/merges.
const ALWAYS_DENY = ['Bash(git push:*)', 'Bash(git remote:*)', 'Bash(gh:*)', 'Bash(sudo:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'WebFetch', 'Bash(curl:*)', 'Bash(wget:*)'];

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude';
  constructor(private cfg: ProviderConfig, private clock: Clock, private baseEnv: Record<string, string>, private quickWrap: (cmd: string, args: string[]) => { cmd: string; args: string[] } = (cmd, args) => ({ cmd, args })) {}

  private quick(args: string[]) { const w = this.quickWrap(this.cfg.command, args); return runQuick(w.cmd, w.args, this.baseEnv); }

  capabilities(): ProviderCapabilities {
    return {
      nonInteractive: true, structuredOutput: 'json-schema', streamingEvents: true, sessionIds: true, resume: true,
      modelSelection: true, reasoningSelection: true, workdirIsolation: true, sandboxModes: ['read-only', 'workspace-write'],
      cancellation: true, authValidation: true, usageLimitDetection: 'provider-reset-time', capacityProbe: 'none',
      usageReporting: 'tokens+cost-estimate',
    };
  }

  async detect(): Promise<DetectResult> {
    const r = await this.quick(['--version']);
    if (r.spawnError || r.exitCode !== 0) return { installed: false, error: r.spawnError ?? r.stderr.slice(0, 300) };
    return { installed: true, version: r.stdout.trim() };
  }

  async checkAuth(): Promise<AuthResult> {
    const r = await this.quick(['auth', 'status']);
    if (r.spawnError) return { ok: false, detail: r.spawnError };
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
      const apiKey = /api[_-]?key/i.test(j.authMethod ?? '');
      return { ok: !!j.loggedIn, method: j.authMethod, apiKeyBilling: apiKey, detail: j.loggedIn ? `logged in (${j.authMethod})` : 'not logged in: run `claude login` or `claude setup-token`' };
    } catch {
      return { ok: r.exitCode === 0, detail: (r.stdout + r.stderr).slice(0, 300) };
    }
  }

  /** Claude exposes no non-model capacity endpoint; capacity is learned from rate_limit_event during runs. */
  async probeCapacity(): Promise<CapacityProbe | null> {
    return null;
  }

  buildArgs(req: ExecRequest, sessionId: string): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
    else args.push('--session-id', sessionId);
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--effort', req.effort);
    if (req.maxTurns ?? this.cfg.maxTurns) args.push('--max-turns', String(req.maxTurns ?? this.cfg.maxTurns));
    if (req.outputSchema) args.push('--json-schema', JSON.stringify(req.outputSchema));
    if (req.mode === 'read-only') {
      args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob,Bash', '--allowedTools', ...READ_ONLY_TOOLS);
    } else {
      args.push('--permission-mode', 'acceptEdits', '--allowedTools', ...WRITE_TOOLS);
    }
    args.push('--disallowedTools', ...ALWAYS_DENY);
    args.push('--permission-prompts', 'none');
    if (this.cfg.extraArgs?.length) args.push(...this.cfg.extraArgs);
    return args;
  }

  async execute(req: ExecRequest): Promise<ExecResult> {
    const sessionId = req.resumeSessionId ?? uuid();
    const args = this.buildArgs(req, sessionId);
    const env = { ...req.env };
    // Never let an ambient API key silently switch billing to the API.
    if (!this.cfg.allowApiKeyBilling) delete env.ANTHROPIC_API_KEY;
    // Claude Code's native unattended retry watchdog absorbs *short* usage-limit waits in-process.
    // Longer waits surface as failures so the supervisor can free the slot and fail over.
    if ((this.cfg.nativeRetryWaitMs ?? 0) > 0) {
      env.CLAUDE_CODE_RETRY_WATCHDOG = '1';
      env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS = String(this.cfg.nativeRetryWaitMs);
    }

    let observedSession: string | null = req.resumeSessionId ?? null;
    let resultEvent: Record<string, unknown> | null = null;
    let authSource: string | null = null;
    let billingViolation = false;
    const rateLimits: RateLimitObservation[] = [];
    const assistantText: string[] = [];
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort();
    req.signal?.addEventListener('abort', onOuterAbort, { once: true });

    const w = req.wrap ? req.wrap(this.cfg.command, args, []) : { cmd: this.cfg.command, args };
    const run = await runProcess(w.cmd, w.args, {
      cwd: req.cwd, env, stdin: req.prompt, timeoutMs: req.timeoutMs, signal: ac.signal, onSpawn: req.onSpawn,
      transcriptPath: req.transcriptPath,
      onLine: (line) => {
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line); } catch { return; }
        const type = ev.type as string;
        if (typeof ev.session_id === 'string') observedSession = ev.session_id;
        if (type === 'system' && ev.subtype === 'init') {
          authSource = (ev.apiKeySource as string) ?? null;
          req.onEvent?.({ kind: 'session', data: { sessionId: observedSession, model: ev.model, authSource } });
          if (authSource && authSource !== 'none' && !this.cfg.allowApiKeyBilling) {
            billingViolation = true;
            ac.abort();
          }
        } else if (type === 'rate_limit_event') {
          const info = (ev.rate_limit_info ?? {}) as Record<string, unknown>;
          rateLimits.push(...parseClaudeRateLimit(info));
          req.onEvent?.({ kind: 'rate_limit', data: info });
        } else if (type === 'assistant') {
          const msg = ev.message as { content?: Array<{ type: string; text?: string; name?: string }> } | undefined;
          for (const c of msg?.content ?? []) {
            if (c.type === 'text' && c.text) { assistantText.push(c.text); req.onEvent?.({ kind: 'message', text: c.text.slice(0, 2000) }); }
            if (c.type === 'tool_use') req.onEvent?.({ kind: 'tool', text: c.name });
          }
        } else if (type === 'result') {
          resultEvent = ev;
        }
      },
    });
    req.signal?.removeEventListener('abort', onOuterAbort);

    const now = this.clock.now();
    const base: Omit<ExecResult, 'ok'> = {
      sessionId: observedSession ?? sessionId, structured: null, text: '', rateLimits, exitCode: run.exitCode,
      durationMs: run.durationMs, authSource,
    };
    if (billingViolation) {
      return { ...base, ok: false, failure: { cls: 'billing_policy', message: `Claude Code reported API-key authentication (${authSource}); API billing is not authorized. Remove ANTHROPIC_API_KEY or authorize spending.` } };
    }
    if (run.spawnError) return { ...base, ok: false, failure: { cls: 'tool_missing', message: run.spawnError } };
    if (run.timedOut) return { ...base, ok: false, failure: { cls: 'timeout', message: `timed out after ${req.timeoutMs}ms` } };
    if (run.aborted) return { ...base, ok: false, failure: { cls: 'interrupted', message: 'cancelled' } };

    const rejected = rateLimits.find((r) => r.status === 'rejected');
    const res = resultEvent as Record<string, unknown> | null;
    if (res) {
      const usage = (res.usage ?? {}) as Record<string, number>;
      const modelUsage = (res.modelUsage ?? {}) as Record<string, unknown>;
      base.usage = {
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        cachedTokens: usage.cache_read_input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        costUsd: typeof res.total_cost_usd === 'number' ? res.total_cost_usd : undefined,
        model: Object.keys(modelUsage)[0] ?? null,
      };
      base.text = typeof res.result === 'string' ? res.result : assistantText.join('\n');
      base.structured = res.structured_output ?? null;
      if (res.is_error || res.subtype !== 'success') {
        const msg = `${res.subtype}: ${base.text || JSON.stringify(res.errors ?? res.api_error_status ?? '')}`;
        const failure = classifyText(msg, now);
        if (res.subtype === 'error_max_turns') failure.cls = 'task_failure';
        if (/structured_output/.test(String(res.subtype)) && failure.cls === 'unknown') failure.cls = 'invalid_output';
        if (rejected) Object.assign(failure, { cls: 'usage_limit', resetAt: rejected.resetsAt ?? failure.resetAt, resetSource: rejected.resetsAt ? 'provider' : failure.resetSource, limitKind: rejected.window });
        return { ...base, ok: false, failure };
      }
      if (req.outputSchema && base.structured === null) {
        // Fallback: some versions only put the JSON in `result`.
        try { base.structured = JSON.parse(base.text); } catch {
          return { ...base, ok: false, failure: { cls: 'invalid_output', message: 'structured output missing' } };
        }
      }
      return { ...base, ok: true };
    }
    const tail = (run.stderr + '\n' + run.stdout).slice(-3000);
    const failure = classifyText(tail, now);
    if (rejected) Object.assign(failure, { cls: 'usage_limit', resetAt: rejected.resetsAt, resetSource: 'provider', limitKind: rejected.window });
    if (failure.cls === 'unknown') failure.cls = run.signal ? 'killed' : 'unknown';
    return { ...base, ok: false, failure };
  }
}

export function parseClaudeRateLimit(info: Record<string, unknown>): RateLimitObservation[] {
  const out: RateLimitObservation[] = [];
  const st = (s: unknown): RateLimitObservation['status'] =>
    s === 'allowed' ? 'allowed' : s === 'allowed_warning' ? 'warning' : s === 'rejected' ? 'rejected' : 'unknown';
  const ms = (v: unknown) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : null);
  const windows = info.unifiedWindows as Record<string, { utilization?: number; resetsAt?: number; status?: string }> | undefined;
  if (windows) {
    for (const [name, w] of Object.entries(windows)) out.push({ window: name, status: st(w.status), utilization: w.utilization ?? null, resetsAt: ms(w.resetsAt) });
  }
  const primaryName = (info.rateLimitType as string) ?? 'unified';
  if (!out.some((o) => o.window === primaryName)) {
    out.push({ window: primaryName, status: st(info.status), utilization: (info.utilization as number) ?? null, resetsAt: ms(info.resetsAt) });
  } else if (st(info.status) === 'rejected') {
    const o = out.find((x) => x.window === primaryName)!;
    o.status = 'rejected';
    o.resetsAt = o.resetsAt ?? ms(info.resetsAt);
  }
  return out;
}
