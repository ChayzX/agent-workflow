// Secret scanning for diffs, trees and release packages (deterministic, no network).
import { readdirSync, readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface SecretHit { path: string; line: number; rule: string; excerpt: string }

const RULES: Array<[string, RegExp]> = [
  ['github-token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['anthropic-key', /\bsk-ant-(?:api|admin|oat|ort)\d{2}-[A-Za-z0-9_-]{30,}/],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/],
  ['aws-access-key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[baprs]-[0-9A-Za-z-]{20,}/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['generic-assigned-secret', /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|id[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9+/_.\-]{16,}["']/i],
];

const FORBIDDEN_FILES = [/(^|\/)\.env$/, /(^|\/)\.env\.(?!example$|template$|sample$)[^/]+$/, /\.pem$/, /(^|\/)id_(rsa|ed25519|ecdsa)$/, /\.p12$/, /\.pfx$/, /(^|\/)auth\.json$/, /(^|\/)\.npmrc$/, /(^|\/)credentials(\.json)?$/];
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next', 'target']);
const ALLOW_MARKER = /orchestrator:allow-secret|EXAMPLE|example|placeholder|dummy|fake|xxxxxxxx|<redacted>/i;

export function isForbiddenFile(rel: string): boolean {
  return FORBIDDEN_FILES.some((re) => re.test(rel));
}

/** `longLines`: scan lines over 4000 characters in overlapping windows instead of skipping them (exports). */
export function scanText(path: string, text: string, opts: { longLines?: boolean } = {}): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    let pieces = [line];
    if (line.length > 4000) {
      if (!opts.longLines) return;
      pieces = [];
      for (let at = 0; at < line.length; at += 3800) pieces.push(line.slice(at, at + 4000)); // 200-char overlap
    }
    for (const piece of pieces) {
      for (const [rule, re] of RULES) {
        const m = re.exec(piece);
        if (!m) continue;
        // Export scans (longLines) honour an allow marker only right next to the match, not anywhere in a long line.
        // For a piece of a very long line, an allow marker counts only right next to the match (anything can appear
        // somewhere in a minified bundle); ordinary lines keep whole-line marker semantics.
        const long = line.length > 4000;
        const context = long ? piece.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40) : piece;
        if (!ALLOW_MARKER.test(context)) hits.push({ path, line: i + 1, rule, excerpt: context.trim().slice(0, 80).replace(/[A-Za-z0-9+/_-]{12,}/g, (x) => x.slice(0, 4) + '…') });
      }
      if (hits.some((h) => h.line === i + 1 && h.path === path)) break;
    }
  });
  return hits;
}

/** `exhaustive`: scan large and binary files too (used for anything exported off this host); unreadably large files are hits. */
export function scanTree(root: string, opts: { includeDeps?: boolean; exhaustive?: boolean } = {}): SecretHit[] {
  const hits: SecretHit[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (!opts.includeDeps && SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      const rel = relative(root, p);
      if (st.isSymbolicLink()) {
        const t = resolve(dirname(p), readlinkSync(p));
        if (!t.startsWith(resolve(root) + sep)) hits.push({ path: rel, line: 0, rule: 'symlink-escape', excerpt: 'symbolic link points outside the tree' });
        continue;
      }
      if (st.isDirectory()) { walk(p); continue; }
      if (isForbiddenFile(rel)) { hits.push({ path: rel, line: 0, rule: 'forbidden-file', excerpt: 'credential-bearing file type' }); continue; }
      if (opts.exhaustive) {
        if (st.size > 512 * 1024 * 1024) { hits.push({ path: rel, line: 0, rule: 'unscannable-size', excerpt: 'file too large to scan before export' }); continue; }
        const buf = readFileSync(p);
        hits.push(...scanText(rel, buf.includes(0) ? buf.toString('latin1') : buf.toString('utf8'), { longLines: true }));
        continue;
      }
      if (st.size > 2 * 1024 * 1024) continue;
      const buf = readFileSync(p);
      if (buf.includes(0)) continue; // binary
      hits.push(...scanText(rel, buf.toString('utf8')));
    }
  };
  walk(root);
  return hits;
}

/** Scan only added lines of a unified diff. */
export function scanDiff(diff: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let file = '';
  let line = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ b/')) { file = l.slice(6); if (isForbiddenFile(file)) hits.push({ path: file, line: 0, rule: 'forbidden-file', excerpt: 'credential-bearing file type' }); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { line = Number(h[1]) - 1; continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) { line++; hits.push(...scanText(file, l.slice(1)).map((x) => ({ ...x, line }))); }
    else if (!l.startsWith('-')) line++;
  }
  return hits;
}
