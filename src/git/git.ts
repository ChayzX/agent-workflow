// Git operations via the git CLI (argument arrays, never a shell). The managed repository is a
// bare clone; each task gets its own worktree on its own branch, and an integration worktree
// holds the default branch. The operator's own checkouts are never modified.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface GitResult { code: number; stdout: string; stderr: string }

export class GitError extends Error {
  constructor(public args: string[], public result: GitResult) {
    super(`git ${args.slice(0, 3).join(' ')} failed (${result.code}): ${result.stderr.trim().slice(0, 500)}`);
  }
}

const BOT = { name: 'Agent Workflow Orchestrator', email: 'orchestrator@localhost' };

export function git(cwd: string, args: string[], opts: { env?: Record<string, string>; allowFail?: boolean; input?: string; timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: BOT.name, GIT_AUTHOR_EMAIL: BOT.email,
      GIT_COMMITTER_NAME: BOT.name, GIT_COMMITTER_EMAIL: BOT.email, ...opts.env,
    };
    // Never execute repository hooks or config-defined helpers from agent-writable repositories.
    const hardened = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'core.sshCommand=ssh', ...args];
    const child = execFile('git', hardened, { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 300_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      const r = { code, stdout: String(stdout), stderr: String(stderr) };
      if (code !== 0 && !opts.allowFail) reject(new GitError(args, r));
      else resolve(r);
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Credentials are injected per-invocation via env-scoped config, never written to .git/config. */
export function authEnv(token: string | null, host = 'github.com'): Record<string, string> {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}

export class Workspace {
  readonly bare: string;
  readonly integration: string;
  readonly wtRoot: string;
  constructor(readonly root: string, readonly defaultBranch: string, private auth: () => Record<string, string> = () => ({})) {
    this.bare = join(root, 'repo.git');
    this.integration = join(root, 'integration');
    this.wtRoot = join(root, 'wt');
  }

  /** Clone (or initialize) the managed repository. Idempotent. */
  async ensure(source: string | null): Promise<void> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!existsSync(join(this.bare, 'HEAD'))) {
      if (source) {
        await git(this.root, ['clone', '--bare', source, this.bare], { env: this.auth() });
        await git(this.bare, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
        await git(this.bare, ['fetch', 'origin'], { env: this.auth() });
      } else {
        await git(this.root, ['init', '--bare', '-b', this.defaultBranch, this.bare]);
      }
    }
    if (!existsSync(join(this.integration, '.git'))) {
      const hasBranch = (await git(this.bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${this.defaultBranch}`], { allowFail: true })).code === 0;
      if (!hasBranch) {
        // Empty repository: create the default branch with an initial commit.
        await git(this.bare, ['worktree', 'add', '--orphan', '-b', this.defaultBranch, this.integration], { allowFail: true }).then(async (r) => {
          if (r.code !== 0) {
            mkdirSync(this.integration, { recursive: true });
            await git(this.bare, ['worktree', 'add', '--detach', this.integration]);
            await git(this.integration, ['checkout', '--orphan', this.defaultBranch]);
          }
        });
        await git(this.integration, ['commit', '--allow-empty', '-m', 'chore: initialize repository']);
      } else {
        await git(this.bare, ['worktree', 'add', this.integration, this.defaultBranch]);
      }
    }
    await this.recover();
  }

  async fetch(): Promise<void> {
    await this.sanitizeConfig(null);
    await git(this.bare, ['fetch', '--prune', 'origin'], { env: this.auth() });
  }

  async head(dir = this.integration): Promise<string> {
    return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  }

  wtPath(key: string): string {
    return join(this.wtRoot, key);
  }

  /** Create (or reuse) an isolated worktree on a unique branch from a base commit. */
  async worktree(key: string, branch: string, base: string): Promise<{ path: string; base: string; created: boolean }> {
    const path = this.wtPath(key);
    if (existsSync(join(path, '.git'))) return { path, base, created: false };
    mkdirSync(this.wtRoot, { recursive: true });
    const exists = (await git(this.bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
    await git(this.bare, ['worktree', 'prune']);
    if (exists) await git(this.bare, ['worktree', 'add', path, branch]);
    else await git(this.bare, ['worktree', 'add', '-b', branch, path, base]);
    return { path, base, created: true };
  }

  async removeWorktree(key: string): Promise<void> {
    const path = this.wtPath(key);
    if (existsSync(path)) await git(this.bare, ['worktree', 'remove', '--force', path], { allowFail: true });
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    await git(this.bare, ['worktree', 'prune'], { allowFail: true });
  }

  async isDirty(dir: string): Promise<boolean> {
    return (await git(dir, ['status', '--porcelain'])).stdout.trim().length > 0;
  }

  /** Commit all changes in a worktree as the orchestrator (deterministic attribution). */
  async commitAll(dir: string, message: string): Promise<string | null> {
    if (!(await this.isDirty(dir))) return null;
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', message, '--no-verify']);
    return this.head(dir);
  }

  async changedFiles(dir: string, base: string, head = 'HEAD'): Promise<string[]> {
    const r = await git(dir, ['diff', '--name-only', `${base}...${head}`], { allowFail: true });
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /** Bounded diff for reviewers: full patch up to maxChars, then a stat summary for the rest. */
  async diff(dir: string, base: string, head: string, maxChars: number): Promise<{ text: string; truncated: boolean; files: string[] }> {
    const files = await this.changedFiles(dir, base, head);
    const full = (await git(dir, ['diff', '--no-color', '-U3', `${base}...${head}`])).stdout;
    if (full.length <= maxChars) return { text: full, truncated: false, files };
    const stat = (await git(dir, ['diff', '--stat', `${base}...${head}`])).stdout;
    return { text: full.slice(0, maxChars - stat.length - 200) + `\n\n[... diff truncated; inspect files directly ...]\n${stat}`, truncated: true, files };
  }

  /**
   * Merge a branch into the default branch in the integration worktree without committing,
   * so gates can verify the merged tree before the default branch moves.
   */
  async stageMerge(branch: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
    await this.recover();
    const r = await git(this.integration, ['merge', '--no-ff', '--no-commit', branch], { allowFail: true });
    if (r.code === 0) return { ok: true };
    const conflicts = (await git(this.integration, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout.split('\n').filter(Boolean);
    await git(this.integration, ['merge', '--abort'], { allowFail: true });
    return { ok: false, conflicts };
  }

  async commitMerge(message: string): Promise<string> {
    await git(this.integration, ['commit', '--no-verify', '-m', message]);
    return this.head();
  }

  async abortMerge(): Promise<void> {
    await git(this.integration, ['merge', '--abort'], { allowFail: true });
    await git(this.integration, ['reset', '--hard', 'HEAD'], { allowFail: true });
  }

  /** Bring the default branch into a task branch; leaves conflict markers for an agent to resolve. */
  async mergeDefaultInto(dir: string): Promise<{ ok: boolean; conflicts: string[] }> {
    const r = await git(dir, ['merge', '--no-edit', this.defaultBranch], { allowFail: true });
    if (r.code === 0) return { ok: true, conflicts: [] };
    const conflicts = (await git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout.split('\n').filter(Boolean);
    return { ok: false, conflicts };
  }

  /**
   * Strip repository-local config that could redirect or intercept authenticated network operations
   * (url.*.insteadOf, http.*, credential.*, include*, core.gitProxy, …). Agents can write inside
   * worktrees, so the shared config is re-validated before every fetch/push.
   */
  async sanitizeConfig(expectedRemote: string | null): Promise<string[]> {
    const removed: string[] = [];
    const list = (await git(this.bare, ['config', '--local', '--list', '--name-only'], { allowFail: true })).stdout.split('\n').filter(Boolean);
    const allowed = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch)|branch\.[^.]+\.(remote|merge)|gc\.[a-z]+|init\.defaultbranch)$/i;
    for (const key of [...new Set(list)]) {
      if (allowed.test(key)) continue;
      await git(this.bare, ['config', '--local', '--unset-all', key], { allowFail: true });
      removed.push(key);
    }
    if (expectedRemote) {
      const cur = (await git(this.bare, ['config', '--local', 'remote.origin.url'], { allowFail: true })).stdout.trim();
      if (cur !== expectedRemote) { await git(this.bare, ['config', '--local', 'remote.origin.url', expectedRemote]); removed.push(`remote.origin.url(${cur})`); }
    }
    return removed;
  }

  async push(branch: string, force = false): Promise<void> {
    await this.sanitizeConfig(null);
    await git(this.bare, ['push', '--no-verify', ...(force ? ['--force-with-lease'] : []), 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { env: this.auth() });
  }

  /** After a remote (PR) merge: fast-forward the integration worktree to the remote default branch. */
  async syncDefaultFromRemote(): Promise<string> {
    await this.fetch();
    await git(this.integration, ['reset', '--hard', `origin/${this.defaultBranch}`]);
    return this.head();
  }

  /** Repair interrupted git operations across all worktrees (restart recovery). */
  async recover(): Promise<string[]> {
    const fixed: string[] = [];
    const dirs = [this.integration, ...(existsSync(this.wtRoot) ? readdirSync(this.wtRoot).map((d) => join(this.wtRoot, d)) : [])];
    for (const dir of dirs) {
      if (!existsSync(join(dir, '.git'))) continue;
      const gitDir = (await git(dir, ['rev-parse', '--git-dir'], { allowFail: true })).stdout.trim();
      const abs = gitDir.startsWith('/') ? gitDir : join(dir, gitDir);
      const lock = join(abs, 'index.lock');
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 120_000) { unlinkSync(lock); fixed.push(`${dir}: removed stale index.lock`); }
      if (existsSync(join(abs, 'rebase-merge')) || existsSync(join(abs, 'rebase-apply'))) { await git(dir, ['rebase', '--abort'], { allowFail: true }); fixed.push(`${dir}: aborted rebase`); }
      if (dir === this.integration && existsSync(join(abs, 'MERGE_HEAD'))) { await this.abortMerge(); fixed.push(`${dir}: aborted merge`); }
    }
    await git(this.bare, ['worktree', 'prune'], { allowFail: true });
    return fixed;
  }

  /** Export a commit's tree (tracked files only) into a directory. */
  async archive(commit: string, outTar: string): Promise<void> {
    await git(this.bare, ['archive', '--format=tar', '-o', outTar, commit]);
  }

  async commitExists(sha: string): Promise<boolean> {
    return (await git(this.bare, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })).code === 0;
  }

  async log(range: string, max = 50): Promise<string[]> {
    return (await git(this.bare, ['log', '--format=%h %s', `-n${max}`, range], { allowFail: true })).stdout.split('\n').filter(Boolean);
  }
}
