// Process isolation for untrusted commands (quality gates, release verification) and
// environment scrubbing for agents. Git worktrees are NOT security boundaries; this layer,
// the provider CLIs' own sandboxes and the systemd unit hardening provide isolation.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
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
export function findBwrap(): string | null {
  if (bwrapCache !== undefined) return bwrapCache;
  try {
    const p = execFileSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).trim();
    // Verify user namespaces actually work here.
    execFileSync(p, ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-all', 'true'], { stdio: 'ignore', timeout: 5000 });
    bwrapCache = p;
  } catch {
    bwrapCache = null;
  }
  return bwrapCache;
}

export interface SandboxSpec {
  cwd: string;
  writable: string[];          // only these paths are writable
  hide: string[];              // paths replaced by empty tmpfs (credentials, orchestrator home)
  network: boolean;
}

export function sandboxMode(cfg: Config): 'bwrap' | 'none' {
  if (cfg.security.sandbox === 'none') return 'none';
  const b = findBwrap();
  if (cfg.security.sandbox === 'bwrap' && !b) throw new Error('security.sandbox=bwrap but bubblewrap is unavailable (install the "bubblewrap" package)');
  return b ? 'bwrap' : 'none';
}

export function wrapCommand(cfg: Config, spec: SandboxSpec, command: string): { cmd: string; args: string[]; mode: 'bwrap' | 'none' } {
  const mode = sandboxMode(cfg);
  if (mode === 'none') return { cmd: 'sh', args: ['-c', command], mode };
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--die-with-parent', '--new-session', '--unshare-all'];
  if (spec.network) args.push('--share-net');
  for (const h of [homedir(), ...spec.hide]) if (existsSync(h)) args.push('--tmpfs', h);
  for (const w of spec.writable) args.push('--bind', w, w);
  args.push('--chdir', spec.cwd, 'sh', '-c', command);
  return { cmd: findBwrap()!, args, mode };
}

export async function runSandboxed(cfg: Config, spec: SandboxSpec, command: string, env: Record<string, string>, timeoutMs: number): Promise<RunResult & { sandbox: string }> {
  const w = wrapCommand(cfg, spec, command);
  const r = await runProcess(w.cmd, w.args, { cwd: spec.cwd, env, timeoutMs, maxCaptureBytes: 2 * 1024 * 1024 });
  return { ...r, sandbox: w.mode };
}
