// Dashboard security and API behavior against a real HTTP listener.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dashboard, hashToken } from '../src/web/server.js';
import { makeHarness, newDemoProject } from './support/harness.js';
import { demoBehaviour, DEMO_GOAL } from './support/scenario.js';

test('dashboard: auth, CSRF, cookie flags, headers, limits, project API and XSS-safe rendering contract', async () => {
  const h = makeHarness(demoBehaviour());
  h.ctx.cfg.dashboard.tokenHash = hashToken('correct-horse-battery-staple');
  const d = new Dashboard(h.ctx, { port: 0, host: '127.0.0.1' });
  const { port } = await d.listen();
  const B = `http://127.0.0.1:${port}`;
  const H = { 'X-Orchestrator-CSRF': '1', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${B}/api/overview`)).status, 401);
    assert.equal((await fetch(`${B}/api/login`, { method: 'POST', body: JSON.stringify({ token: 'correct-horse-battery-staple' }) })).status, 403, 'CSRF header required');
    assert.equal((await fetch(`${B}/api/login`, { method: 'POST', headers: { ...H, Origin: 'http://evil.example' }, body: JSON.stringify({ token: 'correct-horse-battery-staple' }) })).status, 403);
    assert.equal((await fetch(`${B}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ token: 'wrong' }) })).status, 401);
    const ok = await fetch(`${B}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ token: 'correct-horse-battery-staple' }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    assert.match(ok.headers.get('content-security-policy')!, /script-src 'self'/);
    const C = { cookie: cookie.split(';')[0]! };
    const p = newDemoProject(h, DEMO_GOAL);
    const ov = (await (await fetch(`${B}/api/overview`, { headers: C })).json()) as any;
    assert.equal(ov.projects[0].id, p.id);
    assert.equal(ov.projects[0].coverage.mandatory, 0);
    const det = (await (await fetch(`${B}/api/projects/${p.id}`, { headers: C })).json()) as any;
    assert.equal(det.project.goal_text, p.goal_text);
    assert.equal((await fetch(`${B}/api/projects/${p.id}/pause`, { method: 'POST', headers: C })).status, 403, 'state change needs CSRF header');
    assert.equal((await fetch(`${B}/api/projects/${p.id}/pause`, { method: 'POST', headers: { ...C, ...H } })).status, 202);
    assert.equal(h.ctx.db.get<{ command: string }>('SELECT command FROM commands ORDER BY id DESC LIMIT 1')!.command, 'pause');
    const big = await fetch(`${B}/api/projects`, { method: 'POST', headers: { ...C, ...H }, body: 'a'.repeat(300_000) }).catch(() => null);
    assert.ok(!big || big.status === 413, 'oversized body rejected with 413');
    assert.equal((await fetch(`${B}/api/projects`, { method: 'POST', headers: { ...C, ...H }, body: JSON.stringify({ goal: 'short', repo: 'new' }) })).status, 400);
    assert.equal((await fetch(`${B}/..%2fconfig.json`)).status, 404);
    const hz = await fetch(`${B}/healthz`);
    assert.deepEqual(await hz.json(), { ok: true });
    const html = await (await fetch(`${B}/`)).text();
    assert.doesNotMatch(html, /<script>(?!<\/)/, 'no inline scripts (CSP)');
    const js = await (await fetch(`${B}/app.js`)).text();
    assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/, 'UI never injects untrusted text as HTML');
    const logout = await fetch(`${B}/api/logout`, { method: 'POST', headers: { ...C, ...H } });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${B}/api/overview`, { headers: C })).status, 401, 'session revoked');
  } finally {
    await d.close();
    h.cleanup();
  }
});
