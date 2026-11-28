import type { Clock } from '../core/clock.js';
import type { Config } from '../core/config.js';
import { agentEnv, SandboxUnavailableError, wrapAgentCommand } from '../security/sandbox.js';
import { paths } from '../core/config.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import type { ProviderAdapter } from './types.js';

/** Build adapters for enabled real providers. Future providers register here. */
export function buildAdapters(cfg: Config, clock: Clock): Map<string, ProviderAdapter> {
  const m = new Map<string, ProviderAdapter>();
  for (const [id, pc] of Object.entries(cfg.providers)) {
    if (!pc.enabled) continue;
    // Supervisor-side CLI calls (version, auth status, capacity probe) run in the same confinement as agents.
    // Usage-free CLI checks (login status, app-server rate limits) run confined when possible; when the sandbox is
    // unavailable they still run (no model use, no repository access) so `doctor`/`status` can report the real problem.
    const quickWrap = (cmd: string, args: string[]) => {
      try { return wrapAgentCommand(cfg, { orchHome: paths(cfg).home, provider: id, writable: [], readOnly: [] }, cmd, args); }
      catch (e) { if (e instanceof SandboxUnavailableError) return { cmd, args }; throw e; }
    };
    if (id === 'claude') m.set(id, new ClaudeAdapter(pc, clock, agentEnv(cfg, 'claude'), quickWrap));
    else if (id === 'codex') m.set(id, new CodexAdapter(pc, clock, agentEnv(cfg, 'codex'), quickWrap));
  }
  return m;
}
