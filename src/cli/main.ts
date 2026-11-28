#!/usr/bin/env node
// orchestrator CLI. Commands talk to the same SQLite store as the daemon; state-changing
// commands are queued in the `commands` table and applied by the supervisor deterministically.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, platform, release as osRelease, freemem, totalmem } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statfsSync } from 'node:fs';
import { createApp, createProject, issueCommand, resolveGitHubToken } from '../app.js';
import { configPath, defaultConfig, defaultHome, loadConfig, saveConfig, paths, type Config } from '../core/config.js';
import { Db, json } from '../core/db.js';
import { randomToken } from '../core/ids.js';
import { Supervisor } from '../engine/supervisor.js';
import { Store } from '../engine/store.js';
import { Dashboard, hashToken, coverage, providers as providerRows } from '../web/server.js';
import { findBwrap } from '../security/sandbox.js';
import { checkDevVmExecutable, devvm, devvmSupportsStatusFile } from '../vm/devvm.js';
import { EgressProxy } from '../vm/egress-proxy.js';
import { exportRelease } from '../engine/release.js';
import { collectDir, writeZip, extractZip } from '../util/zip.js';
import { sha256 } from '../core/ids.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VERSION = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string; } catch { return '0.0.0'; } })();

type Flags = Record<string, string | boolean>;
function parse(argv: string[]): { cmd: string[]; flags: Flags } {
  const cmd: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k!] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) flags[k!] = argv[++i]!;
      else flags[k!] = true;
    } else cmd.push(a);
  }
  return { cmd, flags };
}

const out = (s = '') => process.stdout.write(s + '\n');
const ok = (s: string) => out(`  ✔ ${s}`);
const warn = (s: string) => out(`  ⚠ ${s}`);
const bad = (s: string) => out(`  ✖ ${s}`);
const ago = (t: number | null) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '—');

function cfgFor(flags: Flags): Config {
  const home = flags.home ? resolve(String(flags.home)) : defaultHome();
  return existsSync(configPath(home)) ? loadConfig(home) : defaultConfig(home);
}

