// Configuration: sensible defaults merged with $ORCH_HOME/config.json.
// Operators never define individual agents, workflows or GitHub field IDs here.
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ProviderId, Complexity } from './types.js';

export interface ProviderConfig {
  enabled: boolean;
  command: string;
  maxConcurrent: number;
  timeoutSec: number;
  models: Record<Complexity, string | null>;     // null → provider default model
  effort: Record<Complexity, string | null>;     // claude --effort / codex model_reasoning_effort
  envPassthrough: string[];                       // extra env var names agents may see
  allowApiKeyBilling: boolean;                    // must be explicitly authorized
  maxTurns?: number;
  extraArgs?: string[];
  scenario?: string;                              // simulated provider scenario file
  nativeRetryWaitMs?: number;                     // claude: CLAUDE_CODE_RETRY_WATCHDOG max usage-limit wait
  networkAccess?: boolean;                        // codex: allow network inside workspace-write sandbox
}

export interface Config {
  home: string;
  supervisor: {
    tickMs: number; leaseMs: number; heartbeatMs: number; maxConcurrentAgents: number; maxPerProject: number;
    shutdownGraceMs: number; stallMs: number; minFreeDiskMb: number;
  };
  providers: Record<string, ProviderConfig>;
  routing: { crossProviderReview: boolean; failoverAfterMinutes: number; preferOrder: ProviderId[] };
  recovery: {
    backoffMinutes: number[]; authCheckMinutes: number; capacityProbeMinutes: number; proactiveUtilization: number;
    transientBackoffSec: number[];
  };
  limits: {
    maxPromptChars: number; maxDiffChars: number; maxOutputExcerpt: number; maxDebateRounds: number;
    maxReviewCycles: number; maxMessagesPerTask: number; maxMessageDepth: number; maxRemediationRounds: number;
    maxTaskAttempts: number; maxResultChars: number;
  };
  github: {
    apiUrl: string; graphqlUrl: string; uploadsUrl: string; tokenFile: string | null; allowCreateRepo: boolean;
    allowCreateProject: boolean; allowPublishRelease: boolean; mergeMethod: 'merge' | 'squash' | 'rebase';
    checksTimeoutMin: number; requireChecks: boolean;
  };
  security: {
    allowedRepos: string[]; sandbox: 'auto' | 'bwrap' | 'none'; agentSandbox?: 'auto' | 'bwrap' | 'none'; agentSandboxRelaxFor?: string[]; gateNetwork: boolean;
    /** Where quality-gate and release-verification commands run: bubblewrap here ('local') or throwaway VMs ('devvm'). */
    gateBackend?: 'local' | 'devvm';
    approvalRequiredFor: string[]; protectedPathGlobs: string[];
  };
  vm: {
    command: string | null;          // absolute path to the trusted devvm executable (deploy/devvm/devvm)
    unavailableRetryMin: number;     // while the VM host is asleep/paused/full, gates wait this long between attempts
    gate: { cpus: number; ramMib: number; diskGib: number };
  };
  dashboard: { host: string; port: number; tokenHash: string | null; sessionHours: number; trustProxy?: boolean };
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; maxBytes: number; keep: number };
}

export function defaultHome(): string {
  return resolve(process.env.ORCH_HOME ?? join(homedir(), '.orchestrator'));
}

const baseProvider = (command: string): ProviderConfig => ({
  enabled: true,
  command,
  maxConcurrent: 1,
  timeoutSec: 45 * 60,
  models: { low: null, medium: null, high: null },
  effort: { low: 'low', medium: 'medium', high: 'high' },
  envPassthrough: [],
  allowApiKeyBilling: false,
});

