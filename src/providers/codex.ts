// Codex adapter: executes with the official `codex exec --json` (JSONL events, thread ids,
// `exec resume`, --output-schema, built-in sandbox) and probes subscription capacity through
// the official `codex app-server` JSON-RPC (`account/read`, `account/rateLimits/read`) which
// costs no model usage. Authentication is the operator's own `codex login` (ChatGPT plan).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Clock } from '../core/clock.js';
import type { ProviderConfig } from '../core/config.js';
import { classifyCodexErrorInfo, classifyText } from './classify.js';
import { runProcess, runQuick, killTree } from './process.js';
import type {
  AuthResult, CapacityProbe, DetectResult, ExecRequest, ExecResult, ProviderAdapter, ProviderCapabilities, RateLimitObservation,
} from './types.js';

export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex';
  constructor(private cfg: ProviderConfig, private clock: Clock, private baseEnv: Record<string, string>, private quickWrap: (cmd: string, args: string[]) => { cmd: string; args: string[] } = (cmd, args) => ({ cmd, args })) {}

  private quick(args: string[]) { const w = this.quickWrap(this.cfg.command, args); return runQuick(w.cmd, w.args, this.baseEnv); }

  capabilities(): ProviderCapabilities {
    return {
      nonInteractive: true, structuredOutput: 'json-schema', streamingEvents: true, sessionIds: true, resume: true,
      modelSelection: true, reasoningSelection: true, workdirIsolation: true, sandboxModes: ['read-only', 'workspace-write'],
      cancellation: true, authValidation: true, usageLimitDetection: 'provider-reset-time', capacityProbe: 'non-model',
      usageReporting: 'tokens',
    };
  }

  async detect(): Promise<DetectResult> {
    const r = await this.quick(['--version']);
    if (r.spawnError || r.exitCode !== 0) return { installed: false, error: r.spawnError ?? r.stderr.slice(0, 300) };
    return { installed: true, version: r.stdout.trim() };
  }

  async checkAuth(): Promise<AuthResult> {
    const r = await this.quick(['login', 'status']);
    if (r.spawnError) return { ok: false, detail: r.spawnError };
    const out = (r.stdout + r.stderr).trim();
    const ok = r.exitCode === 0 && /logged in/i.test(out) && !/not logged in/i.test(out);
    const apiKey = /api key/i.test(out);
    return { ok, method: apiKey ? 'api_key' : ok ? 'chatgpt' : undefined, apiKeyBilling: apiKey, detail: ok ? out.split('\n').pop() : 'not logged in: run `codex login` (or `codex login --device-auth` on a headless server)' };
  }

  /** Non-model capacity probe via the app-server JSON-RPC protocol. */
  async probeCapacity(): Promise<CapacityProbe | null> {
    const w = this.quickWrap(this.cfg.command, ['app-server']);
    const rpc = new AppServerClient(w.cmd, this.baseEnv, 15_000, w.args);
    try {
      await rpc.start();
      await rpc.request('initialize', { clientInfo: { name: 'agent-workflow-orchestrator', title: null, version: '0.1.0' }, capabilities: null });
      rpc.notify('initialized');
      const acct = (await rpc.request('account/read', { refreshToken: false })) as { account: { type: string } | null; requiresOpenaiAuth: boolean };
      if (!acct.account) return { available: false, windows: [], detail: 'auth_required' };
      if (acct.account.type === 'apiKey' && !this.cfg.allowApiKeyBilling) return { available: false, windows: [], detail: 'billing_policy: API key auth not authorized' };
      const rl = (await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true })) as CodexRateLimitsResponse;
      return interpretCodexRateLimits(rl);
    } catch (e) {
      return { available: null, windows: [], detail: `probe failed: ${(e as Error).message}` };
    } finally {
      rpc.close();
    }
  }

  buildArgs(req: ExecRequest, schemaPath: string | null, lastMsgPath: string): string[] {
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', req.cwd, '-s', req.mode, '-o', lastMsgPath];
    if (schemaPath) args.push('--output-schema', schemaPath);
    if (req.model) args.push('-m', req.model);
    if (req.effort) args.push('-c', `model_reasoning_effort="${req.effort}"`);
    if (req.mode === 'workspace-write') args.push('-c', `sandbox_workspace_write.network_access=${this.cfg.networkAccess ? 'true' : 'false'}`);
    if (this.cfg.extraArgs?.length) args.push(...this.cfg.extraArgs);
    if (req.resumeSessionId) args.push('resume', req.resumeSessionId);
    args.push('-');
    return args;
  }

  async execute(req: ExecRequest): Promise<ExecResult> {
    const tmp = mkdtempSync(join(tmpdir(), 'orch-codex-'));
    const schemaPath = req.outputSchema ? join(tmp, 'schema.json') : null;
    if (schemaPath) writeFileSync(schemaPath, JSON.stringify(strictSchema(req.outputSchema!)));
    const lastMsgPath = join(tmp, 'last.txt');
    const env = { ...req.env };
    if (!this.cfg.allowApiKeyBilling) { delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; }

    let threadId: string | null = req.resumeSessionId ?? null;
    let failedMsg: string | null = null;
    let errorInfo: unknown = null;
    let usage: ExecResult['usage'];
    const messages: string[] = [];
    try {
      const built = this.buildArgs(req, schemaPath, lastMsgPath);
      const w = req.wrap ? req.wrap(this.cfg.command, built, [tmp]) : { cmd: this.cfg.command, args: built };
      const run = await runProcess(w.cmd, w.args, {
        cwd: req.cwd, env, stdin: req.prompt, timeoutMs: req.timeoutMs, signal: req.signal, onSpawn: req.onSpawn,
        transcriptPath: req.transcriptPath,
        onLine: (line) => {
          let ev: Record<string, any>;
          try { ev = JSON.parse(line); } catch { return; }
          switch (ev.type) {
            case 'thread.started':
              threadId = ev.thread_id ?? threadId;
              req.onEvent?.({ kind: 'session', data: { sessionId: threadId } });
              break;
            case 'item.completed': {
              const it = ev.item ?? {};
              if (it.type === 'agent_message' && typeof it.text === 'string') { messages.push(it.text); req.onEvent?.({ kind: 'message', text: it.text.slice(0, 2000) }); }
              else if (it.type === 'command_execution' || it.type === 'file_change' || it.type === 'mcp_tool_call') req.onEvent?.({ kind: 'tool', text: it.type });
              break;
            }
            case 'turn.completed': {
              const u = ev.usage ?? {};
              usage = { inputTokens: u.input_tokens, cachedTokens: u.cached_input_tokens, outputTokens: u.output_tokens, model: req.model ?? null };
              req.onEvent?.({ kind: 'usage', data: u });
              break;
            }
            case 'turn.failed':
              failedMsg = ev.error?.message ?? 'turn failed';
              errorInfo = ev.error?.codex_error_info ?? ev.error?.codexErrorInfo ?? null;
              break;
            case 'error':
              // "Reconnecting... n/5" are internal retries; keep the last one as context.
              if (!/^Reconnecting\.\.\./.test(ev.message ?? '')) failedMsg = ev.message ?? failedMsg;
              req.onEvent?.({ kind: 'error', text: String(ev.message ?? '').slice(0, 500) });
              break;
          }
        },
      });
      const now = this.clock.now();
      const base: Omit<ExecResult, 'ok'> = { sessionId: threadId, structured: null, text: '', rateLimits: [], exitCode: run.exitCode, durationMs: run.durationMs, usage };
      if (run.spawnError) return { ...base, ok: false, failure: { cls: 'tool_missing', message: run.spawnError } };
      if (run.timedOut) return { ...base, ok: false, failure: { cls: 'timeout', message: `timed out after ${req.timeoutMs}ms` } };
      if (run.aborted) return { ...base, ok: false, failure: { cls: 'interrupted', message: 'cancelled' } };
      if (failedMsg || run.exitCode !== 0) {
        const msg = failedMsg ?? (run.stderr.slice(-2000) || `exit ${run.exitCode}`);
        const failure = classifyText(msg, now);
        const mapped = classifyCodexErrorInfo(errorInfo);
        if (mapped) failure.cls = mapped;
        if (failure.cls === 'unknown' && run.signal) failure.cls = 'killed';
        if (failure.cls === 'usage_limit') base.rateLimits.push({ window: failure.limitKind ?? 'unknown', status: 'rejected', resetsAt: failure.resetAt ?? null });
        return { ...base, ok: false, failure };
      }
      let last = '';
      try { last = readFileSync(lastMsgPath, 'utf8'); } catch { last = messages.at(-1) ?? ''; }
      base.text = last;
      if (req.outputSchema) {
        try { base.structured = JSON.parse(extractJson(last)); } catch {
          return { ...base, ok: false, failure: { cls: 'invalid_output', message: 'final message was not valid JSON for the output schema' } };
        }
      }
      return { ...base, ok: true };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

interface CodexWindow { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
interface CodexSnapshot { primary: CodexWindow | null; secondary: CodexWindow | null; rateLimitReachedType: string | null; limitName?: string | null }
export interface CodexRateLimitsResponse { ordinaryUsageAllowed: boolean | null; rateLimits: CodexSnapshot; rateLimitsByLimitId?: Record<string, CodexSnapshot> | null }

export function interpretCodexRateLimits(rl: CodexRateLimitsResponse): CapacityProbe {
  const windows: RateLimitObservation[] = [];
  const add = (name: string, w: CodexWindow | null, reached: boolean) => {
    if (!w) return;
    const resetsAt = w.resetsAt ? (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) : null;
    windows.push({ window: name, utilization: w.usedPercent / 100, resetsAt, status: w.usedPercent >= 100 || reached ? 'rejected' : w.usedPercent >= 90 ? 'warning' : 'allowed' });
  };
  const snap = rl.rateLimits;
  const reached = !!snap?.rateLimitReachedType;
  add(`primary${snap?.primary?.windowDurationMins ? `_${snap.primary.windowDurationMins}m` : ''}`, snap?.primary ?? null, false);
  add(`secondary${snap?.secondary?.windowDurationMins ? `_${snap.secondary.windowDurationMins}m` : ''}`, snap?.secondary ?? null, false);
  const rejected = windows.filter((w) => w.status === 'rejected');
  // Per protocol docs: ordinaryUsageAllowed is authoritative; null = unknown, do not infer from percentages.
  const available = rl.ordinaryUsageAllowed === null ? (reached || rejected.length ? false : null) : rl.ordinaryUsageAllowed;
  const resetAt = available === false
    ? Math.max(...(rejected.length ? rejected : windows).map((w) => w.resetsAt ?? 0)) || null
    : null;
  return { available, windows, resetAt, detail: reached ? `limit reached: ${snap.rateLimitReachedType}` : undefined };
}

/** Codex --output-schema requires strict schemas: additionalProperties false and all properties required. */
export function strictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (s: any): any => {
    if (!s || typeof s !== 'object') return s;
    if (Array.isArray(s)) return s.map(walk);
    const o: any = { ...s };
    if (o.type === 'object' && o.properties) {
      o.additionalProperties = false;
      o.required = Object.keys(o.properties);
      o.properties = Object.fromEntries(Object.entries(o.properties).map(([k, v]) => [k, walk(v)]));
    }
    if (o.items) o.items = walk(o.items);
    for (const k of ['anyOf', 'oneOf', 'allOf']) if (o[k]) o[k] = walk(o[k]);
    return o;
  };
  return walk(schema);
}

export function extractJson(text: string): string {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return t;
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) return fence[1]!.trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  return i >= 0 && j > i ? t.slice(i, j + 1) : t;
}

/** Minimal newline-delimited JSON-RPC client for `codex app-server` over stdio. */
export class AppServerClient {
  private child: ReturnType<typeof spawn> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = '';
  constructor(private command: string, private env: Record<string, string>, private timeoutMs = 15_000, private argv: string[] = ['app-server']) {}

  start(): Promise<void> {
    return new Promise((res, rej) => {
      this.child = spawn(this.command, this.argv, { env: this.env, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
      this.child.on('error', (e) => rej(e));
      this.child.on('spawn', () => res());
      this.child.stdout!.setEncoding('utf8');
      this.child.stdout!.on('data', (d: string) => {
        this.buf += d;
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          try {
            const m = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
            if (typeof m.id === 'number' && this.pending.has(m.id)) {
              const p = this.pending.get(m.id)!;
              this.pending.delete(m.id);
              m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
            }
          } catch { /* ignore non-JSON */ }
        }
      });
      this.child.on('close', () => { for (const p of this.pending.values()) p.reject(new Error('app-server exited')); this.pending.clear(); });
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${method} timed out`)); }, this.timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
      this.child!.stdin!.write(JSON.stringify(params === undefined ? { method, id } : { method, id, params }) + '\n');
    });
  }

  notify(method: string): void {
    this.child?.stdin?.write(JSON.stringify({ method }) + '\n');
  }

  close(): void {
    if (this.child?.pid) killTree(this.child.pid, 'SIGTERM');
  }
}
