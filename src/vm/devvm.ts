// Client for the trusted `devvm` executable (deploy/devvm/) that runs work in throwaway Debian VMs on the
// gaming PC. The control plane (Chasebot) only ships sources in and results out; commands never run here.
import { accessSync, constants, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { git } from '../git/git.js';
import { runProcess, type RunResult } from '../providers/process.js';
import { scanTree, type SecretHit } from '../security/secrets.js';

/** `devvm` exit status for "the VM backend could not run the command" (asleep, paused, no capacity, lost SSH). */
export const EX_UNAVAILABLE = 75;
/** Exit status ssh uses for a lost or refused connection. */
export const EX_SSH = 255;
/** Wake (up to 3 min), provisioning (up to ~8 min), first boot/cloud-init (up to 7 min) and teardown, on top of a command's timeout. */
export const VM_LIFECYCLE_ALLOWANCE_MS = 20 * 60_000;
/** Time devvm gets after SIGTERM to destroy its lease before it is killed. */
export const DEVVM_KILL_GRACE_MS = 120_000;

export class VmUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'VmUnavailableError'; }
}

function dirProblem(p: string, uid: number): string | null {
  const s = statSync(p);
  if (!s.isDirectory()) return `${p} is not a directory`;
  if (s.uid !== 0 && s.uid !== uid) return `${p} is owned by uid ${s.uid}, not root or the service user`;
  if ((s.mode & 0o022) && !((s.mode & 0o1000) && s.uid === 0)) return `${p} is writable by group or others`;
  return null;
}

/**
 * Walk `path` one component at a time, following every symlink met on the way. Each directory traversed — in
 * particular every directory that holds a symlink — must be owned by root or us and not writable by others
 * (a root-owned sticky directory is fine), so nobody else can swap any link or file on the way.
 */
function pathProblem(path: string, uid: number, depth = 0): string | null {
  if (depth > 40) return `${path}: too many symbolic links`;
  const parts = path.split('/').filter(Boolean);
  let cur = '/';
  const top = dirProblem('/', uid);
  if (top) return top;
  for (let i = 0; i < parts.length; i++) {
    const next = join(cur, parts[i]!);
    let st;
    try { st = lstatSync(next); } catch { return `${next} does not exist`; }
    if (st.isSymbolicLink()) {
      const target = resolve(cur, readlinkSync(next));
      return pathProblem(join(target, ...parts.slice(i + 1)), uid, depth + 1);
    }
    if (i < parts.length - 1) {
      const d = dirProblem(next, uid);
      if (d) return d;
      cur = next;
    }
  }
  return null;
}

/**
 * The executable is trusted with every lease, so nobody but its owner may be able to replace it: an absolute path
 * to a regular, executable file owned by root or the service user, where no directory on either the configured
 * path or its resolved path is writable by others (so no symlink on the way can be swapped). Returns the problem,
 * or null. Callers spawn `resolveDevVm()`, the verified real path, never the configured one.
 */
export function checkDevVmExecutable(path: string | null | undefined): string | null {
  if (!path) return 'vm.command is not set';
  if (!isAbsolute(path)) return `vm.command must be an absolute path (got ${path})`;
  let real: string;
  try { real = realpathSync(path); } catch { return `vm.command ${path} does not exist`; }
  const uid = process.getuid?.() ?? -1;
  const st = statSync(real);
  if (!st.isFile()) return `vm.command ${real} is not a regular file`;
  if (st.uid !== 0 && st.uid !== uid) return `${real} is owned by uid ${st.uid}, not root or the service user`;
  if (st.mode & 0o022) return `${real} is writable by group or others`;
  try { accessSync(real, constants.X_OK); } catch { return `vm.command ${real} is not executable`; }
  return pathProblem(path, uid);
}

export function resolveDevVm(path: string): string {
  return realpathSync(path);
}

export interface DevVmResult extends RunResult { unavailable: boolean }

/** Minimal environment for devvm: it needs HOME (its key and lease store) and PATH (ssh). Nothing else. */
export function devvmEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { HOME: source.HOME ?? homedir(), PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
  if (source.DEVVM_HOME) env.DEVVM_HOME = source.DEVVM_HOME;
  return env;
}

export async function devvm(executable: string, args: string[], opts: { stdin?: string | Readable; timeoutMs: number; cwd?: string; signal?: AbortSignal; onLine?: (l: string) => void; onSpawn?: (pid: number) => void; maxCaptureBytes?: number }): Promise<DevVmResult> {
  const problem = checkDevVmExecutable(executable);
  if (problem) return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: problem, durationMs: 0, unavailable: true };
  const r = await runProcess(resolveDevVm(executable), args, { cwd: opts.cwd ?? tmpdir(), env: devvmEnv(), stdin: opts.stdin, timeoutMs: opts.timeoutMs, signal: opts.signal, onLine: opts.onLine, onSpawn: opts.onSpawn, maxCaptureBytes: opts.maxCaptureBytes ?? 2 * 1024 * 1024, killGraceMs: DEVVM_KILL_GRACE_MS });
  const unavailable = !!r.spawnError || r.exitCode === EX_UNAVAILABLE || r.exitCode === EX_SSH;
  return { ...r, unavailable };
}