function daemonPid(cfg: Config): number | null {
  const lock = join(cfg.home, 'supervisor.lock');
  if (!existsSync(lock)) return null;
  const pid = Number(readFileSync(lock, 'utf8').split(' ')[0]);
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

function resolveProject(store: Store, ref: string | undefined): string {
  const ps = store.projects();
  if (!ref) {
    if (ps.length === 1) return ps[0]!.id;
    throw new Error(ps.length ? `specify a project: ${ps.map((p) => `${p.id} (${p.name})`).join(', ')}` : 'no projects yet: run `orchestrator start --goal GOAL.md --repo ...`');
  }
  const p = ps.find((x) => x.id === ref || x.name === ref || x.id.endsWith(ref));
  if (!p) throw new Error(`project not found: ${ref}`);
  return p.id;
}

const HELP = `orchestrator ${VERSION} — autonomous engineering orchestrator

Usage: orchestrator <command> [options]   (global: --home DIR, default $ORCH_HOME or ~/.orchestrator)

Setup & health
  setup [--non-interactive] [--force] [--service]   Create config, dashboard token, database; optional systemd user service
  doctor                                           Diagnose OS, tools, providers, auth, GitHub, storage, permissions
  providers status [--probe]                       Provider availability, reset times, usage (probe = auth + non-model capacity check)
  providers reset <provider>                       Mark a provider available again (e.g. after re-authenticating)

Projects
  start --goal GOAL.md --repo <owner/name|path|new> [--name N] [--mode github|local]
  status [project]                                 Verified requirement coverage, work, agents, blockers
  pause|resume|stop [project]
  unblock ITEM [project] --note TEXT               Return a blocked work item to ready, with guidance (audited)
  cancel ITEM [project] --note TEXT                Descope a work item (operator decision, audited)
  tasks [project]   messages [project]   decisions [project]
  logs [--project P] [--follow] [--limit N]
  release [project] [--out DIR]                    Show / export the verified release ZIP
  approvals [list|approve ID|deny ID]

Service
  run | daemon [--no-dashboard]                    Run the supervisor (+ dashboard) in the foreground
  dashboard-token                                  Rotate the dashboard access token
  backup [--out FILE]   restore FILE   upgrade   uninstall [--purge --yes]
  self-package [--out DIR]                         Build this orchestrator's own verified release ZIP
  egress-proxy                                     Run the agent-VM allowlist egress proxy (systemd: orchestrator-egress)
  version
`;

async function main(): Promise<number> {
  const { cmd, flags } = parse(process.argv.slice(2));
  const [c0, c1, c2] = cmd;
  switch (c0) {
    case undefined: case 'help': case '--help': out(HELP); return 0;
    case 'version': out(VERSION); return 0;
    case 'setup': return setup(flags);
    case 'doctor': return doctor(flags);
    case 'run': case 'daemon': return runDaemon(flags);
    case 'self-package': return selfPackage(flags);
    case 'egress-proxy': return egressProxy(flags);
  }
  const cfg = cfgFor(flags);
  const ctx = createApp({ cfg });
  const store = new Store(ctx.db, ctx.clock);
  try {
    switch (c0) {
      case 'providers': {
        if (c1 === 'reset') { issueCommand(ctx, 'provider_reset', null, { provider: c2 }, 'cli'); if (!daemonPid(cfg)) ctx.capacity.reset(c2!, 'cli reset'); out(`reset queued for ${c2}`); return 0; }
        out('Provider  Status          Reset                    Windows');
        for (const p of providerRows(ctx)) {
          const w = Object.values(p.windows as Record<string, { window: string; utilization?: number; resetsAt?: number }>).map((x) => `${x.window}=${x.utilization == null ? '?' : Math.round(x.utilization * 100) + '%'}`).join(' ');
          out(`${p.provider.padEnd(9)} ${p.status.padEnd(15)} ${(p.resetAt ? `${ago(p.resetAt)} (${p.resetSource})` : '—').padEnd(24)} ${w || 'not exposed yet'}`);
        }
        if (flags.probe) {
          out('\nLive checks (no model usage):');
          for (const [id, a] of ctx.adapters) {
            const d = await a.detect();
            const au = d.installed ? await a.checkAuth() : { ok: false, detail: d.error };
            let hint = '';
            if (d.installed && !au.ok) {
              // Distinguish "not logged in" from "logged in, but the login is outside the agent sandbox's view".
              const { ClaudeAdapter } = await import('../providers/claude.js');
              const { CodexAdapter } = await import('../providers/codex.js');
              const { agentEnv } = await import('../security/sandbox.js');
              const raw = id === 'claude' ? new ClaudeAdapter(cfg.providers[id]!, ctx.clock, agentEnv(cfg, id)) : id === 'codex' ? new CodexAdapter(cfg.providers[id]!, ctx.clock, agentEnv(cfg, id)) : null;
              if (raw && (await raw.checkAuth()).ok) hint = ' — logged in, but not visible inside the agent sandbox: re-login as the service user, or approve the `credential_expansion` request (or set security.agentSandboxRelaxFor)';
            }
            out(`  ${id}: ${d.installed ? d.version : 'not installed'}; auth: ${au.ok ? 'ok' : 'NOT OK'} (${au.detail ?? ''})${hint}${au.apiKeyBilling ? ' — API-key billing (refused unless authorized)' : ''}`);
            const cap = d.installed && au.ok ? await a.probeCapacity() : null;
            if (cap) out(`    capacity: ${cap.available === null ? 'unknown' : cap.available ? 'available' : 'LIMITED'}${cap.resetAt ? `, resets ${ago(cap.resetAt)}` : ''}; ${cap.windows.map((w) => `${w.window} ${Math.round((w.utilization ?? 0) * 100)}% (resets ${ago(w.resetsAt ?? null)})`).join('; ')}`);
            else if (d.installed && au.ok) out('    capacity: not exposed without a model call (learned from rate-limit events during runs)');
          }
        }
        return 0;
      }
      case 'start': {
        if (!flags.goal || !flags.repo) throw new Error('usage: orchestrator start --goal GOAL.md --repo <owner/name|path|new>');
        const goal = readFileSync(resolve(String(flags.goal)), 'utf8');
        const p = createProject(ctx, { goal, repo: String(flags.repo), name: flags.name ? String(flags.name) : undefined, mode: flags.mode === 'github' || flags.mode === 'local' ? flags.mode : undefined });
        out(`Project ${p.id} "${p.name}" created (${p.repo_mode}). Goal baseline sha256 ${p.goal_sha256.slice(0, 16)}…`);
        out(daemonPid(cfg) ? 'The running supervisor will begin planning now.' : 'Supervisor is not running. Start it with `systemctl --user start orchestrator` or `orchestrator run`.');
        return 0;
      }
      case 'status': {
        const ids = c1 ? [resolveProject(store, c1)] : store.projects().map((p) => p.id);
        const pid = daemonPid(cfg);
        out(`Supervisor: ${pid ? `running (pid ${pid})` : 'NOT running'}   Home: ${cfg.home}`);
        for (const id of ids) {
          const p = store.project(id)!;
          const cv = coverage(store, id);
          out(`\n${p.name} [${p.id}]  ${p.status.toUpperCase()}${p.status_reason ? ` — ${p.status_reason}` : ''}`);
          out(`  Requirements verified: ${cv.verified}/${cv.mandatory} mandatory (${cv.percentVerified}%), implemented ${cv.implemented}, open ${cv.open}, blocked ${cv.blocked}`);
          const wi = ctx.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM work_items WHERE project_id=? GROUP BY status', id);
          out(`  Work items: ${wi.map((x) => `${x.status}=${x.n}`).join(' ') || 'none yet'}`);
          for (const t of ctx.db.all<{ kind: string; provider: string; status: string; role: string; error_message: string | null; not_before: number }>("SELECT * FROM tasks WHERE project_id=? AND status IN ('running','waiting_capacity','waiting_message') ORDER BY updated_at DESC LIMIT 10", id)) {
            out(`  · ${t.status.padEnd(16)} ${t.kind.padEnd(16)} ${t.role.padEnd(22)} ${t.provider ?? ''}${t.status === 'waiting_capacity' ? ` until ${ago(t.not_before)}` : ''}`);
          }
          const appr = ctx.policy.pending(id);
          if (appr.length) out(`  Approvals waiting: ${appr.map((a) => `${a.id} ${a.action}`).join(', ')}`);
          const rel = ctx.db.get<{ version: string; status: string; zip_path: string }>('SELECT * FROM releases WHERE project_id=? ORDER BY created_at DESC LIMIT 1', id);
          if (rel) out(`  Release ${rel.version}: ${rel.status} ${rel.zip_path ?? ''}`);
        }
        out('\nProviders: ' + ctx.capacity.all().map((s) => `${s.provider}=${s.status}${s.reset_at ? `(reset ${ago(s.reset_at)})` : ''}`).join('  '));
        if ((cfg.security.agentBackend ?? 'local') === 'devvm') {
          const leases = ctx.db.all<{ id: string; purpose: string; work_item_id: string | null; expires_at: number | null }>("SELECT id, purpose, work_item_id, expires_at FROM vm_leases WHERE status='ready' ORDER BY created_at");
          const ev = ctx.db.get<{ type: string; message: string; ts: number }>("SELECT type, message, ts FROM events WHERE type IN ('vm.unavailable','vm.available') ORDER BY id DESC LIMIT 1");
          out(`Agent backend: devvm — ${leases.length} VM(s): ${leases.map((l) => `${l.id.slice(0, 8)}(${l.purpose}${l.expires_at ? `, until ${ago(l.expires_at)}` : ''})`).join(' ') || 'none'}${ev?.type === 'vm.unavailable' ? ` — WAITING since ${ago(ev.ts)}: ${ev.message}` : ''}`);
        }
        if ((cfg.security.gateBackend ?? 'local') === 'devvm') {
          const ev = ctx.db.get<{ type: string; message: string; ts: number }>("SELECT type, message, ts FROM events WHERE type IN ('gates.backend_unavailable','gates.backend_available','security.vm_backend_unavailable','security.vm_backend_ok') ORDER BY id DESC LIMIT 1");
          const waiting = ev && (ev.type === 'gates.backend_unavailable' || ev.type === 'security.vm_backend_unavailable');
          out(`Gate backend: devvm (${cfg.vm.command})${waiting ? ` — WAITING since ${ago(ev!.ts)}: ${ev!.message}` : ''}`);
        }
        return 0;
      }
      case 'pause': case 'resume': case 'stop': {
        const id = resolveProject(store, c1);
        issueCommand(ctx, c0, id, {}, 'cli');
        out(`${c0} queued for ${id}${daemonPid(cfg) ? '' : ' (applies when the supervisor starts)'}`);
        return 0;
      }
      case 'cancel': {
        if (!c1 || !flags.note) throw new Error('usage: orchestrator cancel ITEM [project] --note "why this work is descoped"');
        const id = resolveProject(store, c2);
        issueCommand(ctx, 'cancel_item', id, { key: c1, note: String(flags.note) }, 'cli');
        out(`cancel of ${c1} queued for ${id}${daemonPid(cfg) ? '' : ' (applies when the supervisor starts)'}`);
        return 0;
      }
      case 'unblock': {
        if (!c1 || !flags.note) throw new Error('usage: orchestrator unblock ITEM [project] --note "why it is not an external blocker / guidance"');
        const id = resolveProject(store, c2);
        issueCommand(ctx, 'unblock_item', id, { key: c1, note: String(flags.note) }, 'cli');
        out(`unblock of ${c1} queued for ${id}${daemonPid(cfg) ? '' : ' (applies when the supervisor starts)'}`);
        return 0;
      }
      case 'tasks': {
        const id = resolveProject(store, c1);
        for (const t of ctx.db.all<{ id: string; kind: string; status: string; provider: string | null; attempts: number; error_class: string | null; role: string }>('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 60', id)) {
          out(`${t.id}  ${t.kind.padEnd(16)} ${t.status.padEnd(16)} ${(t.provider ?? '-').padEnd(8)} attempts=${t.attempts} ${t.error_class ?? ''}`);
        }
        return 0;
      }
      case 'messages': {
        const id = resolveProject(store, c1);
        for (const m of ctx.db.all<{ created_at: number; type: string; sender_agent_id: string; recipient_role: string | null; recipient_agent_id: string | null; state: string; body: string }>('SELECT * FROM messages WHERE project_id=? ORDER BY created_at DESC LIMIT 40', id)) {
          out(`${ago(m.created_at)} ${m.type.padEnd(10)} ${m.sender_agent_id} → ${m.recipient_agent_id ?? m.recipient_role} [${m.state}] ${m.body.slice(0, 160).replace(/\n/g, ' ')}`);
        }
        return 0;
      }
      case 'decisions': {
        const id = resolveProject(store, c1);
        for (const d of store.decisions(id)) out(`${d.key} [${d.status}] ${d.title}${d.outcome ? ` → ${d.outcome}` : ''}`);
        return 0;
      }
      case 'logs': {
        const pid = flags.project ? resolveProject(store, String(flags.project)) : null;
        let last = 0;
        const limit = Number(flags.limit ?? 50);
        const print = () => {
          const rows = (pid ? ctx.db.all<{ id: number; ts: number; level: string; type: string; message: string }>('SELECT * FROM events WHERE project_id=? AND id>? ORDER BY id DESC LIMIT ?', pid, last, limit)
            : ctx.db.all<{ id: number; ts: number; level: string; type: string; message: string }>('SELECT * FROM events WHERE id>? ORDER BY id DESC LIMIT ?', last, limit)).reverse();
          for (const e of rows) { out(`${ago(e.ts)} ${e.level.padEnd(5)} ${e.type.padEnd(22)} ${e.message}`); last = Math.max(last, e.id); }
        };
        print();
        if (!flags.follow) return 0;
        await new Promise<void>(() => { setInterval(print, 2000); });
        return 0;
      }
      case 'release': {
        const id = resolveProject(store, c1);
        const r = ctx.db.get<{ version: string; status: string; zip_path: string; sha256: string; github_release_url: string | null; verification_log: string | null }>('SELECT * FROM releases WHERE project_id=? ORDER BY created_at DESC LIMIT 1', id);
        if (!r) { out('No release yet. A release is generated automatically after the independent completion audit passes.'); return 1; }
        out(`Release ${r.version}: ${r.status}\n  ZIP: ${r.zip_path}\n  SHA-256: ${r.sha256}${r.github_release_url ? `\n  GitHub: ${r.github_release_url}` : ''}`);
        if (flags.out && ['verified', 'published'].includes(r.status)) out(`  Exported to ${exportRelease(r.zip_path, resolve(String(flags.out)))}`);
        if (flags.log) out(r.verification_log ?? '');
        return 0;
      }
      case 'approvals': {
        if (c1 === 'approve' || c1 === 'deny') { const a = ctx.policy.decide(c2!, c1 === 'approve', 'cli'); out(`${a.id} ${a.status}`); return 0; }
        const rows = ctx.policy.pending();
        if (!rows.length) out('No pending approvals.');
        for (const a of rows) out(`${a.id}  ${a.action}\n    ${a.reason}`);
        return 0;
      }
      case 'dashboard-token': {
        const token = randomToken(24);
        const raw = existsSync(configPath(cfg.home)) ? JSON.parse(readFileSync(configPath(cfg.home), 'utf8')) : {};
        raw.dashboard = { ...(raw.dashboard ?? {}), tokenHash: hashToken(token) };
        writeFileSync(configPath(cfg.home), JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
        ctx.db.run('DELETE FROM dashboard_sessions');
        out(`New dashboard token (restart the service to apply):\n  ${revealToken(cfg, token)}`);
        return 0;
      }
      case 'backup': {
        const outFile = resolve(String(flags.out ?? join(paths(cfg).backups, `orchestrator-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)));
        ctx.db.backupTo(outFile);
        chmodSync(outFile, 0o600);
        out(`Backup written: ${outFile} (${statSync(outFile).size} bytes). Workspaces are git repositories and are re-cloned if missing; releases are in ${paths(cfg).releases}.`);
        return 0;
      }
      case 'restore': {
        if (daemonPid(cfg)) throw new Error('stop the supervisor before restoring');
        if (!c1 || !existsSync(c1)) throw new Error('usage: orchestrator restore FILE');
        const test = new Db(resolve(c1));
        const integrity = test.integrityCheck();
        test.close();
        if (integrity !== 'ok') throw new Error(`backup failed integrity check: ${integrity}`);
        ctx.db.close();
        const dbPath = paths(cfg).db;
        if (existsSync(dbPath)) copyFileSync(dbPath, `${dbPath}.pre-restore-${Date.now()}`);
        for (const ext of ['-wal', '-shm']) rmSync(dbPath + ext, { force: true });
        copyFileSync(resolve(c1), dbPath);
        chmodSync(dbPath, 0o600);
        out(`Restored ${c1} → ${dbPath} (previous database kept as .pre-restore-*)`);
        return 0;
      }
      case 'upgrade': {
        const outFile = join(paths(cfg).backups, `pre-upgrade-${Date.now()}.db`);
        ctx.db.backupTo(outFile);
        out(`Pre-upgrade backup: ${outFile}\nSchema version: ${ctx.db.schemaVersion()} (migrations apply automatically and are forward-only).\nTo upgrade: stop the service, extract the new release over the install directory (or run deploy/install.sh from it), then start the service. Active project state is preserved in ${cfg.home}.`);
        return 0;
      }
      case 'uninstall': {
        const unit = join(homedir(), '.config', 'systemd', 'user', 'orchestrator.service');
        try { execFileSync('systemctl', ['--user', 'disable', '--now', 'orchestrator'], { stdio: 'ignore' }); } catch { /* not installed */ }
        if (existsSync(unit)) { rmSync(unit); ok(`removed ${unit}`); }
        const link = join(homedir(), '.local', 'bin', 'orchestrator');
        if (existsSync(link)) { rmSync(link); ok(`removed ${link}`); }
        if (flags.purge) {
          if (!flags.yes) throw new Error(`--purge deletes ${cfg.home} (database, workspaces, releases). Re-run with --purge --yes to confirm.`);
          ctx.db.close();
          rmSync(cfg.home, { recursive: true, force: true });
          ok(`deleted ${cfg.home}`);
        } else out(`Data kept in ${cfg.home} (use --purge --yes to delete).`);
        return 0;
      }
      default:
        out(HELP);
        return 2;
    }
  } finally {
    try { ctx.db.close(); } catch { /* closed */ }
  }
}

function sandboxAdvice(cfg: Config): string {
  const gatesOff = cfg.security.sandbox === 'none'; const agentsOff = cfg.security.agentSandbox === 'none';
  const effect = gatesOff && agentsOff ? 'sandboxing is disabled by configuration, so agents and gates run unconfined'
    : gatesOff ? 'agents will NOT run (fail closed); gates run unconfined by configuration'
    : agentsOff ? 'quality gates will NOT run (fail closed); agents run unconfined by configuration'
    : 'agents and quality gates will NOT run (fail closed)';
  return `bubblewrap cannot create a sandbox here: ${effect}. Install "bubblewrap"; on Ubuntu 24.04 also allow its user namespaces (docs/troubleshooting.md). `
    + 'Under systemd, do not set PrivateTmp in user units or ProtectKernelTunables/ProtectKernelLogs.';
}

/**
 * Show a new dashboard token only on an interactive terminal. When output is piped or logged (installers, `tee`,
 * CI), the token goes to a 0600 file instead, so it never lands in logs.
 */
function revealToken(cfg: Config, token: string): string {
  if (process.stdout.isTTY) return `${token}   (shown once)`;
  const f = join(paths(cfg).secrets, 'dashboard-token');
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, token + '\n', { mode: 0o600 });
  return `written to ${f} (0600; output is not a terminal, so it is not printed). Read it, then delete the file.`;
}

async function setup(flags: Flags): Promise<number> {
  const home = flags.home ? resolve(String(flags.home)) : defaultHome();
  out(`Orchestrator setup — home: ${home}`);
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  if (major < 22 || (major === 22 && minor < 13)) { bad(`Node ${process.versions.node} is too old; need >= 22.13`); return 1; }
  ok(`Node ${process.versions.node}`);
  let cfg: Config;
  let token: string | null = null;
  if (existsSync(configPath(home)) && !flags.force) {
    cfg = loadConfig(home);
    ok(`existing configuration kept (${configPath(home)}); use --force to regenerate`);
  } else {
    cfg = defaultConfig(home);
    token = randomToken(24);
    cfg.dashboard.tokenHash = hashToken(token);
    saveConfig(cfg);
    ok(`configuration written to ${configPath(home)} (0600)`);
  }
  const ctx = createApp({ cfg });
  ok(`database initialized at ${paths(cfg).db} (schema v${ctx.db.schemaVersion()})`);
  for (const [id, a] of ctx.adapters) {
    const d = await a.detect();
    if (!d.installed) { warn(`${id}: CLI not found. Install: ${id === 'claude' ? 'npm install -g @anthropic-ai/claude-code' : 'npm install -g @openai/codex'}`); continue; }
    const au = await a.checkAuth();
    if (au.ok && !au.apiKeyBilling) ok(`${id} ${d.version}: authenticated (${au.method})`);
    else if (au.apiKeyBilling) warn(`${id}: authenticated with an API key — API billing is refused unless providers.${id}.allowApiKeyBilling=true`);
    else warn(`${id}: not authenticated. Run on this server: ${id === 'claude' ? '`claude login` (subscription) or `claude setup-token`' : '`codex login --device-auth` (ChatGPT plan)'}`);
  }
  const tok = (() => { try { return resolveGitHubToken(cfg); } catch (e) { return `ERR ${(e as Error).message}`; } })();
  if (tok && !tok.startsWith('ERR')) ok('GitHub token found (env, secrets/github-token, or gh CLI)');
  else warn(`GitHub token not found${tok ? ` (${tok})` : ''}. For GitHub mode create a token (classic PAT with "repo", "project" and "workflow" scopes, or fine-grained with Issues/PRs/Contents RW for org repos) and save it:\n      install -m 600 /dev/null ${join(paths(cfg).secrets, 'github-token')} && $EDITOR ${join(paths(cfg).secrets, 'github-token')}`);
  if (!findBwrap()) warn(sandboxAdvice(cfg)); else ok('bubblewrap sandbox works (with /proc, /tmp and all namespaces, as agents and gates use it)');
  if (token) out(`\nDashboard token (store it in your password manager):\n  ${revealToken(cfg, token)}\nDashboard: http://${cfg.dashboard.host}:${cfg.dashboard.port}/`);
  if (flags.service) installUserService(cfg);
  else out('\nRun `orchestrator setup --service` to install a systemd user service, or `orchestrator run` to run in the foreground.');
  ctx.db.close();
  return 0;
}

function installUserService(cfg: Config): void {
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  const bin = join(ROOT, 'bin', 'orchestrator');
  const tpl = readFileSync(join(ROOT, 'deploy', 'systemd', 'orchestrator-user.service'), 'utf8');
  const unit = tpl.replace(/@BIN@/g, bin).replace(/@HOME@/g, cfg.home).replace(/@NODE_DIR@/g, dirname(process.execPath));
  writeFileSync(join(unitDir, 'orchestrator.service'), unit);
  const egress = readFileSync(join(ROOT, 'deploy', 'systemd', 'orchestrator-egress.service'), 'utf8').replace(/@BIN@/g, bin).replace(/@HOME@/g, cfg.home).replace(/@NODE_DIR@/g, dirname(process.execPath));
  writeFileSync(join(unitDir, 'orchestrator-egress.service'), egress);
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    if ((cfg.security.agentBackend ?? 'local') === 'devvm') {
      execFileSync('systemctl', ['--user', 'enable', '--now', 'orchestrator-egress'], { stdio: 'ignore' });
      ok('egress proxy service installed and started (orchestrator-egress.service)');
    }
    execFileSync('systemctl', ['--user', 'enable', '--now', 'orchestrator'], { stdio: 'ignore' });
    ok('systemd user service installed and started (orchestrator.service)');
    out('  For start at boot without login: sudo loginctl enable-linger $USER   (one-time, requires your authorization)');
  } catch {
    warn(`unit written to ${join(unitDir, 'orchestrator.service')} but systemctl --user is unavailable here; start manually with \`orchestrator run\``);
  }
}

async function doctor(flags: Flags): Promise<number> {
  const cfg = cfgFor(flags);
  let failures = 0;
  const fail = (s: string) => { failures++; bad(s); };
  out(`Doctor — ${cfg.home}`);
  const os = existsSync('/etc/os-release') ? /PRETTY_NAME="([^"]+)"/.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] : `${platform()} ${osRelease()}`;
  (platform() === 'linux' ? ok : warn)(`OS: ${os} (${platform()}); memory ${Math.round(freemem() / 1e9)}/${Math.round(totalmem() / 1e9)} GB free`);
  const [maj, min] = process.versions.node.split('.').map(Number);
  (maj! > 22 || (maj === 22 && min! >= 13) ? ok : fail)(`Node ${process.versions.node} (need >= 22.13)`);
  try { ok(execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()); } catch { fail('git not installed'); }
  try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); ok('tar available'); } catch { fail('tar not installed'); }
  const optedOut = cfg.security.sandbox === 'none' && cfg.security.agentSandbox === 'none';
  if (findBwrap()) ok('bubblewrap sandbox works here (with /proc, /tmp and all namespaces, as agents and gates use it)');
  else (optedOut ? warn : fail)(sandboxAdvice(cfg));
  if (!existsSync(configPath(cfg.home))) { fail('not set up: run `orchestrator setup`'); return 1; }
  try { loadConfig(cfg.home); ok('configuration valid'); } catch (e) { fail((e as Error).message); }
  const mode = statSync(configPath(cfg.home)).mode & 0o777;
  (mode & 0o077 ? fail : ok)(`config permissions ${mode.toString(8)}${mode & 0o077 ? ' (should be 600)' : ''}`);
  const sec = paths(cfg).secrets;
  if (existsSync(sec)) for (const f of readdirSync(sec)) { const m = statSync(join(sec, f)).mode & 0o077; (m ? fail : ok)(`secret ${f} permissions ${m ? 'TOO OPEN' : 'ok'}`); }
  try {
    const s = statfsSync(cfg.home);
    const freeMb = Math.round((s.bavail * s.bsize) / 1e6);
    (freeMb > cfg.supervisor.minFreeDiskMb ? ok : fail)(`disk free at ${cfg.home}: ${freeMb} MB`);
  } catch { warn('could not determine free disk space'); }
  const ctx = createApp({ cfg });
  const ic = ctx.db.integrityCheck();
  (ic === 'ok' ? ok : fail)(`database integrity: ${ic}; schema v${ctx.db.schemaVersion()}`);
  (ctx.events.verifyAuditChain().ok ? ok : fail)('audit log hash chain intact');
  for (const [id, a] of ctx.adapters) {
    const d = await a.detect();
    if (!d.installed) { fail(`${id}: CLI not installed (${d.error ?? ''})`); continue; }
    const au = await a.checkAuth();
    if (!au.ok) fail(`${id} ${d.version}: not authenticated — ${au.detail}`);
    else if (au.apiKeyBilling && !cfg.providers[id]!.allowApiKeyBilling) fail(`${id}: API-key authentication detected; API billing is not authorized`);
    else ok(`${id} ${d.version}: ${au.detail}`);
  }
  try {
    const t = resolveGitHubToken(cfg);
    if (!t) warn('no GitHub token (needed only for GitHub mode)');
    else {
      const r = await fetch(`${cfg.github.apiUrl}/user`, { headers: { Authorization: `Bearer ${t}`, 'User-Agent': 'agent-workflow-orchestrator', 'X-GitHub-Api-Version': '2022-11-28' } });
      if (r.ok) ok(`GitHub token valid${r.headers.get('x-oauth-scopes') ? ` (scopes: ${r.headers.get('x-oauth-scopes')})` : ' (fine-grained)'}`);
      else fail(`GitHub token rejected: HTTP ${r.status}`);
    }
  } catch (e) { fail(`GitHub check failed: ${(e as Error).message}`); }
  const pid = daemonPid(cfg);
  (pid ? ok : warn)(pid ? `supervisor running (pid ${pid})` : 'supervisor not running');
  // The service may run under different restrictions (systemd) than this shell: report what the supervisor itself saw.
  const sbx = ctx.db.get<{ type: string; message: string }>("SELECT type, message FROM events WHERE type IN ('security.sandbox_ok','security.sandbox_unavailable','security.sandbox') ORDER BY id DESC LIMIT 1");
  if (sbx?.type === 'security.sandbox_unavailable') fail(`the supervisor's own sandbox self-check failed at its last start (agents are not dispatched): ${sbx.message}`);
  else if (sbx?.type === 'security.sandbox_ok') ok('supervisor sandbox self-check passed at its last start (inside its own service environment)');
  // Gate backend: chosen explicitly in config; the VM backend never falls back to running gates on this host.
  if ((cfg.security.gateBackend ?? 'local') === 'devvm') {
    const problem = checkDevVmExecutable(cfg.vm.command);
    if (problem) fail(`gate backend devvm: ${problem}; gates will not run until this is fixed`);
    else {
      const r = await devvm(cfg.vm.command!, ['reachable'], { timeoutMs: 20_000 });
      let up: boolean | null = null;
      try { up = r.exitCode === 0 ? !!JSON.parse(r.stdout).reachable : null; } catch { /* unknown */ }
      if (up === null) fail(`gate backend devvm (${cfg.vm.command}): could not query the VM host: ${(r.stderr || r.spawnError || '').trim().slice(0, 300)}`);
      else if (!(await devvmSupportsStatusFile(cfg.vm.command!))) fail(`gate backend devvm (${cfg.vm.command}): this devvm is outdated (no gate --status-file); reinstall it from deploy/devvm/devvm`);
      else ok(`gate backend devvm (${cfg.vm.command}): gates and release verification run in throwaway VMs; host ${up ? 'reachable' : 'asleep (woken on demand)'}`);
    }
    const vmc = ctx.db.get<{ type: string; message: string }>("SELECT type, message FROM events WHERE type IN ('security.vm_backend_ok','security.vm_backend_unavailable') ORDER BY id DESC LIMIT 1");
    if (vmc?.type === 'security.vm_backend_unavailable') fail(`the supervisor's VM backend self-check failed at its last start: ${vmc.message}`);
    else if (vmc) ok(`supervisor VM backend self-check at its last start: ${vmc.message}`);
  } else {
    ok('gate backend local: quality gates run in bubblewrap on this host');
  }
  if ((cfg.security.agentBackend ?? 'local') === 'devvm') {
    const problem = checkDevVmExecutable(cfg.vm.command);
    (problem ? fail : ok)(problem ? `agent backend devvm: ${problem}; agents will not run` : `agent backend devvm: agents run in throwaway VMs; guest egress only through ${cfg.vm.egressProxy}`);
    for (const [prov, file] of [['claude', join(paths(cfg).secrets, 'claude-oauth-token')], ['codex', join(paths(cfg).secrets, 'codex-auth.json')]] as const) {
      if (!cfg.providers[prov]?.enabled) continue;
      if (!existsSync(file)) fail(`agent VMs: ${prov} credential copy missing: ${file} (see docs/operations.md "Agent VMs")`);
      else if (statSync(file).mode & 0o077) fail(`agent VMs: ${file} must be mode 600`);
      else ok(`agent VMs: ${prov} credential copy present (${file}, 600)`);
    }
    try {
      const r = await fetch(cfg.vm.egressProxy!, { signal: AbortSignal.timeout(5000) }).catch((e: Error) => { throw e; });
      ok(`egress proxy ${cfg.vm.egressProxy} answers (HTTP ${r.status})`);
    } catch (e) { fail(`egress proxy ${cfg.vm.egressProxy} is not reachable from here: ${(e as Error).message}; start it with \`systemctl --user start orchestrator-egress\``); }
  }
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(cfg.dashboard.host)) warn(`dashboard bound to ${cfg.dashboard.host}: ensure TLS termination and network restrictions in front of it`);
  if (!cfg.dashboard.tokenHash) fail('dashboard token not configured: run `orchestrator dashboard-token`');
  ctx.db.close();
  out(failures ? `\n${failures} problem(s) found.` : '\nAll checks passed.');
  return failures ? 1 : 0;
}

async function runDaemon(flags: Flags): Promise<number> {
  const cfg = cfgFor(flags);
  if (!existsSync(configPath(cfg.home))) { bad('not set up: run `orchestrator setup` first'); return 1; }
  const ctx = createApp({ cfg, echoLogs: !!flags.verbose });
  const sup = new Supervisor(ctx);
  await sup.start();
  let dash: Dashboard | null = null;
  if (!flags['no-dashboard']) {
    dash = new Dashboard(ctx);
    const a = await dash.listen().catch((e) => { ctx.log.error('dashboard failed to start', { error: (e as Error).message }); return null; });
    if (a) out(`Dashboard on http://${a.host}:${a.port}/`);
  }
  out(`Supervisor ${sup.instanceId} running. Ctrl-C / SIGTERM for graceful shutdown.`);
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    out(`${sig}: graceful shutdown (agents get ${cfg.supervisor.shutdownGraceMs / 1000}s, then are interrupted resumably)…`);
    await dash?.close();
    await sup.stop();
    ctx.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (e) => { ctx.log.error('uncaught exception', { error: e.message, stack: e.stack }); });
  process.on('unhandledRejection', (e) => { ctx.log.error('unhandled rejection', { error: String(e) }); });
  await new Promise(() => {});
  return 0;
}

/** Package this orchestrator itself (source + compiled dist + docs), then verify from a clean extraction. */
async function egressProxy(flags: Flags): Promise<number> {
  const cfg = cfgFor(flags);
  const e = cfg.egress;
  mkdirSync(paths(cfg).logs, { recursive: true, mode: 0o700 });
  const proxy = new EgressProxy({ ...e, logFile: join(paths(cfg).logs, 'egress.jsonl'), cacheDir: e.cacheDir ?? join(cfg.home, 'egress-cache') });
  const { port } = await proxy.start();
  out(`egress proxy listening on ${e.listen}:${port}; ${e.allowHosts.length} allowlisted host pattern(s), ${e.denyHosts.length} denied; clients: ${e.allowClients.join(', ') || 'any (restrict with egress.allowClients)'}`);
  await new Promise<void>((resolve) => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  await proxy.stop();
  return 0;
}

async function selfPackage(flags: Flags): Promise<number> {
  const outDir = resolve(String(flags.out ?? join(ROOT, 'releases')));
  const name = `agent-workflow-orchestrator-${VERSION}`;
  // docs/CHECKPOINT.md is the build log of this repository (operator- and host-specific), not product documentation.
  const skip = (rel: string) => rel === 'docs/CHECKPOINT.md' || /^(node_modules|\.git|releases?|\.orchestrator|tmp)(\/|$)/.test(rel) || /(^|\/)\.(env|DS_Store)$/.test(rel) || rel.endsWith('.db') || rel.endsWith('.log');
  const entries = collectDir(ROOT, name, skip);
  const manifest = { name: 'agent-workflow-orchestrator', version: VERSION, built_at: new Date().toISOString(), node: '>=22.13', runtime_dependencies: 0, files: entries.map((e) => ({ path: e.name.slice(name.length + 1), sha256: sha256(e.data), bytes: e.data.length })) };
  entries.push({ name: `${name}/RELEASE-MANIFEST.json`, data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  const { scanText, isForbiddenFile } = await import('../security/secrets.js');
  const hits = entries.flatMap((e) => (isForbiddenFile(e.name) ? [{ path: e.name, rule: 'forbidden-file' }] : e.data.includes(0) ? [] : scanText(e.name, e.data.toString('utf8')).map((h) => ({ path: h.path, rule: h.rule }))));
  if (hits.length) { bad(`secret scan failed: ${JSON.stringify(hits.slice(0, 5))}`); return 1; }
  mkdirSync(outDir, { recursive: true });
  const zip = join(outDir, `${name}.zip`);
  writeZip(zip, entries);
  const digest = sha256(readFileSync(zip));
  writeFileSync(`${zip}.sha256`, `${digest}  ${name}.zip\n`);
  const check = join(outDir, `.verify-${Date.now()}`);
  extractZip(zip, check);
  const extracted = join(check, name);
  const bad2 = manifest.files.filter((f) => sha256(readFileSync(join(extracted, f.path))) !== f.sha256);
  const v = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(extracted, 'dist', 'src', 'cli', 'main.js'), 'version'], { encoding: 'utf8' }).trim();
  rmSync(check, { recursive: true, force: true });
  if (bad2.length || v !== VERSION) { bad(`verification failed: checksum mismatches=${bad2.length}, version=${v}`); return 1; }
  ok(`${zip}\n    sha256 ${digest}\n    ${entries.length} files, checksums verified after clean extraction, CLI runs (${v})`);
  return 0;
}

main().then((code) => process.exit(code), (e) => { process.stderr.write(`error: ${(e as Error).message}\n`); process.exit(1); });
