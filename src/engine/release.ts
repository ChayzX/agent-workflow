// Automated release handover: versioned ZIP from the exact verified release commit, with
// manifest, checksums, SBOM, test evidence, security assessment, notes, limitations and rollback.
// The package is then extracted into a clean directory and its documented install/build
// procedure is executed; any failure reopens remediation.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { json } from '../core/db.js';
import { newId, sha256, slugify } from '../core/ids.js';
import type { ProjectRow } from '../core/types.js';
import type { Workspace } from '../git/git.js';
import { gateEnv, runSandboxed } from '../security/sandbox.js';
import { isForbiddenFile, scanTree } from '../security/secrets.js';
import { collectDir, extractZip, writeZip } from '../util/zip.js';
import type { Ctx } from './ctx.js';
import { excerpt, gateEvidence } from './gates.js';
import type { Store } from './store.js';

export interface ReleaseOutcome { ok: boolean; releaseId: string; zipPath?: string; sha256?: string; problems: string[]; verificationLog: string }

export function sbomFor(dir: string): Record<string, unknown> {
  const components: Array<{ type: string; name: string; version: string; purl?: string; scope?: string }> = [];
  const lock = join(dir, 'package-lock.json');
  if (existsSync(lock)) {
    const l = json<{ packages?: Record<string, { version?: string; dev?: boolean }> }>(readFileSync(lock, 'utf8'), {});
    for (const [p, v] of Object.entries(l.packages ?? {})) {
      if (!p || !v.version) continue;
      const name = p.replace(/^.*node_modules\//, '');
      components.push({ type: 'library', name, version: v.version, purl: `pkg:npm/${name}@${v.version}`, scope: v.dev ? 'optional' : 'required' });
    }
  } else if (existsSync(join(dir, 'package.json'))) {
    const p = json<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(readFileSync(join(dir, 'package.json'), 'utf8'), {});
    for (const [n, v] of Object.entries(p.dependencies ?? {})) components.push({ type: 'library', name: n, version: v, scope: 'required' });
    for (const [n, v] of Object.entries(p.devDependencies ?? {})) components.push({ type: 'library', name: n, version: v, scope: 'optional' });
  }
  for (const f of ['requirements.txt']) {
    if (!existsSync(join(dir, f))) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const m = /^([A-Za-z0-9_.-]+)\s*==\s*([^\s;#]+)/.exec(line.trim());
      if (m) components.push({ type: 'library', name: m[1]!, version: m[2]!, purl: `pkg:pypi/${m[1]!.toLowerCase()}@${m[2]}` });
    }
  }
  return { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, metadata: { tools: [{ name: 'agent-workflow-orchestrator' }] }, components };
}

export async function buildAndVerifyRelease(ctx: Ctx, store: Store, project: ProjectRow, ws: Workspace, commit: string, version: string): Promise<ReleaseOutcome> {
  const problems: string[] = [];
  const log: string[] = [];
  const slug = slugify(json<{ product_name?: string }>(project.plan, {}).product_name ?? project.name, 30);
  const now = ctx.clock.now();
  const existing = ctx.db.get<{ id: string; status: string }>('SELECT id, status FROM releases WHERE project_id=? AND version=?', project.id, version);
  const releaseId = existing?.id ?? newId('rel');
  if (!existing) ctx.db.run("INSERT INTO releases(id, project_id, version, commit_sha, status, created_at, updated_at) VALUES (?,?,?,?, 'building', ?,?)", releaseId, project.id, version, commit, now, now);
  else ctx.db.run("UPDATE releases SET status='building', commit_sha=?, updated_at=? WHERE id=?", commit, now, releaseId);

  const work = mkdtempSync(join(tmpdir(), 'orch-release-'));
  try {
    // 1. Exact commit tree.
    const src = join(work, 'src');
    mkdirSync(src);
    const tar = join(work, 'src.tar');
    await ws.archive(commit, tar);
    execFileSync('tar', ['-xf', tar, '-C', src]);
    log.push(`archived ${commit}`);

    // 2. Exclusions and secret scan (credentials must never ship).
    const forbidden = collectDir(src, '').map((e) => e.name.slice(1)).filter(isForbiddenFile);
    if (forbidden.length) problems.push(`credential-bearing files are tracked in the repository: ${forbidden.join(', ')}`);
    const hits = scanTree(src);
    if (hits.length) problems.push(`secret scan: ${hits.slice(0, 10).map((h) => `${h.path}:${h.line} ${h.rule}`).join('; ')}`);

    // 3. Release documentation and evidence.
    const rel = join(src, 'RELEASE');
    mkdirSync(rel, { recursive: true });
    const reqs = store.requirements(project.id);
    const items = store.workItems(project.id);
    const gates = gateEvidence(ctx, project.id, commit);
    const findings = store.findings(project.id);
    const audits = ctx.db.all<{ id: string; status: string; result: string; round: number; commit_sha: string }>("SELECT * FROM audits WHERE project_id=? AND kind='completion' ORDER BY created_at", project.id);
    const blocked = reqs.filter((r) => r.mandatory && r.status === 'blocked');
    writeFileSync(join(rel, 'requirements-matrix.md'), `# Requirements to evidence\n\n| Req | Title | Status | Evidence |\n|---|---|---|---|\n${reqs.map((r) => `| ${r.key} | ${r.title.replace(/\|/g, '/')} | ${r.status} | ${json<Array<Record<string, unknown>>>(r.evidence, []).map((e) => Object.values(e).join(' ')).join('<br>').replace(/\|/g, '/').slice(0, 500)} |`).join('\n')}\n`);
    writeFileSync(join(rel, 'test-evidence.json'), JSON.stringify({ commit, gates, auditRounds: audits.map((a) => ({ id: a.id, round: a.round, status: a.status, commit: a.commit_sha })) }, null, 2));
    writeFileSync(join(rel, 'security-assessment.md'), `# Security assessment\n\nCommit: \`${commit}\`\n\n- Secret scan of release tree: ${hits.length ? `**${hits.length} hits**` : 'clean'}\n- Credential-bearing files: ${forbidden.length ? forbidden.join(', ') : 'none'}\n\n## Review findings\n\n| Severity | Status | Title |\n|---|---|---|\n${findings.map((f) => `| ${f.severity} | ${f.status} | ${f.title.replace(/\|/g, '/')} |`).join('\n') || '| – | – | none |'}\n`);
    const merged = items.filter((w) => ['merged', 'done'].includes(w.status));
    writeFileSync(join(rel, 'release-notes.md'), `# ${slug} ${version}\n\nBuilt from \`${commit}\`.\n\n## Changes\n${merged.map((w) => `- ${w.key} ${w.title}${w.github_issue_number ? ` (#${w.github_issue_number})` : ''}`).join('\n')}\n`);
    const lowOpen = findings.filter((f) => f.status === 'open');
    writeFileSync(join(rel, 'known-limitations.md'), `# Known limitations\n\n${blocked.length ? `## Blocked mandatory requirements (partial completion)\n${blocked.map((r) => `- ${r.key} ${r.title}: ${r.blocker}`).join('\n')}\n\n` : ''}## Open non-blocking findings\n${lowOpen.map((f) => `- [${f.severity}] ${f.title}`).join('\n') || '- none'}\n\n## Not implemented / cancelled\n${items.filter((w) => w.status === 'cancelled' || w.status === 'blocked').map((w) => `- ${w.key} ${w.title}: ${w.status_reason ?? w.status}`).join('\n') || '- none'}\n`);
    writeFileSync(join(rel, 'rollback.md'), `# Rollback\n\n1. Keep the previous release ZIP and its \`.sha256\` file.\n2. Stop the running service, restore the previous release directory (or check out the previous release commit), and re-run its documented install steps.\n3. If database migrations were applied, run the down-migrations documented by the project before restoring, or restore the pre-upgrade backup.\n4. Verify with the project's health check / test commands: ${store.settings(project).verify_commands.map((c) => `\`${c}\``).join(', ') || '(none declared)'}.\n`);
    writeFileSync(join(rel, 'sbom.cdx.json'), JSON.stringify(sbomFor(src), null, 2));
    const adrDir = join(rel, 'adr');
    mkdirSync(adrDir, { recursive: true });
    for (const d of store.decisions(project.id).filter((x) => x.status === 'decided')) {
      const ck = ctx.db.get<{ data: string }>("SELECT data FROM checkpoints WHERE project_id=? AND kind='decision' AND summary LIKE ? ORDER BY created_at DESC LIMIT 1", project.id, `${d.key} %`);
      writeFileSync(join(adrDir, `${d.key}.md`), json<{ adr?: string }>(ck?.data, {}).adr || `# ${d.key}: ${d.title}\n\n${d.outcome}\n\n${d.rationale}\n`);
    }
    writeFileSync(join(rel, 'goal.md'), `# Original goal (immutable baseline, sha256 ${project.goal_sha256})\n\n${project.goal_text}\n`);

    // 4. Manifest with per-file checksums, then the ZIP.
    const prefix = `${slug}-${version}`;
    const entries = collectDir(src, prefix);
    const manifest = {
      name: slug, version, commit, built_at: new Date(now).toISOString(),
      completion: blocked.length ? 'partial_blocked' : 'verified',
      verify_commands: store.settings(project).verify_commands,
      files: entries.map((e) => ({ path: e.name.slice(prefix.length + 1), sha256: sha256(e.data), bytes: e.data.length })),
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
    entries.push({ name: `${prefix}/RELEASE/manifest.json`, data: manifestBuf });
    const outDir = join(ctx.paths.releases, project.id);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const zipPath = join(outDir, `${prefix}.zip`);
    writeZip(zipPath, entries);
    const digest = sha256(readFileSync(zipPath));
    writeFileSync(`${zipPath}.sha256`, `${digest}  ${prefix}.zip\n`);
    log.push(`zip ${zipPath} sha256=${digest} entries=${entries.length}`);

    // 5. Clean-environment verification: extract, verify checksums, re-scan, run documented procedure.
    const clean = join(work, 'clean');
    mkdirSync(clean);
    extractZip(zipPath, clean);
    const root = join(clean, prefix);
    const m2 = json<typeof manifest>(readFileSync(join(root, 'RELEASE', 'manifest.json'), 'utf8'), manifest);
    const badSums = m2.files.filter((f) => {
      const fp = join(root, f.path);
      const content = lstatSync(fp).isSymbolicLink() ? Buffer.from(readlinkSync(fp)) : readFileSync(fp);
      return sha256(content) !== f.sha256;
    });
    if (badSums.length) problems.push(`checksum mismatch after extraction: ${badSums.map((f) => f.path).join(', ')}`);
    const reHits = scanTree(root);
    if (reHits.length) problems.push(`secret scan of extracted package failed (${reHits.length} hits)`);
    const home = join(work, 'home');
    mkdirSync(home);
    for (const cmd of m2.verify_commands) {
      const r = await runSandboxed(ctx.cfg, { cwd: root, writable: [root, home], hide: [ctx.paths.home], network: true }, cmd,
        { ...gateEnv({ ...ctx.cfg, security: { ...ctx.cfg.security, gateNetwork: true } }, home) }, 30 * 60_000);
      log.push(`$ ${cmd} → exit ${r.exitCode}${r.timedOut ? ' (timeout)' : ''}\n${excerpt(r.stdout + r.stderr, 3000)}`);
      if (r.exitCode !== 0) { problems.push(`clean-environment verification failed: \`${cmd}\` exited ${r.exitCode}`); break; }
    }
    if (!m2.verify_commands.length) problems.push('no verification commands declared; installation reproducibility cannot be verified');

    const ok = problems.length === 0;
    const vlog = log.join('\n\n');
    ctx.db.run('UPDATE releases SET status=?, zip_path=?, sha256=?, manifest=?, verification_log=?, updated_at=? WHERE id=?',
      ok ? 'verified' : 'failed', zipPath, digest, JSON.stringify({ ...manifest, files: manifest.files.length }), (vlog + (problems.length ? `\n\nPROBLEMS:\n${problems.join('\n')}` : '')).slice(0, 100_000), ctx.clock.now(), releaseId);
    ctx.events.emit('release.' + (ok ? 'verified' : 'failed'), `${prefix}: ${ok ? `verified (${digest.slice(0, 12)})` : problems.join('; ')}`, { projectId: project.id, level: ok ? 'info' : 'warn' });
    ctx.events.audit('supervisor', 'release.built', { projectId: project.id, target: releaseId, detail: { version, commit, sha256: digest, ok } });
    return { ok, releaseId, zipPath, sha256: digest, problems, verificationLog: vlog };
  } catch (e) {
    problems.push(`release build error: ${(e as Error).message}`);
    ctx.db.run("UPDATE releases SET status='failed', verification_log=?, updated_at=? WHERE id=?", problems.join('\n'), ctx.clock.now(), releaseId);
    return { ok: false, releaseId, problems, verificationLog: log.join('\n') };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Copy a verified release to an operator-chosen location. */
export function exportRelease(zipPath: string, dest: string): string {
  mkdirSync(dest, { recursive: true });
  const out = join(dest, zipPath.split('/').pop()!);
  copyFileSync(zipPath, out);
  if (existsSync(`${zipPath}.sha256`)) copyFileSync(`${zipPath}.sha256`, `${out}.sha256`);
  return out;
}
