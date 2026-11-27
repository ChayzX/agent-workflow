import type { Clock } from '../core/clock.js';
import type { Config } from '../core/config.js';
import { agentEnv } from '../security/sandbox.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import type { ProviderAdapter } from './types.js';

/** Build adapters for enabled real providers. Future providers register here. */
export function buildAdapters(cfg: Config, clock: Clock): Map<string, ProviderAdapter> {
  const m = new Map<string, ProviderAdapter>();
  for (const [id, pc] of Object.entries(cfg.providers)) {
    if (!pc.enabled) continue;
    if (id === 'claude') m.set(id, new ClaudeAdapter(pc, clock, agentEnv(cfg, 'claude')));
    else if (id === 'codex') m.set(id, new CodexAdapter(pc, clock, agentEnv(cfg, 'codex')));
  }
  return m;
}
