// Child process runner: JSONL streaming, bounded buffers, timeouts, cancellation and
// process-group termination (so tool subprocesses spawned by agents die too).
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { redact } from '../core/redact.js';

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  stdin?: string | Readable;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  onSpawn?: (pid: number) => void;
  maxCaptureBytes?: number;
  transcriptPath?: string;
  killGraceMs?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  durationMs: number;
}

export function killTree(pid: number, sig: NodeJS.Signals = 'SIGTERM'): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try { process.kill(pid, sig); } catch { /* already gone */ }
  }
}

export function runProcess(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const cap = opts.maxCaptureBytes ?? 4 * 1024 * 1024;
  return new Promise((resolvePromise) => {
    let transcript: WriteStream | null = null;
    if (opts.transcriptPath) {
      mkdirSync(dirname(opts.transcriptPath), { recursive: true, mode: 0o700 });
      transcript = createWriteStream(opts.transcriptPath, { flags: 'a', mode: 0o600 });
    }
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolvePromise({ exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: String(e), durationMs: 0 });
      return;
    }
    const finish = (r: Omit<RunResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (lineBuf.trim()) opts.onLine?.(lineBuf);
      transcript?.end();
      resolvePromise({ ...r, durationMs: Date.now() - started });
    };
    const terminate = () => {
      if (child.pid) {
        killTree(child.pid, 'SIGTERM');
        setTimeout(() => child.pid && killTree(child.pid, 'SIGKILL'), opts.killGraceMs ?? 5000).unref();
      }
    };
    const onAbort = () => { aborted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, opts.timeoutMs ?? 3600_000);
    timer.unref();
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('spawn', () => { if (child.pid) opts.onSpawn?.(child.pid); });
    child.on('error', (e) => finish({ exitCode: null, signal: null, stdout, stderr, timedOut, aborted, spawnError: e.message }));
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      if (stdout.length < cap) stdout += d;
      transcript?.write(redact(d));
      if (opts.onLine) {
        lineBuf += d;
        let i: number;
        while ((i = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, i);
          lineBuf = lineBuf.slice(i + 1);
          if (line.trim()) {
            try { opts.onLine(line); } catch { /* consumer errors must not kill the run */ }
          }
        }
      }
    });
    child.stderr!.on('data', (d: string) => { if (stderr.length < cap) stderr += d; });
    child.on('close', (code, sig) => finish({ exitCode: code, signal: sig, stdout, stderr, timedOut, aborted }));
    child.stdin!.on('error', () => { /* child may exit before reading stdin */ });
    if (typeof opts.stdin === 'object') {
      const input = opts.stdin;
      child.on('close', () => input.destroy());
      input.on('error', (err) => child.stdin!.destroy(err));
      input.pipe(child.stdin!);
    } else {
      child.stdin!.end(opts.stdin ?? '');
    }
  });
}

/** Run a short command and return trimmed stdout (for detection / auth checks). */
export async function runQuick(cmd: string, args: string[], env: Record<string, string>, cwd = process.cwd(), timeoutMs = 20_000): Promise<RunResult> {
  return runProcess(cmd, args, { cwd, env, timeoutMs, maxCaptureBytes: 256 * 1024 });
}
