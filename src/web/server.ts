// Authenticated operator dashboard + JSON API. Runs inside the supervisor process but is
// independent of it: closing the browser never affects execution. Defaults to localhost.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { json } from '../core/db.js';
import { randomToken, sha256 } from '../core/ids.js';
import type { Ctx } from '../engine/ctx.js';
import { Store } from '../engine/store.js';
import { createProject, issueCommand } from '../app.js';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cache-Control': 'no-store',
};

export interface DashboardOptions { host?: string; port?: number; secureCookies?: boolean }

export function hashToken(t: string): string { return sha256(`orchestrator-dashboard:${t}`); }

export class Dashboard {
  private server: Server | null = null;
  private store: Store;
  private attempts = new Map<string, { n: number; reset: number }>();
  constructor(private ctx: Ctx, private o: DashboardOptions = {}) { this.store = new Store(ctx.db, ctx.clock); }

  listen(): Promise<{ host: string; port: number }> {
    const host = this.o.host ?? this.ctx.cfg.dashboard.host;
    const port = this.o.port ?? this.ctx.cfg.dashboard.port;
    this.server = createServer((req, res) => this.handle(req, res).catch((e) => {
      this.ctx.log.error('dashboard error', { error: (e as Error).message });
      if (!res.headersSent) this.send(res, 500, { error: 'internal error' });
    }));
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 30_000;
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => {
        const a = this.server!.address();
        resolve({ host, port: typeof a === 'object' && a ? a.port : port });
      });
    });
  }

  close(): Promise<void> { return new Promise((r) => (this.server ? this.server.close(() => r()) : r())); }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage, max = 256 * 1024): Promise<any> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > max) throw Object.assign(new Error('payload too large'), { status: 413 }); chunks.push(c as Buffer); }
    if (!n) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
  }

  private session(req: IncomingMessage): string | null {
    const m = /(?:^|;\s*)orch_session=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie ?? '');
    if (!m) return null;
    const row = this.ctx.db.get<{ expires_at: number }>('SELECT expires_at FROM dashboard_sessions WHERE token_hash=?', sha256(m[1]!));
    return row && row.expires_at > Date.now() ? m[1]! : null;
  }

  /** CSRF defense: state-changing requests need a custom header (forces CORS preflight) and a same-origin Origin. */
  private csrfOk(req: IncomingMessage): boolean {
    if (req.headers['x-orchestrator-csrf'] !== '1') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/healthz') return this.send(res, 200, { ok: true, db: this.ctx.db.integrityCheck() === 'ok' });
    if (method === 'GET' && !path.startsWith('/api/')) return this.static(res, path);

    if (path === '/api/login' && method === 'POST') {
      const ip = req.socket.remoteAddress ?? '?';
      const a = this.attempts.get(ip) ?? { n: 0, reset: Date.now() + 60_000 };
      if (Date.now() > a.reset) { a.n = 0; a.reset = Date.now() + 60_000; }
      if (++a.n > 10) { this.attempts.set(ip, a); return this.send(res, 429, { error: 'too many attempts' }); }
      this.attempts.set(ip, a);
      if (!this.csrfOk(req)) return this.send(res, 403, { error: 'csrf' });
      const { token } = await this.body(req, 4096);
      const expected = this.ctx.cfg.dashboard.tokenHash;
      if (!expected || typeof token !== 'string') return this.send(res, 401, { error: 'dashboard token not configured (run: orchestrator setup)' });
      const got = Buffer.from(hashToken(token)); const exp = Buffer.from(expected);
      if (got.length !== exp.length || !timingSafeEqual(got, exp)) {
        this.ctx.events.audit(`dashboard:${ip}`, 'dashboard.login_failed');
        return this.send(res, 401, { error: 'invalid token' });
      }
      const sid = randomToken(32);
      const ttl = this.ctx.cfg.dashboard.sessionHours * 3_600_000;
      this.ctx.db.run('INSERT INTO dashboard_sessions(token_hash, created_at, expires_at) VALUES (?,?,?)', sha256(sid), Date.now(), Date.now() + ttl);
      this.ctx.db.run('DELETE FROM dashboard_sessions WHERE expires_at < ?', Date.now());
      this.ctx.events.audit(`dashboard:${ip}`, 'dashboard.login');
      return this.send(res, 200, { ok: true }, { 'Set-Cookie': `orch_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttl / 1000)}${this.o.secureCookies ? '; Secure' : ''}` });
    }
    const sid = this.session(req);
    if (!sid) return this.send(res, 401, { error: 'authentication required' });
    if (method !== 'GET' && !this.csrfOk(req)) return this.send(res, 403, { error: 'csrf' });
    const actor = `dashboard:${sid.slice(0, 6)}`;

    if (path === '/api/logout' && method === 'POST') {
      this.ctx.db.run('DELETE FROM dashboard_sessions WHERE token_hash=?', sha256(sid));
      return this.send(res, 200, { ok: true }, { 'Set-Cookie': 'orch_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (path === '/api/overview' && method === 'GET') return this.send(res, 200, overview(this.ctx, this.store));
    if (path === '/api/providers' && method === 'GET') return this.send(res, 200, providers(this.ctx));
    if (path === '/api/approvals' && method === 'GET') return this.send(res, 200, this.ctx.db.all('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200'));
    if (path === '/api/events' && method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const pid = url.searchParams.get('project');
      const rows = pid
        ? this.ctx.db.all('SELECT * FROM events WHERE id > ? AND project_id = ? ORDER BY id DESC LIMIT 300', after, pid)
        : this.ctx.db.all('SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT 300', after);
      return this.send(res, 200, rows);
    }
    if (path === '/api/projects' && method === 'POST') {
      const b = await this.body(req);
      if (typeof b.goal !== 'string' || typeof b.repo !== 'string') return this.send(res, 400, { error: 'goal and repo are required' });
      try {
        const p = createProject(this.ctx, { goal: b.goal, repo: b.repo, name: typeof b.name === 'string' ? b.name : undefined, mode: b.mode === 'github' ? 'github' : b.mode === 'local' ? 'local' : undefined });
        this.ctx.events.audit(actor, 'project.create', { projectId: p.id });
        return this.send(res, 201, { id: p.id });
      } catch (e) { return this.send(res, 400, { error: (e as Error).message }); }
    }
    let m = /^\/api\/projects\/(prj_[a-z0-9]+)$/.exec(path);
    if (m && method === 'GET') {
      const d = projectDetail(this.ctx, this.store, m[1]!);
      return d ? this.send(res, 200, d) : this.send(res, 404, { error: 'not found' });
    }
    m = /^\/api\/projects\/(prj_[a-z0-9]+)\/(pause|resume|stop)$/.exec(path);
    if (m && method === 'POST') {
      if (!this.store.project(m[1]!)) return this.send(res, 404, { error: 'not found' });
      issueCommand(this.ctx, m[2]!, m[1]!, {}, actor);
      return this.send(res, 202, { queued: m[2] });
    }
    m = /^\/api\/approvals\/(appr_[a-z0-9]+)\/(approve|deny)$/.exec(path);
    if (m && method === 'POST') {
      try { return this.send(res, 200, this.ctx.policy.decide(m[1]!, m[2] === 'approve', actor)); } catch (e) { return this.send(res, 409, { error: (e as Error).message }); }
    }
    if (path === '/api/config/concurrency' && method === 'POST') {
      const b = await this.body(req);
      const n = Number(b.maxConcurrentAgents);
      if (!Number.isInteger(n) || n < 1 || n > 16) return this.send(res, 400, { error: 'maxConcurrentAgents must be 1..16' });
      issueCommand(this.ctx, 'set_concurrency', null, { maxConcurrentAgents: n }, actor);
      return this.send(res, 202, { queued: true });
    }
    m = /^\/api\/providers\/([a-z0-9_-]+)\/reset$/.exec(path);
    if (m && method === 'POST') { issueCommand(this.ctx, 'provider_reset', null, { provider: m[1] }, actor); return this.send(res, 202, { queued: true }); }
    m = /^\/api\/releases\/(rel_[a-z0-9]+)\/download$/.exec(path);
    if (m && method === 'GET') {
      const r = this.ctx.db.get<{ zip_path: string; status: string }>('SELECT zip_path, status FROM releases WHERE id=?', m[1]!);
      if (!r?.zip_path || !existsSync(r.zip_path) || !['verified', 'published'].includes(r.status)) return this.send(res, 404, { error: 'no verified release' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/zip', 'Content-Length': String(statSync(r.zip_path).size), 'Content-Disposition': `attachment; filename="${basename(r.zip_path).replace(/[^\w.-]/g, '_')}"` });
      createReadStream(r.zip_path).pipe(res);
      this.ctx.events.audit(actor, 'release.download', { target: m[1] });
      return;
    }
    return this.send(res, 404, { error: 'not found' });
  }

  private static(res: ServerResponse, path: string): void {
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!/^[a-z0-9._-]+$/i.test(file)) { res.writeHead(404, SECURITY_HEADERS); res.end('not found'); return; }
    const p = join(UI_DIR, file);
    if (!existsSync(p)) { res.writeHead(404, SECURITY_HEADERS); res.end('not found'); return; }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(readFileSync(p));
  }
}

/** Progress = verified requirements / mandatory requirements (never an arbitrary percentage). */
export function coverage(store: Store, projectId: string) {
  const reqs = store.requirements(projectId).filter((r) => r.mandatory);
  const by = (s: string) => reqs.filter((r) => r.status === s).length;
  return { mandatory: reqs.length, verified: by('verified'), implemented: by('implemented'), blocked: by('blocked'), open: by('open'), percentVerified: reqs.length ? Math.round((by('verified') / reqs.length) * 100) : 0 };
}

export function overview(ctx: Ctx, store: Store) {
  return {
    now: ctx.clock.now(),
    supervisor: ctx.db.meta('supervisor_instance') ?? null,
    projects: store.projects().map((p) => ({
      id: p.id, name: p.name, status: p.status, reason: p.status_reason, mode: p.repo_mode, repo: p.repo_source, created_at: p.created_at,
      coverage: coverage(store, p.id),
      workItems: ctx.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM work_items WHERE project_id=? GROUP BY status', p.id),
      runningTasks: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status='running'", p.id)!.n,
    })),
    providers: providers(ctx),
    pendingApprovals: ctx.policy.pending().length,
  };
}

export function providers(ctx: Ctx) {
  return ctx.capacity.all().map((s) => ({
    provider: s.provider, status: s.status, limitKind: s.limit_kind, resetAt: s.reset_at, resetSource: s.reset_source, successes: s.successes, failures: s.failures,
    windows: json(s.windows, {}), modelLimits: json(s.model_limits, {}), details: json(s.details, {}),
    running: ctx.queue.runningCount({ provider: s.provider }), maxConcurrent: ctx.cfg.providers[s.provider]?.maxConcurrent ?? 0,
    usage: ctx.db.get('SELECT COUNT(*) AS sessions, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cached_tokens) AS cached_tokens, SUM(reported_cost_usd) AS reported_cost_usd FROM usage WHERE provider=?', s.provider),
  }));
}

export function projectDetail(ctx: Ctx, store: Store, id: string) {
  const p = store.project(id);
  if (!p) return null;
  return {
    project: { ...p, settings: store.settings(p), plan: json(p.plan, null) },
    coverage: coverage(store, id),
    requirements: store.requirements(id).map((r) => ({ ...r, acceptance: json(r.acceptance, []), evidence: json(r.evidence, []) })),
    workItems: store.workItems(id).map((w) => ({ ...w, acceptance: json(w.acceptance, []), requirement_keys: json(w.requirement_keys, []), depends_on: json(w.depends_on, []) })),
    agents: store.agents(id),
    tasks: ctx.db.all('SELECT id, kind, role, agent_id, status, provider, attempts, error_class, error_message, work_item_id, session_id, created_at, updated_at, not_before FROM tasks WHERE project_id=? ORDER BY updated_at DESC LIMIT 200', id),
    messages: ctx.db.all('SELECT * FROM messages WHERE project_id=? ORDER BY created_at DESC LIMIT 200', id),
    decisions: store.decisions(id).map((d) => ({ ...d, alternatives: json(d.alternatives, []), positions: ctx.db.all('SELECT * FROM decision_positions WHERE decision_id=? ORDER BY created_at', d.id) })),
    findings: store.findings(id),
    gates: ctx.db.all('SELECT id, work_item_id, scope, commit_sha, name, command, required, status, exit_code, duration_ms, started_at FROM gate_runs WHERE project_id=? ORDER BY started_at DESC LIMIT 200', id),
    audits: ctx.db.all('SELECT * FROM audits WHERE project_id=? ORDER BY created_at DESC', id),
    releases: ctx.db.all('SELECT id, version, commit_sha, status, zip_path, sha256, github_release_url, created_at FROM releases WHERE project_id=? ORDER BY created_at DESC', id),
    github: ctx.db.all("SELECT kind, key, number, url FROM github_objects WHERE project_id=? AND kind IN ('requirement','work-item','pr') ORDER BY kind, key", id),
    approvals: ctx.policy.pending(id),
    sessions: ctx.db.all('SELECT id, task_id, provider, provider_session_id, model, mode, status, failure_class, prompt_chars, started_at, ended_at FROM sessions WHERE project_id=? ORDER BY started_at DESC LIMIT 100', id),
    usage: ctx.db.all('SELECT provider, model, COUNT(*) AS runs, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cached_tokens) AS cached_tokens, SUM(reported_cost_usd) AS reported_cost_usd FROM usage WHERE project_id=? GROUP BY provider, model', id),
    contextEfficiency: ctx.db.all("SELECT t.kind, s.mode, COUNT(*) AS runs, CAST(AVG(s.prompt_chars) AS INTEGER) AS avg_prompt_chars, MAX(s.prompt_chars) AS max_prompt_chars FROM sessions s JOIN tasks t ON t.id = s.task_id WHERE s.project_id=? GROUP BY t.kind, s.mode", id),
  };
}
