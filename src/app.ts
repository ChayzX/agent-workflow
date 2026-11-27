// Composition root shared by the daemon, CLI, dashboard and tests.
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Db, json } from './core/db.js';
import { systemClock, type Clock } from './core/clock.js';
import { loadConfig, paths as mkPaths, type Config } from './core/config.js';
import { EventLog } from './core/events.js';
import { Logger } from './core/log.js';
import { newId, sha256 } from './core/ids.js';
import { registerSecret } from './core/redact.js';
import type { ProjectRow, ProjectSettings } from './core/types.js';
import { CapacityManager } from './engine/capacity.js';
import type { Ctx } from './engine/ctx.js';
import { TaskQueue } from './engine/queue.js';
import { Router } from './engine/router.js';
import { GitHubClient } from './github/client.js';
import { GitHubSync } from './github/sync.js';
import { buildAdapters } from './providers/registry.js';
import type { ProviderAdapter } from './providers/types.js';
import { Policy } from './security/policy.js';

export interface AppOptions { cfg?: Config; clock?: Clock; adapters?: Map<string, ProviderAdapter>; echoLogs?: boolean; githubFetch?: typeof fetch }

/** Resolve the GitHub token without ever writing it anywhere: env, 0600 file, or `gh auth token`. */
export function resolveGitHubToken(cfg: Config): string | null {
  if (process.env.ORCH_GITHUB_TOKEN) return process.env.ORCH_GITHUB_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const file = cfg.github.tokenFile ?? join(mkPaths(cfg).secrets, 'github-token');
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o077;
    if (mode) throw new Error(`refusing to read ${file}: permissions too open (chmod 600)`);
    return readFileSync(file, 'utf8').trim() || null;
  }
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

export function createApp(o: AppOptions = {}): Ctx {
  const cfg = o.cfg ?? loadConfig();
  const clock = o.clock ?? systemClock;
  const p = mkPaths(cfg);
  for (const d of [p.home, p.logs, p.workspaces, p.releases, p.backups, p.secrets, p.transcripts, p.gateLogs]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const db = new Db(p.db);
  const log = new Logger(p.logs, cfg.logging.level, cfg.logging.maxBytes, cfg.logging.keep, o.echoLogs);
  const events = new EventLog(db, clock);
  const queue = new TaskQueue(db, clock);
  const capacity = new CapacityManager(db, clock, cfg, events);
  const adapters = o.adapters ?? buildAdapters(cfg, clock);
  const router = new Router(cfg, adapters, capacity, queue);
  const policy = new Policy(db, clock, cfg, events);
  const ghCache = new Map<string, GitHubSync | null>();
  let token: string | null | undefined;
  const ctx: Ctx = {
    db, clock, cfg, paths: p, events, log, queue, capacity, router, policy, adapters,
    github: (projectId: string) => {
      if (ghCache.has(projectId)) return ghCache.get(projectId)!;
      const proj = db.get<ProjectRow>('SELECT * FROM projects WHERE id=?', projectId);
      if (!proj || proj.repo_mode !== 'github') { ghCache.set(projectId, null); return null; }
      if (token === undefined) { try { token = resolveGitHubToken(cfg); } catch (e) { log.error('github token', { error: (e as Error).message }); token = null; } }
      if (!token) { ghCache.set(projectId, null); return null; }
      registerSecret(token);
      const [owner, repo] = proj.repo_source.split('/');
      const client = new GitHubClient({ token, apiUrl: cfg.github.apiUrl, graphqlUrl: cfg.github.graphqlUrl, uploadsUrl: cfg.github.uploadsUrl, fetchImpl: o.githubFetch });
      const settings = json<ProjectSettings>(proj.settings, {} as ProjectSettings);
      const sync = new GitHubSync(client, db, clock, events, proj.id, owner!, repo!, {
        allowCreateProject: cfg.github.allowCreateProject, projectTitle: settings.github?.project_id ?? `${proj.name} (orchestrator)`, mergeMethod: cfg.github.mergeMethod,
      });
      ghCache.set(projectId, sync);
      return sync;
    },
  };
  for (const id of adapters.keys()) capacity.get(id);
  return ctx;
}

export interface NewProject { goal: string; name?: string; repo: string; mode?: 'local' | 'github'; defaultBranch?: string; settings?: Partial<ProjectSettings> }

/** Register a project from a goal. The goal text becomes an immutable baseline. */
export function createProject(ctx: Ctx, n: NewProject): ProjectRow {
  const goal = n.goal.trim();
  if (goal.length < 20) throw new Error('goal is too short to plan from (need at least a sentence or two)');
  const mode = n.mode ?? (/^[\w.-]+\/[\w.-]+$/.test(n.repo) && !existsSync(n.repo) ? 'github' : 'local');
  const source = mode === 'local' ? (n.repo === 'new' ? '' : resolve(n.repo)) : n.repo;
  if (mode === 'local' && source && !existsSync(join(source, '.git')) && !existsSync(join(source, 'HEAD'))) throw new Error(`${source} is not a git repository (use --repo new to start an empty one)`);
  if (mode === 'github') {
    const registered = ctx.db.all<{ repo_source: string }>("SELECT repo_source FROM projects WHERE repo_mode='github'").map((r) => r.repo_source);
    if (ctx.cfg.security.allowedRepos.length && !ctx.policy.repoAllowed(source, registered)) throw new Error(`repository ${source} is not in security.allowedRepos`);
  }
  const id = newId('prj');
  const now = ctx.clock.now();
  const name = n.name ?? (goal.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 80) || 'project');
  const settings: ProjectSettings = { gates: [], verify_commands: [], auto_merge: true, integration_audit_every: 5, ...n.settings };
  ctx.db.run(
    `INSERT INTO projects(id, name, goal_text, goal_sha256, status, repo_mode, repo_source, workspace_dir, default_branch, settings, created_at, updated_at)
     VALUES (?,?,?,?, 'planning', ?,?,?,?,?,?,?)`,
    id, name, goal, sha256(goal), mode, source, join(ctx.paths.workspaces, id), n.defaultBranch ?? 'main', JSON.stringify(settings), now, now,
  );
  ctx.events.emit('project.created', `project "${name}" created (${mode}: ${source || 'new repository'})`, { projectId: id });
  ctx.events.audit('operator', 'project.created', { projectId: id, detail: { mode, repo: source, goalSha256: sha256(goal) } });
  return ctx.db.get<ProjectRow>('SELECT * FROM projects WHERE id=?', id)!;
}

export function issueCommand(ctx: Ctx, command: string, projectId: string | null, args: Record<string, unknown> = {}, by = 'operator'): number {
  return ctx.db.run('INSERT INTO commands(project_id, command, args, issued_by, created_at) VALUES (?,?,?,?,?)', projectId, command, JSON.stringify(args), by, ctx.clock.now()).lastInsertRowid;
}
