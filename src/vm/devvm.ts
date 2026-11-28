// Client for the trusted `devvm` executable (deploy/devvm/) that runs work in throwaway Debian VMs on the
// gaming PC. The control plane (Chasebot) only ships sources in and results out; commands never run here.
import { accessSync, constants, createReadStream, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { git } from '../git/git.js';
import { runProcess, type RunResult } from '../providers/process.js';

/** `devvm` exit status for "the VM backend could not run the command" (asleep, paused, no capacity, lost SSH). */
export const EX_UNAVAILABLE = 75;
/** Exit status ssh uses for a lost or refused connection. */
export const EX_SSH = 255;
/** Provisioning, first boot (minutes under the Windows Hypervisor Platform) and teardown, on top of a command's timeout. */
export const VM_LIFECYCLE_ALLOWANCE_MS = 12 * 60_000;

export class VmUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'VmUnavailableError'; }
}

/**
 * The executable is trusted with every lease, so it must not be replaceable by anyone but its owner: an absolute
 * path to a regular, executable file owned by root or the service user, and no group/world-writable file or parent.
 * Returns the problem, or null when it can be trusted.
 */
export function checkDevVmExecutable(path: string | null | undefined): string | null {
  if (!path) return 'vm.command is not set';
  if (!isAbsolute(path)) return `vm.command must be an absolute path (got ${path})`;
  let real: string;
  try { real = realpathSync(path); } catch { return `vm.command ${path} does not exist`; }
  const uid = process.getuid?.() ?? -1;
  const st = statSync(real);
  if (!st.isFile()) return `vm.command ${real} is not a regular file`;
  try { accessSync(real, constants.X_OK); } catch { return `vm.command ${real} is not executable`; }
  for (let p = real; ; p = dirname(p)) {
    const s = lstatSync(p);
    if (s.uid !== 0 && s.uid !== uid) return `${p} is owned by uid ${s.uid}, not root or the service user`;
    // A group/world-writable parent is acceptable only as a root-owned sticky directory (others cannot replace our file).
    if ((s.mode & 0o022) && !(s.isDirectory() && (s.mode & 0o1000) && s.uid === 0)) return `${p} is writable by group or others`;
    if (p === '/' || dirname(p) === p) break;
  }
  return null;
}

export interface DevVmResult extends RunResult { unavailable: boolean }

/** Minimal environment for devvm: it needs HOME (its key and lease store) and PATH (ssh). Nothing else. */
export function devvmEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { HOME: source.HOME ?? homedir(), PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
  if (source.DEVVM_HOME) env.DEVVM_HOME = source.DEVVM_HOME;
  return env;
}

export async function devvm(executable: string, args: string[], opts: { stdin?: string | Readable; timeoutMs: number; cwd?: string; signal?: AbortSignal; onLine?: (l: string) => void; onSpawn?: (pid: number) => void; maxCaptureBytes?: number }): Promise<DevVmResult> {
  const r = await runProcess(executable, args, { cwd: opts.cwd ?? tmpdir(), env: devvmEnv(), stdin: opts.stdin, timeoutMs: opts.timeoutMs, signal: opts.signal, onLine: opts.onLine, onSpawn: opts.onSpawn, maxCaptureBytes: opts.maxCaptureBytes ?? 2 * 1024 * 1024 });
  const unavailable = !!r.spawnError || r.exitCode === EX_UNAVAILABLE || r.exitCode === EX_SSH;
  return { ...r, unavailable };
}

export type GateSource = { kind: 'git'; cwd: string; gitDir?: string; commit: string } | { kind: 'dir'; dir: string };

/** Run one untrusted command in a fresh VM with only `source` (a git commit or a directory) as its working tree. */
export async function runVmCommand(executable: string, source: GateSource, command: string, network: boolean, timeoutMs: number, size?: { cpus?: number; ramMib?: number; diskGib?: number }): Promise<DevVmResult & { sandbox: string }> {
  const started = Date.now();
  const sandbox = 'devvm';
  const problem = checkDevVmExecutable(executable);
  if (problem) return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: problem, durationMs: 0, sandbox, unavailable: true };
  let temporary: string | undefined;
  try {
    temporary = mkdtempSync(join(tmpdir(), 'orch-devvm-'));
    const archive = join(temporary, 'source.tar');
    if (source.kind === 'git') {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit)) throw new Error('expected a full commit hash for a VM gate');
      await git(source.cwd, [...(source.gitDir ? [`--git-dir=${source.gitDir}`] : []), 'archive', '--format=tar', `--output=${archive}`, source.commit], { timeoutMs: 60_000 });
    } else {
      execFileSync('tar', ['-cf', archive, '-C', source.dir, '.'], { stdio: 'ignore', timeout: 120_000 });
    }
    const budgetMs = timeoutMs + VM_LIFECYCLE_ALLOWANCE_MS;
    const args = ['gate', '--ttl-minutes', String(Math.max(5, Math.min(480, Math.ceil(budgetMs / 60_000) + 2)))];
    if (size?.cpus) args.push('--cpus', String(size.cpus));
    if (size?.ramMib) args.push('--ram-mib', String(size.ramMib));
    if (size?.diskGib) args.push('--disk-gib', String(size.diskGib));
    if (network) args.push('--network');
    args.push('--', command);
    const r = await devvm(executable, args, { stdin: createReadStream(archive), timeoutMs: budgetMs });
    return { ...r, sandbox };
  } catch (error) {
    // A local failure to build the archive is not a VM outage: record it as a gate error.
    return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: String(error), durationMs: Date.now() - started, sandbox, unavailable: false };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
