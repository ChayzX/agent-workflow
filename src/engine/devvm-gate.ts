import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runProcess, type RunResult } from '../providers/process.js';
import { git } from '../git/git.js';

export const VM_LIFECYCLE_ALLOWANCE_MS = 12 * 60_000;

export async function runDevVmGate(
  executable: string, cwd: string, gitDir: string | undefined, commit: string, command: string, network: boolean, timeoutMs: number,
): Promise<RunResult & { sandbox: string }> {
  const started = Date.now();
  const sandbox = 'debian-devvm';
  let temporary: string | undefined;
  try {
    if (!isAbsolute(executable)) throw new Error('security.devVmGateCommand must be an absolute path');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Expected a full gate commit hash');
    temporary = mkdtempSync(join(tmpdir(), 'orch-devvm-'));
    const archive = join(temporary, 'source.tar');
    const gitPath = gitDir ? [`--git-dir=${gitDir}`] : [];
    await git(cwd, [...gitPath, 'archive', '--format=tar', `--output=${archive}`, commit], { timeoutMs: 30_000 });
    // The gate's timeout covers the command; VM provisioning, first boot (minutes under the
    // Hyper-V/NEM backend) and teardown get a fixed allowance on top of it.
    const budgetMs = timeoutMs + VM_LIFECYCLE_ALLOWANCE_MS;
    const args = ['gate', '--ttl-minutes', String(Math.max(5, Math.min(480, Math.ceil(budgetMs / 60_000) + 2)))];
    if (network) args.push('--network');
    args.push('--', command);
    const env = { HOME: homedir(), PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
    const result = await runProcess(executable, args, {
      cwd, env, stdin: createReadStream(archive), timeoutMs: budgetMs, maxCaptureBytes: 2 * 1024 * 1024,
    });
    return { ...result, sandbox };
  } catch (error) {
    return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false,
      spawnError: String(error), durationMs: Date.now() - started, sandbox };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
