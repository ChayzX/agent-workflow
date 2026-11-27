// Structured, redacted JSON-lines logging with size-based rotation.
import { appendFileSync, mkdirSync, renameSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { redact, redactValue } from './redact.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private file: string | null;
  constructor(
    private dir: string | null,
    private level: Level = 'info',
    private maxBytes = 10 * 1024 * 1024,
    private keep = 5,
    private echo = false,
  ) {
    this.file = dir ? join(dir, 'orchestrator.log') : null;
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  child(fields: Record<string, unknown>): ChildLogger {
    return new ChildLogger(this, fields);
  }

  log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: redact(msg), ...redactValue(fields) });
    if (this.echo || !this.file) process.stderr.write(line + '\n');
    if (!this.file) return;
    try {
      this.rotateIfNeeded();
      appendFileSync(this.file, line + '\n', { mode: 0o600 });
    } catch {
      /* logging must never crash the supervisor */
    }
  }

  private rotateIfNeeded(): void {
    if (!this.file || !existsSync(this.file)) return;
    if (statSync(this.file).size < this.maxBytes) return;
    const oldest = `${this.file}.${this.keep}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = this.keep - 1; i >= 1; i--) {
      const f = `${this.file}.${i}`;
      if (existsSync(f)) renameSync(f, `${this.file}.${i + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
  }

  path(): string | null {
    return this.file;
  }
  debug(m: string, f?: Record<string, unknown>) { this.log('debug', m, f); }
  info(m: string, f?: Record<string, unknown>) { this.log('info', m, f); }
  warn(m: string, f?: Record<string, unknown>) { this.log('warn', m, f); }
  error(m: string, f?: Record<string, unknown>) { this.log('error', m, f); }
}

export class ChildLogger {
  constructor(private parent: Logger, private fields: Record<string, unknown>) {}
  debug(m: string, f: Record<string, unknown> = {}) { this.parent.log('debug', m, { ...this.fields, ...f }); }
  info(m: string, f: Record<string, unknown> = {}) { this.parent.log('info', m, { ...this.fields, ...f }); }
  warn(m: string, f: Record<string, unknown> = {}) { this.parent.log('warn', m, { ...this.fields, ...f }); }
  error(m: string, f: Record<string, unknown> = {}) { this.parent.log('error', m, { ...this.fields, ...f }); }
}

export const nullLogger = new Logger(null, 'error');
