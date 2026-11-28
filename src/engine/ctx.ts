// Dependency bag shared by engine modules.
import type { Db } from '../core/db.js';
import type { Clock } from '../core/clock.js';
import type { Config, Paths } from '../core/config.js';
import type { EventLog } from '../core/events.js';
import type { Logger } from '../core/log.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { Policy } from '../security/policy.js';
import type { CapacityManager } from './capacity.js';
import type { TaskQueue } from './queue.js';
import type { Router } from './router.js';
import type { GitHubSync } from '../github/sync.js';

export interface Ctx {
  db: Db;
  clock: Clock;
  cfg: Config;
  paths: Paths;
  events: EventLog;
  log: Logger;
  queue: TaskQueue;
  capacity: CapacityManager;
  router: Router;
  policy: Policy;
  adapters: Map<string, ProviderAdapter>;
  github: (projectId: string) => GitHubSync | null;
  /** The supervisor's GitHub token (memoized; never written to disk or git config). Null when unavailable. */
  githubToken?: () => string | null;
}
