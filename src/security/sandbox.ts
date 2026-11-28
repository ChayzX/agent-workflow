// Process isolation for untrusted commands (quality gates, release verification) and
// environment scrubbing for agents. Git worktrees are NOT security boundaries; this layer,
// the provider CLIs' own sandboxes and the systemd unit hardening provide isolation.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from '../core/config.js';
import { runProcess, type RunResult } from '../providers/process.js';

const BASE_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'];
const NETWORK_ALLOW = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO'];
const PROVIDER_ALLOW: Record<string, string[]> = {
  claude: ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  codex: ['CODEX_HOME'],
};
// Never forwarded to agents, regardless of configuration.
const DENY = /^(GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|ORCH_.*TOKEN.*|AWS_.*|AZURE_.*|GOOGLE_APPLICATION_CREDENTIALS|OCI_.*|KUBECONFIG|SSH_AUTH_SOCK|NPM_TOKEN|.*_SECRET.*|.*PASSWORD.*)$/;
const BILLING_KEYS = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY)$/;

/** Allowlisted environment for agent processes: no GitHub/cloud credentials, no API keys unless authorized. */
export function agentEnv(cfg: Config, provider: string, extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const pc = cfg.providers[provider];
  const billingKeys = pc?.allowApiKeyBilling ? (provider === 'claude' ? ['ANTHROPIC_API_KEY'] : provider === 'codex' ? ['OPENAI_API_KEY', 'CODEX_API_KEY'] : []) : [];
  const allow = new Set([...BASE_ALLOW, ...NETWORK_ALLOW, ...(PROVIDER_ALLOW[provider] ?? []), ...(pc?.envPassthrough ?? []), ...billingKeys]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || !allow.has(k)) continue;
    if (DENY.test(k)) continue;
    if (BILLING_KEYS.test(k) && !pc?.allowApiKeyBilling) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

/** Minimal environment for gate commands: no credentials at all. */
export function gateEnv(cfg: Config, home: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { HOME: home, CI: 'true', LANG: source.LANG ?? 'C.UTF-8', PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
  if (cfg.security.gateNetwork) for (const k of NETWORK_ALLOW) if (source[k]) env[k] = source[k]!;
  return env;
}

let bwrapCache: string | null | undefined;
/** Tests only: simulate a host where bubblewrap is missing (null) or restore detection (undefined). */
export function overrideBwrapForTests(v: string | null | undefined): void { bwrapCache = v; }
export function findBwrap(): string | null {
  if (bwrapCache !== undefined) return bwrapCache;
  try {
    const p = execFileSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).trim();
    // Verify it works here with the same mounts and namespaces the real sandboxes use: a fresh /proc fails under
    // systemd's ProtectKernelTunables/ProtectKernelLogs, and namespaces fail under a user unit's PrivateTmp.
    execFileSync(p, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-all', '--die-with-parent', '--new-session', 'true'], { stdio: 'ignore', timeout: 5000 });
    bwrapCache = p;
  } catch {
    bwrapCache = null;
  }
  return bwrapCache;
}

/** TLS trust files referenced by the network environment (e.g. a corporate proxy CA) must stay readable. */
function trustPaths(): string[] {
  return ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE']
    .map((k) => process.env[k]).filter((p): p is string => !!p && p.startsWith('/') && existsSync(p));
}

export interface SandboxSpec {
  cwd: string;
  writable: string[];          // only these paths are writable
  readOnlyLast?: string[];     // re-bound read-only on top of writable paths (e.g. a worktree's `.git` pointer)
  readOnly?: string[];         // re-exposed read-only inside hidden paths (e.g. the shared repo.git a worktree points at)
  hide: string[];              // paths replaced by empty tmpfs (credentials, orchestrator home)
  network: boolean;
}

/** Raised when confinement is required (any mode but an explicit 'none') and bubblewrap cannot provide it. */
export class SandboxUnavailableError extends Error {
  constructor(what: 'agents' | 'gates', key: string) {
    super(`${what === 'agents' ? 'agent' : 'quality-gate'} sandbox unavailable: bubblewrap is missing or cannot create namespaces here `
      + `(Ubuntu 24.04: AppArmor restricts unprivileged user namespaces; systemd: PrivateTmp in user units or ProtectKernelTunables/ProtectKernelLogs break it). `
      + `Fix bubblewrap (see docs/troubleshooting.md), or set security.${key}="none" to run ${what} unconfined (not recommended).`);
    this.name = 'SandboxUnavailableError';
  }
}

// Fail closed: 'auto' and 'bwrap' both require a working sandbox. Running unconfined needs an explicit 'none'.
export function sandboxMode(cfg: Config): 'bwrap' | 'none' {
  if (cfg.security.sandbox === 'none') return 'none';
  if (!findBwrap()) throw new SandboxUnavailableError('gates', 'sandbox');
  return 'bwrap';
}

/** Read-only binds for toolchains living under hidden homes, including the real targets of CLI symlinks. */
function toolBinds(hidden: string[], cmds: string[]): string[] {
  const under = (p: string) => hidden.some((h) => p === h || p.startsWith(h + '/'));
  const secret = (p: string) => /\.(codex|claude|ssh|gnupg|aws|kube|config\/gh)\b/.test(p);
  // Never re-expose a hidden root, or any directory that contains one (e.g. $HOME, /home, or a dir holding ORCH_HOME):
  // a recursive --ro-bind of it would undo the tmpfs hides and reveal ~/.ssh, tokens and the orchestrator's secrets.
  const exposesHidden = (p: string) => hidden.some((h) => h === p || h.startsWith(p.endsWith('/') ? p : p + '/'));
  const safeDir = (p: string) => existsSync(p) && under(p) && !secret(p) && !exposesHidden(p);
  const pathDirs = (process.env.PATH ?? '').split(':').filter((p) => p.startsWith('/'));
  const out = new Set([dirname(dirname(process.execPath)), ...pathDirs].filter(safeDir));
  for (const c of cmds) {
    const found = c.startsWith('/') ? c : pathDirs.map((d) => join(d, c)).find((f) => existsSync(f));
    if (!found) continue;
    let real: string;
    try { real = realpathSync(found); } catch { continue; }
    if (!under(real) || secret(real)) continue;
    // Bind the package that owns the binary (e.g. ~/.local/lib/node_modules/@anthropic-ai/claude-code) when there is one
    // strictly inside a hidden root; otherwise bind only the binary file itself (standalone release binaries).
    let root: string | null = null;
    for (let d = dirname(real), i = 0; i < 5 && safeDir(d); d = dirname(d), i++) if (existsSync(join(d, 'package.json'))) { root = d; break; }
    out.add(root ?? real);
  }
  return [...out];
}

export function wrapCommand(cfg: Config, spec: SandboxSpec, command: string): { cmd: string; args: string[]; mode: 'bwrap' | 'none' } {
  const mode = sandboxMode(cfg);
  if (mode === 'none') return { cmd: 'sh', args: ['-c', command], mode };
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--die-with-parent', '--new-session', '--unshare-all'];
  if (spec.network) args.push('--share-net');
  // Hide every user home (not just ours: credentials of other accounts may be readable) and the orchestrator home.
  const hidden = [...new Set(['/root', '/home', homedir(), ...spec.hide])].filter((h) => existsSync(h));
  for (const h of hidden) args.push('--tmpfs', h);
  // Re-expose, read-only, only the toolchain directories gates need (e.g. Node installed under a home via nvm).
  const under = (p: string) => hidden.some((h) => p === h || p.startsWith(h + '/'));
  for (const t of toolBinds(hidden, ['node', 'npm', 'npx', 'git'])) args.push('--ro-bind', t, t);
  if (spec.network) for (const t of trustPaths()) if (under(t)) args.push('--ro-bind', t, t);
  for (const r of spec.readOnly ?? []) if (existsSync(r)) args.push('--ro-bind', r, r);
  for (const w of spec.writable) args.push('--bind', w, w);
  for (const r of spec.readOnlyLast ?? []) if (existsSync(r)) args.push('--ro-bind', r, r);
  args.push('--chdir', spec.cwd, 'sh', '-c', command);
  return { cmd: findBwrap()!, args, mode };
}

export async function runSandboxed(cfg: Config, spec: SandboxSpec, command: string, env: Record<string, string>, timeoutMs: number): Promise<RunResult & { sandbox: string }> {
  let w: ReturnType<typeof wrapCommand>;
  try { w = wrapCommand(cfg, spec, command); } catch (e) {
    // Fail closed: the untrusted command never runs unconfined; the gate is recorded as an error with the reason.
    if (e instanceof SandboxUnavailableError) return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: e.message, durationMs: 0, sandbox: 'unavailable' };
    throw e;
  }
  const r = await runProcess(w.cmd, w.args, { cwd: spec.cwd, env, timeoutMs, maxCaptureBytes: 2 * 1024 * 1024 });
  return { ...r, sandbox: w.mode };
}

export interface AgentSandboxSpec {
  orchHome: string;
  provider: string;        // only this provider's own session/config directories are exposed
  writable: string[];      // worktree and adapter scratch dirs
  readOnly: string[];      // e.g. the shared bare repository (objects/refs/worktree admin dirs)
  readOnlyLast?: string[]; // re-bound read-only on top of writable dirs (e.g. the worktree's `.git` pointer)
}

/**
 * Providers whose authentication depends on files outside the service user's home (some managed hosts keep
 * credentials under another account in /home). For these, other users' homes are left visible; the service
 * user's home and ORCH_HOME stay hidden. Decided by a startup self-check, never by configuration from agents.
 */
const relaxedProviders = new Set<string>();
// Note: relaxation widens what agents can read (other accounts' homes). It is applied only when the operator
// authorized it (security.agentSandboxRelaxFor or an approved `credential_expansion` approval).
export function relaxAgentSandbox(provider: string, on = true): void { if (on) relaxedProviders.add(provider); else relaxedProviders.delete(provider); }
export function agentSandboxRelaxed(provider: string): boolean { return relaxedProviders.has(provider); }

export function agentSandboxMode(cfg: Config): 'bwrap' | 'none' {
  if ((cfg.security.agentSandbox ?? 'auto') === 'none') return 'none';
  if (!findBwrap()) throw new SandboxUnavailableError('agents', 'agentSandbox');
  return 'bwrap';
}

/**
 * Confine a provider CLI (and every tool it runs) so agents cannot read orchestrator secrets, other
 * projects' worktrees, the shared repository config/hooks, other users' homes or the supervisor's
 * process memory (/proc), while keeping network and the provider's own session directories.
 */
export function wrapAgentCommand(cfg: Config, spec: AgentSandboxSpec, cmd: string, args: string[]): { cmd: string; args: string[] } {
  if (agentSandboxMode(cfg) === 'none') return { cmd, args };
  const home = homedir();
  const a = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--share-net'];
  const hidden = [...new Set([...(relaxedProviders.has(spec.provider) ? [] : ['/root', '/home']), home, spec.orchHome])].filter((h) => existsSync(h));
  for (const h of hidden) a.push('--tmpfs', h);
  const under = (p: string) => hidden.some((h) => p === h || p.startsWith(h + '/'));
  // Toolchains (e.g. nvm-installed node, or provider CLIs whose PATH symlinks point into a hidden ~/.local/lib) read-only.
  for (const t of toolBinds(hidden, [cmd, 'node', 'git'])) a.push('--ro-bind', t, t);
  for (const t of trustPaths()) if (under(t)) a.push('--ro-bind', t, t);
  // Only the running provider's own session/config directories are writable (they hold its login); its
  // settings/config/hook files are re-bound read-only so an agent cannot plant commands the supervisor's own
  // CLI calls would later read. The other provider's directories stay hidden with the rest of the home.
  const own: Record<string, string[]> = {
    claude: ['.claude', '.claude.json', '.config/claude', '.local/share/claude', '.local/state/claude'],
    codex: ['.codex'],
  };
  const providerPaths = (own[spec.provider] ?? []).map((p) => join(home, p))
    .concat(spec.provider === 'claude' && process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : [])
    .concat(spec.provider === 'codex' && process.env.CODEX_HOME ? [process.env.CODEX_HOME] : [])
    .concat(['.npm', '.cache'].map((p) => join(home, p)));
  for (const p of [...new Set(providerPaths)]) if (existsSync(p)) a.push('--bind', p, p);
  const claudeDirs = [join(home, '.claude'), ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : [])];
  const codexDir = process.env.CODEX_HOME ?? join(home, '.codex');
  const protectedFiles: Array<[string, 'file' | 'dir', string]> = spec.provider === 'claude'
    ? claudeDirs.flatMap((d) => [[join(d, 'settings.json'), 'file', '{}\n'], [join(d, 'settings.local.json'), 'file', '{}\n'], [join(d, 'CLAUDE.md'), 'file', ''],
        [join(d, 'hooks'), 'dir', ''], [join(d, 'plugins'), 'dir', ''], [join(d, 'agents'), 'dir', ''], [join(d, 'commands'), 'dir', ''], [join(d, 'skills'), 'dir', '']] as Array<[string, 'file' | 'dir', string]>)
    : [[join(codexDir, 'config.toml'), 'file', ''], [join(codexDir, 'hooks.json'), 'file', '{}\n'], [join(codexDir, 'AGENTS.md'), 'file', ''],
        [join(codexDir, 'rules'), 'dir', ''], [join(codexDir, 'plugins'), 'dir', ''], [join(codexDir, 'skills'), 'dir', '']];
  for (const [f, kind, empty] of protectedFiles) {
    if (!existsSync(dirname(f))) continue; // provider dir not present: nothing to protect or plant into
    // Absent config is created with a neutral default and bound read-only, so agents cannot plant it.
    try { if (!existsSync(f)) { if (kind === 'dir') mkdirSync(f, { recursive: true, mode: 0o700 }); else writeFileSync(f, empty, { mode: 0o600 }); } } catch { continue; }
    a.push('--ro-bind', f, f);
  }
  for (const r of spec.readOnly) if (existsSync(r)) a.push('--ro-bind', r, r);
  for (const w of spec.writable) if (existsSync(w)) a.push('--bind', w, w);
  for (const r of spec.readOnlyLast ?? []) if (existsSync(r)) a.push('--ro-bind', r, r);
  a.push('--', cmd, ...args);
  return { cmd: findBwrap()!, args: a };
}