export function defaultConfig(home = defaultHome()): Config {
  return {
    home,
    supervisor: {
      tickMs: 2000, leaseMs: 120_000, heartbeatMs: 20_000, maxConcurrentAgents: 2, maxPerProject: 2,
      shutdownGraceMs: 30_000, stallMs: 20 * 60_000, minFreeDiskMb: 1024,
    },
    providers: {
      claude: { ...baseProvider('claude'), models: { low: 'haiku', medium: 'sonnet', high: 'opus' }, maxTurns: 120, nativeRetryWaitMs: 10 * 60_000 },
      codex: { ...baseProvider('codex') },
      simulated: { ...baseProvider('simulated'), enabled: false },
    },
    routing: { crossProviderReview: true, failoverAfterMinutes: 30, preferOrder: ['codex', 'claude'] },
    recovery: {
      backoffMinutes: [15, 30, 60, 120, 240, 360], authCheckMinutes: 10, capacityProbeMinutes: 15,
      proactiveUtilization: 0.97, transientBackoffSec: [30, 120, 600, 1800],
    },
    limits: {
      maxPromptChars: 60_000, maxDiffChars: 40_000, maxOutputExcerpt: 6_000, maxDebateRounds: 2, maxReviewCycles: 3,
      maxMessagesPerTask: 6, maxMessageDepth: 3, maxRemediationRounds: 4, maxTaskAttempts: 4, maxResultChars: 200_000,
    },
    github: {
      apiUrl: 'https://api.github.com', graphqlUrl: 'https://api.github.com/graphql', uploadsUrl: 'https://uploads.github.com',
      tokenFile: null, allowCreateRepo: false, allowCreateProject: true, allowPublishRelease: false, mergeMethod: 'squash',
      checksTimeoutMin: 60, requireChecks: true,
    },
    security: {
      allowedRepos: [], sandbox: 'auto', agentSandbox: 'auto', gateNetwork: false,
      approvalRequiredFor: ['production_deploy', 'destructive_operation', 'protected_infrastructure', 'unrelated_repository',
        'credential_expansion', 'additional_spending', 'public_publication', 'security_policy_change'],
      protectedPathGlobs: ['.github/workflows/**', '**/.env', '**/*.pem', '**/id_rsa*'],
      gateBackend: 'local',
    },
    vm: { command: null, unavailableRetryMin: 5, gate: { cpus: 2, ramMib: 2048, diskGib: 12 } },
    dashboard: { host: '127.0.0.1', port: 7420, tokenHash: null, sessionHours: 12 },
    logging: { level: 'info', maxBytes: 10 * 1024 * 1024, keep: 5 },
  };
}

function deepMerge<T>(base: T, over: unknown): T {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over as T;
  if (typeof over !== 'object' || Array.isArray(over)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function configPath(home: string): string {
  return join(home, 'config.json');
}

export function loadConfig(home = defaultHome()): Config {
  const base = defaultConfig(home);
  const p = configPath(home);
  if (!existsSync(p)) return base;
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Config>;
  const cfg = deepMerge(base, { ...raw, home });
  for (const [name, pc] of Object.entries(cfg.providers)) {
    if (!(name in base.providers)) cfg.providers[name] = deepMerge(baseProvider(pc.command ?? name), pc);
  }
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: Config): void {
  const errs: string[] = [];
  const pos = (v: number, n: string) => { if (!(Number.isFinite(v) && v > 0)) errs.push(`${n} must be > 0`); };
  pos(cfg.supervisor.tickMs, 'supervisor.tickMs');
  pos(cfg.supervisor.leaseMs, 'supervisor.leaseMs');
  pos(cfg.supervisor.maxConcurrentAgents, 'supervisor.maxConcurrentAgents');
  if (cfg.supervisor.heartbeatMs * 2 > cfg.supervisor.leaseMs) errs.push('supervisor.heartbeatMs must be < leaseMs/2');
  if (cfg.limits.maxDebateRounds > 4) errs.push('limits.maxDebateRounds must be <= 4');
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(cfg.dashboard.host) && !cfg.dashboard.tokenHash)
    errs.push('dashboard bound to non-loopback host requires an access token (run: orchestrator setup)');
  for (const [n, p] of Object.entries(cfg.providers)) {
    if (p.maxConcurrent < 0) errs.push(`providers.${n}.maxConcurrent must be >= 0`);
  }
  if ('devVmGateCommand' in (cfg.security as Record<string, unknown>))
    errs.push('security.devVmGateCommand was replaced: set security.gateBackend to "devvm" and vm.command to the devvm path');
  const gb = cfg.security.gateBackend ?? 'local';
  if (gb !== 'local' && gb !== 'devvm') errs.push('security.gateBackend must be "local" or "devvm"');
  if (gb === 'devvm' && !(typeof cfg.vm.command === 'string' && cfg.vm.command.startsWith('/')))
    errs.push('security.gateBackend "devvm" requires vm.command (absolute path to the devvm executable)');
  pos(cfg.vm.unavailableRetryMin, 'vm.unavailableRetryMin');
  if (errs.length) throw new Error('Invalid configuration:\n - ' + errs.join('\n - '));
}

/** Persist only operator-relevant overrides; never writes secrets. */
export function saveConfig(cfg: Config): void {
  mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
  const { home: _home, ...rest } = cfg;
  const p = configPath(cfg.home);
  writeFileSync(p, JSON.stringify(rest, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
}

export interface Paths {
  home: string; db: string; logs: string; workspaces: string; releases: string; backups: string; secrets: string; transcripts: string; gateLogs: string;
}
export function paths(cfg: Config): Paths {
  const h = cfg.home;
  return {
    home: h,
    db: join(h, 'data', 'orchestrator.db'),
    logs: join(h, 'logs'),
    workspaces: join(h, 'workspaces'),
    releases: join(h, 'releases'),
    backups: join(h, 'backups'),
    secrets: join(h, 'secrets'),
    transcripts: join(h, 'transcripts'),
    gateLogs: join(h, 'gate-logs'),
  };
}
