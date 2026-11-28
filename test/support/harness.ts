import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createProject } from '../../src/app.js';
import { ManualClock } from '../../src/core/clock.js';
import { defaultConfig, type Config } from '../../src/core/config.js';
import type { Ctx } from '../../src/engine/ctx.js';
import { Supervisor } from '../../src/engine/supervisor.js';
import type { ProjectRow } from '../../src/core/types.js';
import { SimulatedAdapter, type SimBehaviour } from '../../src/providers/simulated.js';

export interface Harness { ctx: Ctx; sup: Supervisor; clock: ManualClock; claude: SimulatedAdapter; codex: SimulatedAdapter; home: string; cleanup: () => void }

export function makeHarness(behaviour: SimBehaviour, tweak: (c: Config) => void = () => {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'orch-test-'));
  const cfg = defaultConfig(home);
  cfg.supervisor.tickMs = 10;
  cfg.supervisor.maxConcurrentAgents = 2;
  cfg.supervisor.maxPerProject = 2;
  cfg.security.sandbox = 'none';
  cfg.security.agentSandbox = 'none'; // simulated adapters spawn nothing; confinement is tested explicitly elsewhere
  cfg.recovery.transientBackoffSec = [1, 1, 1];
  cfg.logging.level = 'error';
  // Simulated adapters registered under the real provider ids to exercise routing logic.
  cfg.providers.claude!.models = { low: 'sim-low', medium: 'sim-medium', high: 'sim-high' };
  cfg.providers.codex!.models = { low: 'sim-low', medium: 'sim-medium', high: 'sim-high' };
  tweak(cfg);
  const clock = new ManualClock(Date.UTC(2026, 10, 27, 0, 0, 0));
  const claude = new SimulatedAdapter('claude', clock, behaviour);
  const codex = new SimulatedAdapter('codex', clock, behaviour);
  const adapters = new Map<string, SimulatedAdapter>([['codex', codex], ['claude', claude]]);
  for (const id of [...adapters.keys()]) if (!cfg.providers[id]?.enabled) adapters.delete(id);
  const ctx = createApp({ cfg, clock, adapters });
  const sup = new Supervisor(ctx, { lock: false });
  return { ctx, sup, clock, claude, codex, home, cleanup: () => { ctx.db.close(); rmSync(home, { recursive: true, force: true }); } };
}

/** Drive the supervisor deterministically: tick, wait for work, advance the clock. */
export async function drive(h: Harness, until: (p: ProjectRow) => boolean, projectId: string, opts: { maxTicks?: number; stepMs?: number; onTick?: (i: number) => Promise<void> | void } = {}): Promise<ProjectRow> {
  const max = opts.maxTicks ?? 400;
  for (let i = 0; i < max; i++) {
    await h.sup.tick();
    await h.sup.settle();
    const p = h.ctx.db.get<ProjectRow>('SELECT * FROM projects WHERE id=?', projectId)!;
    if (until(p)) return p;
    await opts.onTick?.(i);
    h.clock.advance(opts.stepMs ?? 5_000);
  }
  const p = h.ctx.db.get<ProjectRow>('SELECT * FROM projects WHERE id=?', projectId)!;
  const items = h.ctx.db.all<{ key: string; status: string; status_reason: string | null }>('SELECT key, status, status_reason FROM work_items WHERE project_id=?', projectId);
  const tasks = h.ctx.db.all<{ kind: string; status: string; error_class: string | null; error_message: string | null; provider: string | null }>('SELECT kind, status, error_class, error_message, provider FROM tasks WHERE project_id=? ORDER BY created_at', projectId);
  const events = h.ctx.db.all<{ type: string; message: string }>('SELECT type, message FROM events ORDER BY id DESC LIMIT 15');
  throw new Error(`condition not reached after ${max} ticks; project=${p.status} (${p.status_reason})\nitems=${JSON.stringify(items)}\ntasks=${JSON.stringify(tasks.slice(-12))}\nevents=${JSON.stringify(events)}`);
}

export function newDemoProject(h: Harness, goal: string): ProjectRow {
  return createProject(h.ctx, { goal, repo: 'new', mode: 'local' });
}
