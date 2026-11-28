// Deterministic quality gates. Results come only from actual command exit codes and captured
// output; nothing an agent writes can turn a failed gate into a pass. Gate commands are
// treated as untrusted (they come from the plan/repository) and run sandboxed without credentials.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../core/ids.js';
import { redact } from '../core/redact.js';
import type { QualityGate } from '../core/types.js';
import { gateEnv, runSandboxed } from '../security/sandbox.js';
import { scanTree } from '../security/secrets.js';
import type { Ctx } from './ctx.js';
import { assertGatesRunnable, gateBackendKind, GateBackendUnavailableError, gatesRanOk, holdGates } from './gate-backend.js';
import { prepareVmSource, runVmCommand } from '../vm/devvm.js';

export interface GateResult { name: string; required: boolean; status: 'pass' | 'fail' | 'error'; exitCode: number | null; durationMs: number; excerpt: string; logPath: string; sandbox: string }
export interface GateSummary { passed: boolean; results: GateResult[]; commit: string }

export const BUILTIN_SECRET_GATE = 'secret-scan';

/** Keep the tail of output (where failures usually are) plus the head for context. */
export function excerpt(out: string, max: number): string {
  const clean = redact(out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
  if (clean.length <= max) return clean;
  const head = clean.slice(0, Math.floor(max * 0.25));
  return `${head}\n[... ${clean.length - max} chars omitted ...]\n${clean.slice(-Math.floor(max * 0.75))}`;
}

export async function runGates(ctx: Ctx, opts: { projectId: string; workItemId: string | null; scope: string; cwd: string; commit: string; gates: QualityGate[]; gitDir?: string }): Promise<GateSummary> {
  const results: GateResult[] = [];
  const logDir = join(ctx.paths.gateLogs, opts.projectId, opts.commit.slice(0, 12));
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const home = join(ctx.paths.home, 'gate-home', opts.projectId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Throws (nothing recorded) when the configured backend cannot run gates now; callers retry later.
  assertGatesRunnable(ctx);
  const vm = gateBackendKind(ctx.cfg) === 'devvm';
  // Never export credentials to a VM: the exact archive is built once and scanned exhaustively before any export.
  const prepared = vm ? await prepareVmSource({ kind: 'git', cwd: opts.cwd, gitDir: opts.gitDir, commit: opts.commit }) : null;
  const blockExport = !!prepared?.hits.length;
  try {

  for (const g of opts.gates) {
    const started = ctx.clock.now();
    const timeoutMs = (g.timeout_sec ?? 900) * 1000;
    const r = prepared ? await runVmCommand(ctx.cfg.vm.command!, prepared, g.command, ctx.cfg.security.gateNetwork, timeoutMs, ctx.cfg.vm.gate)
      : await runSandboxed(
      ctx.cfg,
      { cwd: opts.cwd, writable: [opts.cwd, home], readOnly: opts.gitDir ? [opts.gitDir] : [], hide: [ctx.paths.home], network: ctx.cfg.security.gateNetwork, readOnlyLast: [join(opts.cwd, '.git')] },
      g.command,
      gateEnv(ctx.cfg, home),
      timeoutMs,
    );
    if (vm && 'unavailable' in r && r.unavailable) {
      // The VM never ran (or lost) the command: this is not a gate result. Wait and retry; never run it here.
      const reason = `${g.name}: ${(r.spawnError ?? r.stderr).trim().split('\n').filter((l) => /devvm|ssh|unavailable/i.test(l)).slice(-2).join(' ') || `devvm exited ${r.exitCode}`}`;
      holdGates(ctx, reason);
      throw new GateBackendUnavailableError(reason);
    }
    const out = `$ ${g.command}\n${r.stdout}\n${r.stderr}${r.timedOut ? '\n[timed out]' : ''}${r.spawnError ? `\n[spawn error] ${r.spawnError}` : ''}`;
    const logPath = join(logDir, `${g.name.replace(/[^a-z0-9_.-]/gi, '_')}.log`);
    writeFileSync(logPath, redact(out), { mode: 0o600 });
    const status: GateResult['status'] = r.spawnError || r.timedOut ? 'error' : r.exitCode === 0 ? 'pass' : 'fail';
    results.push({ name: g.name, required: g.required, status, exitCode: r.exitCode, durationMs: r.durationMs, excerpt: excerpt(out, ctx.cfg.limits.maxOutputExcerpt), logPath, sandbox: r.sandbox });
    ctx.db.run(
      `INSERT INTO gate_runs(id, project_id, work_item_id, scope, commit_sha, name, command, required, status, exit_code, duration_ms, output_excerpt, log_path, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId('gate'), opts.projectId, opts.workItemId, opts.scope, opts.commit, g.name, g.command, g.required ? 1 : 0, status, r.exitCode, r.durationMs,
      results.at(-1)!.excerpt, logPath, started,
    );
  }
  } finally { prepared?.dispose(); }

  // Built-in, always-required secret scan of the tree (with the VM backend: of exactly what was exported).
  const t0 = Date.now();
  const hits = prepared ? prepared.hits : scanTree(opts.cwd);
  const secretOut = hits.length ? hits.map((h) => `${h.path}:${h.line} ${h.rule} ${h.excerpt}`).join('\n') : 'no secrets detected';
  const secretLog = join(logDir, `${BUILTIN_SECRET_GATE}.log`);
  writeFileSync(secretLog, secretOut, { mode: 0o600 });
  results.push({ name: BUILTIN_SECRET_GATE, required: true, status: hits.length ? 'fail' : 'pass', exitCode: hits.length ? 1 : 0, durationMs: Date.now() - t0, excerpt: secretOut.slice(0, 2000), logPath: secretLog, sandbox: 'builtin' });
  ctx.db.run(
    `INSERT INTO gate_runs(id, project_id, work_item_id, scope, commit_sha, name, command, required, status, exit_code, duration_ms, output_excerpt, log_path, started_at)
     VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
    newId('gate'), opts.projectId, opts.workItemId, opts.scope, opts.commit, BUILTIN_SECRET_GATE, 'builtin:secret-scan', hits.length ? 'fail' : 'pass', hits.length ? 1 : 0,
    Date.now() - t0, secretOut.slice(0, 2000), secretLog, ctx.clock.now(),
  );

  if (vm && !blockExport) gatesRanOk(ctx);
  const passed = results.every((r) => !r.required || r.status === 'pass');
  ctx.events.emit('gates.completed', `${opts.scope} gates on ${opts.commit.slice(0, 8)}: ${passed ? 'PASS' : 'FAIL'} (${results.map((r) => `${r.name}=${r.status}`).join(', ')})`, { projectId: opts.projectId, level: passed ? 'info' : 'warn' });
  return { passed, results, commit: opts.commit };
}

/** Latest recorded results for a commit (evidence for audits and release). */
export function gateEvidence(ctx: Ctx, projectId: string, commit: string): Array<{ name: string; status: string; required: number; exit_code: number | null; command: string }> {
  return ctx.db.all(
    `SELECT g.name, g.status, g.required, g.exit_code, g.command FROM gate_runs g
     WHERE g.project_id=? AND g.commit_sha=? AND g.started_at = (SELECT MAX(started_at) FROM gate_runs x WHERE x.project_id=g.project_id AND x.commit_sha=g.commit_sha AND x.name=g.name)
     ORDER BY g.name`,
    projectId, commit,
  );
}

export function failedGateText(s: GateSummary): string {
  return s.results.filter((r) => r.status !== 'pass' && r.required).map((r) => `### Gate "${r.name}" ${r.status} (exit ${r.exitCode})\n\`\`\`\n${r.excerpt}\n\`\`\``).join('\n\n');
}
