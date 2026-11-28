// Agent sessions in throwaway VMs (security.agentBackend = "devvm"). The control plane keeps the source of truth:
// it ships a git bundle (plus any uncommitted supervisor state, e.g. an in-progress merge) into the VM, runs the
// provider CLI there through `devvm ssh`, and takes back only a binary patch that it applies, commits and pushes
// itself. The GitHub token never enters a VM.
//
// Leases:
//  - work:    one per work item, kept from implementation through remediation (so `--resume` / `exec resume` keep
//             working), destroyed when the item is merged, cancelled or blocked.
//  - review:  one per project for read-only tasks (reviews, audits, planning, debates, answers). Implementers never
//             run in it, so an implementing agent cannot change the reviewer's CLI config, hooks or binaries.
//  - warm:    pre-provisioned spares (vm.warmPool) adopted by the next work item; kept only while some project has
//             runnable work, so the gaming PC can sleep when idle.
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { randomToken } from '../core/ids.js';
import type { Ctx } from '../engine/ctx.js';
import type { TaskRow } from '../core/types.js';
import { scanTree } from '../security/secrets.js';
import { git, type Workspace } from '../git/git.js';
import { checkDevVmExecutable, devvm, devvmEnv, EX_SSH, EX_UNAVAILABLE, resolveDevVm } from './devvm.js';

export type LeasePurpose = 'work' | 'review' | 'warm';
export interface LeaseRow {
  id: string; project_id: string | null; work_item_id: string | null; purpose: LeasePurpose; status: 'provisioning' | 'ready' | 'destroying' | 'gone';
  cpus: number; ram_mib: number; disk_gib: number; expires_at: number | null; generation: number; error: string | null; created_at: number; updated_at: number;
}

/** The VM host cannot take work now (asleep, gaming pause, pool full, SSH lost): the task waits; it never runs here. */
export class VmWaitError extends Error {
  constructor(message: string, readonly retryMs: number) { super(message); this.name = 'VmWaitError'; }
}
/** A provider's credential copy is missing or unsafe: an auth failure the operator must fix. */
export class VmCredentialError extends Error {
  constructor(message: string) { super(message); this.name = 'VmCredentialError'; }
}

/** Only these non-secret variables are forwarded to a guest command line. Credentials travel on stdin only. */
const REMOTE_ENV = /^(ORCH_TASK_ID|CI|LANG|TZ|CLAUDE_CODE_RETRY_WATCHDOG|CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS)$/;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const LEASE_ID = /^[0-9a-f]{32}$/;
const DIR_NAME = /[^A-Za-z0-9_.-]/g;

export function credentialFiles(ctx: Ctx): { claude: string; codex: string } {
  return { claude: join(ctx.paths.secrets, 'claude-oauth-token'), codex: join(ctx.paths.secrets, 'codex-auth.json') };
}

/** A secret source must be a regular file readable only by the service user. */
function readSecret(path: string, what: string): string {
  if (!existsSync(path)) throw new VmCredentialError(`${what} is missing: create ${path} (mode 600); see docs/operations.md "Agent VMs"`);
  const st = statSync(path);
  if (!st.isFile()) throw new VmCredentialError(`${path} is not a regular file`);
  if (st.mode & 0o077) throw new VmCredentialError(`${path} must be mode 600 (it is ${(st.mode & 0o777).toString(8)})`);
  return readFileSync(path, 'utf8');
}

export class VmPool {
  private holdUntil = 0;
  private holdReason: string | null = null;
  private provisioning = new Map<string, Promise<LeaseRow>>();

  constructor(private ctx: Ctx) {}

  get enabled(): boolean { return (this.ctx.cfg.security.agentBackend ?? 'local') === 'devvm'; }
  private get exe(): string { return this.ctx.cfg.vm.command!; }

  // ------------------------------------------------------------ availability
  held(): boolean { return this.ctx.clock.now() < this.holdUntil; }
  holdStatus(): { until: number; reason: string } | null { return this.holdReason ? { until: this.holdUntil, reason: this.holdReason } : null; }
  private hold(reason: string, ms = this.ctx.cfg.vm.unavailableRetryMin * 60_000): void {
    const first = !this.holdReason;
    this.holdUntil = this.ctx.clock.now() + ms;
    this.holdReason = reason.slice(0, 500);
    if (first) {
      this.ctx.events.emit('vm.unavailable', `agent work is waiting for the VM host: ${this.holdReason}`, { level: 'warn', data: { retryAt: this.holdUntil } });
      this.ctx.events.audit('supervisor', 'vm.unavailable', { detail: { reason: this.holdReason } });
    }
  }
  private available(): void {
    if (!this.holdReason) return;
    this.holdReason = null; this.holdUntil = 0;
    this.ctx.events.emit('vm.available', 'the VM host is taking agent work again', { level: 'info' });
  }