/**
 * `~/.claude.json` must stay writable for Claude's own state, but its `mcpServers` entries (top-level and
 * per-project) can start commands. Snapshot them and revert any change made during an agent run.
 */
export class ClaudeStateGuard {
  private baselines = new Map<string, string>();
  private files: string[];
  constructor(files?: string | string[]) {
    this.files = files === undefined ? [join(homedir(), '.claude.json'), ...(process.env.CLAUDE_CONFIG_DIR ? [join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')] : [])] : Array.isArray(files) ? files : [files];
  }
  private static nonEmpty(v: unknown): boolean { return !!v && typeof v === 'object' && Object.keys(v as object).length > 0; }
  /** Only non-empty mcpServers matter; a missing project entry equals an empty one. */
  private pick(o: Record<string, any>): string {
    const projects = Object.fromEntries(Object.entries(o.projects ?? {}).filter(([, v]: [string, any]) => ClaudeStateGuard.nonEmpty(v?.mcpServers)).map(([k, v]: [string, any]) => [k, v.mcpServers]));
    return JSON.stringify({ mcpServers: ClaudeStateGuard.nonEmpty(o.mcpServers) ? o.mcpServers : null, projects });
  }
  private read(f: string): Record<string, any> | null {
    try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; } catch { return null; }
  }
  snapshot(): void {
    for (const f of this.files) { const o = this.read(f); if (o) this.baselines.set(f, this.pick(o)); }
  }
  /** Returns true when an agent-introduced change was found and reverted. */
  verifyAndRestore(): boolean {
    let changed = false;
    for (const f of this.files) {
      const baseline = this.baselines.get(f);
      if (baseline === undefined || !existsSync(f)) continue;
      const cur = this.read(f);
      if (!cur || this.pick(cur) === baseline) continue;
      const base = JSON.parse(baseline) as { mcpServers: unknown; projects: Record<string, unknown> };
      if (base.mcpServers === null) delete cur.mcpServers; else cur.mcpServers = base.mcpServers;
      for (const [k, v] of Object.entries(cur.projects ?? {}) as Array<[string, any]>) {
        if (!v || typeof v !== 'object') continue;
        if (base.projects[k]) v.mcpServers = base.projects[k];
        else if (ClaudeStateGuard.nonEmpty(v.mcpServers)) v.mcpServers = {};
      }
      writeFileSync(f, JSON.stringify(cur, null, 2), { mode: 0o600 });
      this.baselines.set(f, this.pick(cur));
      changed = true;
    }
    return changed;
  }
}