export type GateSource = { kind: 'git'; cwd: string; gitDir?: string; commit: string } | { kind: 'dir'; dir: string };

/** An archive ready to send to VMs, scanned exactly as it will be exported. Call dispose() when done. */
export interface PreparedSource { archive: string; hits: SecretHit[]; dispose: () => void }

export async function prepareVmSource(source: GateSource): Promise<PreparedSource> {
  const tmp = mkdtempSync(join(tmpdir(), 'orch-devvm-'));
  const dispose = () => rmSync(tmp, { recursive: true, force: true });
  try {
    const archive = join(tmp, 'source.tar');
    if (source.kind === 'git') {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit)) throw new Error('expected a full commit hash for a VM gate');
      await git(source.cwd, [...(source.gitDir ? [`--git-dir=${source.gitDir}`] : []), 'archive', '--format=tar', `--output=${archive}`, source.commit], { timeoutMs: 120_000 });
    } else {
      execFileSync('tar', ['-cf', archive, '-C', source.dir, '.'], { stdio: 'ignore', timeout: 120_000 });
    }
    // Scan what leaves this host, byte for byte: every directory (dist/, node_modules/ ...), binaries and large files.
    const view = join(tmp, 'view');
    mkdirSync(view);
    execFileSync('tar', ['-xf', archive, '-C', view, '--no-same-owner', '--no-same-permissions'], { stdio: 'ignore', timeout: 120_000 });
    const hits = scanTree(view, { includeDeps: true, exhaustive: true });
    rmSync(view, { recursive: true, force: true });
    return { archive, hits, dispose };
  } catch (e) { dispose(); throw e; }
}

/**
 * Run one untrusted command in a fresh VM with only the prepared archive as its working tree. The command's exit
 * status comes back through a status file, so a command that itself exits 75 or 255 is a result, not an outage.
 */
export async function runVmCommand(executable: string, prepared: PreparedSource, command: string, network: boolean, timeoutMs: number, size?: { cpus?: number; ramMib?: number; diskGib?: number }): Promise<DevVmResult & { sandbox: string }> {
  const sandbox = 'devvm';
  if (prepared.hits.length) {
    return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 0, sandbox, unavailable: false,
      spawnError: `Built-in secret scan found credentials (${prepared.hits.slice(0, 5).map((h) => `${h.path}:${h.line} ${h.rule}`).join('; ')}). Nothing was exported to the VM.` };
  }
  const statusDir = mkdtempSync(join(tmpdir(), 'orch-devvm-status-'));
  try {
    const statusFile = join(statusDir, 'status');
    const budgetMs = timeoutMs + VM_LIFECYCLE_ALLOWANCE_MS;
    const args = ['gate', '--status-file', statusFile, '--ttl-minutes', String(Math.max(5, Math.min(480, Math.ceil(budgetMs / 60_000) + 2)))];
    if (size?.cpus) args.push('--cpus', String(size.cpus));
    if (size?.ramMib) args.push('--ram-mib', String(size.ramMib));
    if (size?.diskGib) args.push('--disk-gib', String(size.diskGib));
    if (network) args.push('--network');
    args.push('--', command);
    const r = await devvm(executable, args, { stdin: createReadStream(prepared.archive), timeoutMs: budgetMs });
    if (existsSync(statusFile)) {
      const status = readFileSync(statusFile, 'utf8').trim();
      const setup = /^setup:(\d+)$/.exec(status);
      // The guest could not unpack or prepare the source (e.g. the disk is too small): a gate error, not an outage.
      if (setup) return { ...r, exitCode: null, unavailable: false, sandbox, spawnError: `the VM could not prepare the source for this command (setup step exited ${setup[1]}; is vm.gate.diskGib large enough?)` };
      if (/^\d+$/.test(status)) return { ...r, exitCode: Number(status), unavailable: false, sandbox };
    }
    // No status: the command never ran to completion in a VM (outage), unless we timed out waiting for it.
    return { ...r, unavailable: !r.timedOut && !r.aborted, sandbox };
  } finally { rmSync(statusDir, { recursive: true, force: true }); }
}

/** The installed devvm must support the out-of-band status (an older copy would make every gate wait forever). */
export async function devvmSupportsStatusFile(executable: string): Promise<boolean> {
  const r = await devvm(executable, ['gate', '--help'], { timeoutMs: 20_000 });
  return r.exitCode === 0 && r.stdout.includes('--status-file');
}