  private async call(args: string[], opts: { stdin?: string | Readable; timeoutMs?: number; maxCaptureBytes?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; unavailable: boolean }> {
    const r = await devvm(this.exe, args, { stdin: opts.stdin, timeoutMs: opts.timeoutMs ?? 10 * 60_000, maxCaptureBytes: opts.maxCaptureBytes });
    return { code: r.exitCode, stdout: r.stdout, stderr: (r.stderr || r.spawnError || '').trim(), unavailable: r.unavailable };
  }
  private wait(what: string, r: { stderr: string; code: number | null }): never {
    const msg = `${what}: ${r.stderr.split('\n').slice(-2).join(' ') || `devvm exited ${r.code}`}`;
    // A full pool frees up as other work finishes; an asleep/paused host needs longer.
    const capacity = /limit reached|reserve would be breached|No SSH port/i.test(msg);
    this.hold(msg, capacity ? 60_000 : undefined);
    throw new VmWaitError(msg, capacity ? 60_000 : this.ctx.cfg.vm.unavailableRetryMin * 60_000);
  }

  // ------------------------------------------------------------ leases
  rows(where = "status IN ('provisioning','ready')", ...params: Array<string | number>): LeaseRow[] {
    return this.ctx.db.all<LeaseRow>(`SELECT * FROM vm_leases WHERE ${where} ORDER BY created_at`, ...params);
  }
  private setRow(id: string, patch: Partial<LeaseRow>): void {
    const keys = Object.keys(patch);
    this.ctx.db.run(`UPDATE vm_leases SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map((k) => (patch as Record<string, any>)[k]), this.ctx.clock.now(), id);
  }

  /** The lease a task runs in. Provisions (or adopts a warm spare) when there is none. */
  async leaseFor(task: TaskRow): Promise<LeaseRow> {
    const purpose: LeasePurpose = task.work_item_id && !task.read_only ? 'work' : 'review';
    const key = purpose === 'work' ? `w:${task.work_item_id}` : `r:${task.project_id}`;
    const pending = this.provisioning.get(key);
    if (pending) return pending;
    const existing = purpose === 'work'
      ? this.ctx.db.get<LeaseRow>("SELECT * FROM vm_leases WHERE work_item_id=? AND purpose='work' AND status='ready' ORDER BY created_at DESC LIMIT 1", task.work_item_id)
      : this.ctx.db.get<LeaseRow>("SELECT * FROM vm_leases WHERE project_id=? AND purpose='review' AND status='ready' ORDER BY created_at DESC LIMIT 1", task.project_id);
    if (existing) return existing;
    const p = this.obtain(purpose, task).finally(() => this.provisioning.delete(key));
    this.provisioning.set(key, p);
    return p;
  }

  private async obtain(purpose: LeasePurpose, task: TaskRow): Promise<LeaseRow> {
    const prior = this.ctx.db.get<{ g: number }>('SELECT MAX(generation) AS g FROM vm_leases WHERE purpose=? AND COALESCE(work_item_id, project_id)=?', purpose, purpose === 'work' ? task.work_item_id : task.project_id)?.g ?? 0;
    if (purpose === 'work') {
      const warm = this.ctx.db.get<LeaseRow>("SELECT * FROM vm_leases WHERE purpose='warm' AND status='ready' ORDER BY created_at LIMIT 1");
      if (warm) {
        this.setRow(warm.id, { purpose: 'work', project_id: task.project_id, work_item_id: task.work_item_id, generation: prior + 1 });
        this.ctx.events.emit('vm.lease_adopted', `work item lease ${warm.id.slice(0, 8)} adopted from the warm pool`, { projectId: task.project_id, taskId: task.id });
        return this.ctx.db.get<LeaseRow>('SELECT * FROM vm_leases WHERE id=?', warm.id)!;
      }
    }
    return this.provision(purpose, purpose === 'warm' ? null : task.project_id, purpose === 'work' ? task.work_item_id : null, prior + 1);
  }

  async provision(purpose: LeasePurpose, projectId: string | null, workItemId: string | null, generation = 1): Promise<LeaseRow> {
    const problem = checkDevVmExecutable(this.ctx.cfg.vm.command);
    if (problem) { this.hold(`VM backend unusable: ${problem}`); throw new VmWaitError(problem, this.ctx.cfg.vm.unavailableRetryMin * 60_000); }
    const size = purpose === 'review' ? this.ctx.cfg.vm.review : this.ctx.cfg.vm.agent;
    const id = randomBytes(16).toString('hex');
    if (!LEASE_ID.test(id)) throw new Error('lease id generation failed');
    const now = this.ctx.clock.now();
    // Recorded BEFORE the VM exists, so a crash mid-provision leaves a row the next start reaps.
    this.ctx.db.run('INSERT INTO vm_leases(id, project_id, work_item_id, purpose, status, cpus, ram_mib, disk_gib, expires_at, generation, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, projectId, workItemId, purpose, 'provisioning', size.cpus, size.ramMib, size.diskGib, null, generation, now, now);
    const r = await this.call(['provision', '--id', id, '--cpus', String(size.cpus), '--ram-mib', String(size.ramMib), '--disk-gib', String(size.diskGib), '--ttl-minutes', String(this.ctx.cfg.vm.agent.ttlMinutes)], { timeoutMs: 12 * 60_000 });
    if (r.code !== 0) {
      this.setRow(id, { status: 'gone', error: r.stderr.slice(0, 500) });
      await this.call(['destroy', id], { timeoutMs: 5 * 60_000 }).catch(() => undefined);
      this.wait('could not provision a VM', r); // asleep, gaming pause, pool full or a host-side error: wait, never run here
    }
    let lease: { expires_at?: number } = {};
    try { lease = JSON.parse(r.stdout); } catch { /* keep defaults */ }
    this.setRow(id, { status: 'ready', expires_at: lease.expires_at ? lease.expires_at * 1000 : now + this.ctx.cfg.vm.agent.ttlMinutes * 60_000 });
    try {
      await this.installCredentials(id);
    } catch (e) {
      await this.destroy(id, 'credential setup failed');
      if (e instanceof VmCredentialError) throw e;
      throw new VmWaitError(`could not install credentials in the VM: ${(e as Error).message}`, 60_000);
    }
    this.available();
    this.ctx.events.emit('vm.lease_ready', `${purpose} VM ${id.slice(0, 8)} ready (${size.cpus} vCPU, ${size.ramMib} MiB, ${size.diskGib} GiB)`, { projectId: projectId ?? undefined });
    this.ctx.events.audit('supervisor', 'vm.provision', { projectId, target: id, detail: { purpose, workItemId, generation } });
    return this.ctx.db.get<LeaseRow>('SELECT * FROM vm_leases WHERE id=?', id)!;
  }

  /** Copy the provider credentials into the guest over stdin (never on a command line, never logged). */
  private async installCredentials(id: string): Promise<void> {
    const files = credentialFiles(this.ctx);
    const want = (p: string) => this.ctx.cfg.providers[p]?.enabled && this.ctx.adapters.has(p);
    if (want('claude')) {
      const token = readSecret(files.claude, 'Claude credential (from `claude setup-token`)').trim();
      if (!/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(token)) throw new VmCredentialError(`${files.claude} does not look like a token from \`claude setup-token\``);
      const r = await this.call(['ssh', id, '--', 'umask 077; mkdir -p "$HOME/.orch" && cat > "$HOME/.orch/credentials.env"'], { stdin: `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`, timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`claude credential copy failed (exit ${r.code})`);
    }
    if (want('codex')) {
      const auth = readSecret(files.codex, 'Codex credential (auth.json from `codex login --device-auth`)');
      try { JSON.parse(auth); } catch { throw new VmCredentialError(`${files.codex} is not valid JSON`); }
      const r = await this.call(['ssh', id, '--', 'umask 077; mkdir -p "$HOME/.codex" && cat > "$HOME/.codex/auth.json"'], { stdin: auth, timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`codex credential copy failed (exit ${r.code})`);
    }
  }

  /** Documented Codex behaviour: it refreshes auth.json during use. Optionally keep the refreshed copy (vm.codexAuthWriteBack). */
  private async writeBackCodexAuth(id: string): Promise<void> {
    if (!this.ctx.cfg.vm.codexAuthWriteBack) return;
    const r = await this.call(['ssh', id, '--', 'cat "$HOME/.codex/auth.json"'], { timeoutMs: 60_000 });
    if (r.code !== 0) return;
    const file = credentialFiles(this.ctx).codex;
    let fresh: { last_refresh?: string }, cur: { last_refresh?: string };
    try { fresh = JSON.parse(r.stdout); cur = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
    if (!fresh.last_refresh || (cur.last_refresh && Date.parse(fresh.last_refresh) <= Date.parse(cur.last_refresh))) return;
    const tmp = `${file}.${randomToken(4)}.tmp`;
    writeFileSync(tmp, r.stdout, { mode: 0o600 });
    renameSync(tmp, file);
    this.ctx.events.audit('supervisor', 'vm.codex_auth_refreshed', { target: id });
  }

  async destroy(id: string, why: string): Promise<void> {
    this.setRow(id, { status: 'destroying', error: why });
    const r = await this.call(['destroy', id], { timeoutMs: 6 * 60_000 });
    if (r.code === 0) {
      this.setRow(id, { status: 'gone' });
      this.ctx.events.audit('supervisor', 'vm.destroy', { target: id, detail: { why } });
    }
    // Otherwise it stays 'destroying' and is retried by reconcile(); the host reaper also removes it at its TTL.
  }

  // ------------------------------------------------------------ workspace in / result out
  guestDir(task: TaskRow, cwd: string): string {
    const base = basename(cwd).replace(DIR_NAME, '_');
    // Read-only tasks share the review VM: give each its own directory so concurrent reviews never collide.
    return task.work_item_id && !task.read_only ? `work/${base}` : `work/${base}-${task.id.replace(DIR_NAME, '_')}`;
  }

  /**
   * Ship the worktree's committed state (a bundle) and any uncommitted supervisor state (a binary patch) into the
   * guest directory. A work lease whose directory already holds this exact state is left alone, so a resumed
   * session continues with its own partial edits.
   */
  async syncIn(lease: LeaseRow, ws: Workspace, cwd: string, dir: string, opts: { readOnly: boolean }): Promise<string> {
    if (scanTree(cwd).length) throw new VmCredentialError('the built-in secret scan found credentials in the workspace; nothing was sent to the VM');
    const head = (await ws.gitIn(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    const pending = await this.workingPatch(ws, cwd);
    const marker = `${head}:${pending ? sha(pending) : '-'}`;
    const tmp = mkdtempSync(join(tmpdir(), 'orch-vmsync-'));
    try {
      const bundle = join(tmp, 'in.bundle');
      // The bundle carries only the commit graph (no config, remotes or credentials).
      await git(ws.bare, ['bundle', 'create', bundle, head, ...(await this.refsFor(ws, head))], { timeoutMs: 300_000 }).catch(async () => {
        await git(cwd, ['bundle', 'create', bundle, 'HEAD'], { timeoutMs: 300_000, env: await ws.guard(cwd) });
      });
      const d = q(dir);
      const up = await this.call(['ssh', lease.id, '--', `set -e; umask 077; mkdir -p "$HOME"/${d}; cat > "$HOME"/${d}.bundle`], { stdin: createReadStream(bundle), timeoutMs: 15 * 60_000 });
      if (up.code !== 0) return this.lost(lease, up, 'sending the workspace');
      const script = [
        'set -e', `cd "$HOME"/${d}`,
        `if [ ! -d .git ]; then git init -q . ; fi`,
        `git fetch -q --no-tags "$HOME"/${d}.bundle ${q(head)}`,
        `rm -f "$HOME"/${d}.bundle`,
        // Keep a resumed session's partial edits when nothing changed on the control plane since the last sync.
        `if [ "$(cat .git/orch-synced 2>/dev/null)" != ${q(marker)} ] || [ ${opts.readOnly ? 1 : 0} = 1 ]; then`,
        `  git -c advice.detachedHead=false checkout -q -f --detach ${q(head)}; git clean -qfdx`,
        pending ? `  printf %s ${q(Buffer.from(pending).toString('base64'))} | base64 -d | git apply --binary --whitespace=nowarn` : '  :',
        `  echo ${q(marker)} > .git/orch-synced`,
        'fi',
      ].join('\n');
      const r = await this.call(['ssh', lease.id, '--', script], { timeoutMs: 10 * 60_000 });
      if (r.code !== 0) return this.lost(lease, r, 'checking out the workspace');
      return head;
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  private async refsFor(ws: Workspace, head: string): Promise<string[]> {
    const def = (await git(ws.bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${ws.defaultBranch}`], { allowFail: true })).stdout.trim();
    return def && def !== head ? [def] : [];
  }

  /** Binary patch of everything in `dir` that differs from HEAD, including untracked files (via a temporary index). */
  private async workingPatch(ws: Workspace, cwd: string): Promise<string> {
    const idx = join(mkdtempSync(join(tmpdir(), 'orch-idx-')), 'index');
    try {
      const env = { GIT_INDEX_FILE: idx };
      await ws.gitIn(cwd, ['read-tree', 'HEAD'], { env });
      await ws.gitIn(cwd, ['add', '-A'], { env });
      return (await ws.gitIn(cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'], { env })).stdout;
    } finally { rmSync(join(idx, '..'), { recursive: true, force: true }); }
  }

  /**
   * Take the agent's result back: a binary patch of the guest directory against the synced commit. The worktree is
   * returned to that commit (keeping an in-progress merge's MERGE_HEAD) and the patch applied; the supervisor then
   * commits as usual.
   */
  async syncOut(lease: LeaseRow, ws: Workspace, cwd: string, dir: string, head: string): Promise<{ files: number }> {
    const script = `set -e; cd "$HOME"/${q(dir)}; idx=$(mktemp); trap 'rm -f "$idx"' EXIT; GIT_INDEX_FILE=$idx git read-tree ${q(head)}; GIT_INDEX_FILE=$idx git add -A; GIT_INDEX_FILE=$idx git diff --cached --binary --no-ext-diff --no-textconv ${q(head)}`;
    const r = await this.call(['ssh', lease.id, '--', script], { timeoutMs: 10 * 60_000, maxCaptureBytes: 256 * 1024 * 1024 });
    if (r.code !== 0) return this.lost(lease, r, 'collecting the result');
    const patch = r.stdout;
    const tmp = mkdtempSync(join(tmpdir(), 'orch-vmout-'));
    try {
      const file = join(tmp, 'out.patch');
      writeFileSync(file, patch, { mode: 0o600 });
      if (patch.trim()) {
        // Paths are checked by git apply (no absolute paths, no `..`); refuse anything that targets git metadata.
        const names = (await ws.gitIn(cwd, ['apply', '--numstat', '-z', file])).stdout.split('\0').map((l) => l.split('\t').pop() ?? '').filter(Boolean);
        if (names.some((n) => n === '.git' || n.startsWith('.git/') || n.includes('/.git/'))) throw new Error('the agent result touches .git; refused');
      }
      // Start from the synced commit (an in-progress merge keeps MERGE_HEAD), then apply the guest's whole result.
      await ws.gitIn(cwd, ['read-tree', '--reset', '-u', head]);
      await ws.gitIn(cwd, ['clean', '-qfd']);
      if (patch.trim()) await ws.gitIn(cwd, ['apply', '--binary', '--whitespace=nowarn', file]);
      return { files: patch ? (patch.match(/^diff --git /gm) ?? []).length : 0 };
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  async cleanupDir(lease: LeaseRow, dir: string): Promise<void> {
    await this.call(['ssh', lease.id, '--', `rm -rf "$HOME"/${q(dir)}`], { timeoutMs: 120_000 }).catch(() => undefined);
  }

  /** Stop a task's CLI inside the guest after an abort or timeout (ssh disconnect alone does not kill it). */
  async killRemote(lease: LeaseRow, taskId: string): Promise<void> {
    const pid = `"$HOME"/.orch/${q(taskId.replace(DIR_NAME, '_'))}.pid`;
    await this.call(['ssh', lease.id, '--', `if [ -f ${pid} ]; then kill -TERM "$(cat ${pid})" 2>/dev/null || true; rm -f ${pid}; fi`], { timeoutMs: 60_000 }).catch(() => undefined);
  }

  /** The SSH step failed: tell an outage (wait) from a lost/expired lease (rebuild). */
  private async lost(lease: LeaseRow, r: { code: number | null; stderr: string; unavailable: boolean }, what: string): Promise<never> {
    const st = await this.call(['status', lease.id], { timeoutMs: 60_000 });
    let phase = '';
    try { phase = JSON.parse(st.stdout).phase ?? ''; } catch { /* unknown */ }
    if (phase === 'absent' || /expired|no local receipt/i.test(r.stderr)) {
      this.setRow(lease.id, { status: 'gone', error: `lost while ${what}` });
      this.ctx.events.emit('vm.lease_lost', `VM ${lease.id.slice(0, 8)} was lost or expired while ${what}; a new one will be built from checkpoints`, { level: 'warn', projectId: lease.project_id ?? undefined });
      throw new VmWaitError(`VM lease lost while ${what}`, 0);
    }
    if (r.unavailable || st.unavailable) this.wait(`VM unreachable while ${what}`, r);
    throw new Error(`${what} in the VM failed (exit ${r.code}): ${r.stderr.slice(-300)}`);
  }

  /** Build the `devvm ssh` invocation that runs a provider CLI inside the guest directory. */
  wrap(lease: LeaseRow, task: TaskRow, cwd: string, dir: string, cmd: string, args: string[], extraDirs: string[], env: Record<string, string>): { cmd: string; args: string[]; env: Record<string, string> } {
    const maps: Array<[string, string]> = [[cwd, `"$HOME"/${q(dir)}`], ...extraDirs.map((d, i) => [d, `"$HOME"/${q(`.orch/tmp/${task.id.replace(DIR_NAME, '_')}-${i}`)}`] as [string, string])];
    const map = (a: string) => {
      for (const [local, guest] of maps) if (a === local || a.startsWith(local + '/')) return guest + (a.length > local.length ? q(a.slice(local.length)) : '');
      return q(a);
    };
    const files: string[] = [];
    for (const [i, d] of extraDirs.entries()) {
      // Small scratch inputs (e.g. Codex's output schema) are recreated in the guest; outputs are read from the stream.
      const g = `"$HOME"/${q(`.orch/tmp/${task.id.replace(DIR_NAME, '_')}-${i}`)}`;
      files.push(`mkdir -p ${g}`);
      for (const f of safeList(d)) files.push(`printf %s ${q(readFileSync(join(d, f)).toString('base64'))} | base64 -d > ${g}/${q(f)}`);
    }
    const proxy = this.ctx.cfg.vm.egressProxy!;
    const vars = Object.entries(env).filter(([k]) => REMOTE_ENV.test(k)).map(([k, v]) => `${k}=${q(v)}`);
    const pid = `"$HOME"/.orch/${q(task.id.replace(DIR_NAME, '_'))}.pid`;
    const script = [
      'set -e', 'umask 077', 'mkdir -p "$HOME/.orch"', ...files,
      `cd "$HOME"/${q(dir)}`,
      'if [ -f "$HOME/.orch/credentials.env" ]; then set -a; . "$HOME/.orch/credentials.env"; set +a; fi',
      'unset ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY GITHUB_TOKEN GH_TOKEN',
      `export HTTPS_PROXY=${q(proxy)} HTTP_PROXY=${q(proxy)} https_proxy=${q(proxy)} http_proxy=${q(proxy)} NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 ${vars.join(' ')}`,
      `echo $$ > ${pid}`,
      `exec ${q(cmd)} ${args.map(map).join(' ')}`,
    ].join('\n');
    // The local devvm process gets only its own minimal environment (no agent or provider variables).
    return { cmd: resolveDevVm(this.exe), args: ['ssh', lease.id, '--', script], env: devvmEnv() };
  }

  /** After a run: keep the work lease (resume), refresh Codex's credential copy if enabled. */
  async afterRun(lease: LeaseRow, provider: string): Promise<void> {
    if (provider === 'codex') await this.writeBackCodexAuth(lease.id).catch(() => undefined);
  }

  // ------------------------------------------------------------ lifecycle
  /**
   * Called every tick: renew leases in use before their TTL, destroy leases whose item is merged/cancelled/blocked
   * (or whose project stopped), keep the warm pool only while there is runnable work, and retry failed destroys.
   */
  async reconcile(opts: { runnableWork: boolean; busyLeases: Set<string> }): Promise<void> {
    if (!this.enabled) return;
    const now = this.ctx.clock.now();
    for (const l of this.rows("status='destroying'")) await this.destroy(l.id, l.error ?? 'retry');
    for (const l of this.rows("status='ready'")) {
      if (opts.busyLeases.has(l.id)) { await this.renewIfDue(l, now); continue; }
      let why: string | null = null;
      if (l.purpose === 'work') {
        const w = l.work_item_id ? this.ctx.db.get<{ status: string }>('SELECT status FROM work_items WHERE id=?', l.work_item_id) : undefined;
        if (!w || ['merged', 'done', 'cancelled', 'blocked'].includes(w.status)) why = `work item ${w?.status ?? 'gone'}`;
      }
      if (l.project_id) {
        const p = this.ctx.db.get<{ status: string }>('SELECT status FROM projects WHERE id=?', l.project_id);
        if (!p || ['completed', 'stopped', 'failed', 'blocked', 'paused'].includes(p.status)) why ??= `project ${p?.status ?? 'gone'}`;
      }
      if (l.purpose === 'review' && !opts.runnableWork) why ??= 'no runnable work';
      if (l.purpose === 'warm' && !opts.runnableWork) why ??= 'no runnable work: letting the PC sleep';
      if (why) await this.destroy(l.id, why);
      else await this.renewIfDue(l, now);
    }
    if (opts.runnableWork && !this.held()) {
      const warm = this.rows("status IN ('provisioning','ready') AND purpose='warm'").length + [...this.provisioning.keys()].filter((k) => k.startsWith('warm')).length;
      for (let i = warm; i < this.ctx.cfg.vm.warmPool; i++) {
        const key = `warm:${randomToken(4)}`;
        const p = this.provision('warm', null, null).catch((e) => { if (!(e instanceof VmWaitError)) this.ctx.log.warn('warm VM provision failed', { error: (e as Error).message }); return null as never; }).finally(() => this.provisioning.delete(key));
        this.provisioning.set(key, p);
      }
    }
  }

  private async renewIfDue(l: LeaseRow, now: number): Promise<void> {
    if (!l.expires_at || l.expires_at - now > this.ctx.cfg.vm.agent.renewBeforeMin * 60_000) return;
    const r = await this.call(['renew', l.id, '--ttl-minutes', String(this.ctx.cfg.vm.agent.ttlMinutes)], { timeoutMs: 120_000 });
    if (r.code === 0) {
      let exp: number | undefined;
      try { exp = JSON.parse(r.stdout).expires_at; } catch { /* keep */ }
      this.setRow(l.id, { expires_at: exp ? exp * 1000 : now + this.ctx.cfg.vm.agent.ttlMinutes * 60_000 });
      return;
    }
    if (/absent|expired|no local receipt/i.test(r.stderr) || l.expires_at <= now) {
      this.setRow(l.id, { status: 'gone', error: 'expired before renewal' });
      this.ctx.events.emit('vm.lease_lost', `VM ${l.id.slice(0, 8)} expired; the next task rebuilds it from checkpoints`, { level: 'warn', projectId: l.project_id ?? undefined });
    }
  }

  /** Startup: leases left provisioning by a dead instance are destroyed; unknown leases (not ours) are left alone. */
  async recover(): Promise<number> {
    if (!this.enabled) return 0;
    let n = 0;
    for (const l of this.rows("status='provisioning'")) { await this.destroy(l.id, 'interrupted provisioning (supervisor restart)'); n++; }
    return n;
  }

  /** Destroy every lease of a work item now (merge, cancel, block). */
  async releaseItem(workItemId: string, why: string): Promise<void> {
    for (const l of this.rows("status='ready' AND work_item_id=?", workItemId)) await this.destroy(l.id, why);
  }
}

function sha(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 16); }

/** Small regular files directly inside a scratch directory (inputs such as Codex's output schema). */
function safeList(d: string): string[] {
  try {
    return readdirSync(d).filter((f) => /^[A-Za-z0-9_.-]+$/.test(f) && statSync(join(d, f)).isFile() && statSync(join(d, f)).size < 256 * 1024);
  } catch { return []; }
}

/** devvm/ssh exit statuses that mean the VM connection failed rather than the command. */
export const VM_EXIT_LOST = new Set([EX_UNAVAILABLE, EX_SSH]);
