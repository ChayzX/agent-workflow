// LIVE dual-provider acceptance run (real `codex exec` + real `claude -p`, operator subscriptions).
// Not part of `npm test`. Run: node --disable-warning=ExperimentalWarning dist/test/live/live-acceptance.js [ORCH_HOME]
// Exercises: both providers executing concurrently in isolated worktrees, Codex⇄Claude questions in both directions,
// cross-provider reviews, a debate with both providers, dual completion audit, release ZIP — with cheap models.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp, createProject } from '../../src/app.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { Supervisor } from '../../src/engine/supervisor.js';

const home = resolve(process.argv[2] ?? join(process.cwd(), '.orchestrator-live'));
mkdirSync(home, { recursive: true });
const cfg = defaultConfig(home);
cfg.providers.claude!.models = { low: 'haiku', medium: 'haiku', high: 'sonnet' };
cfg.providers.claude!.effort = { low: 'low', medium: 'low', high: 'medium' };
cfg.providers.claude!.maxTurns = 40;
cfg.providers.codex!.effort = { low: 'low', medium: 'low', high: 'medium' };
cfg.providers.claude!.maxConcurrent = 1;
cfg.providers.codex!.maxConcurrent = 1;
cfg.supervisor.maxConcurrentAgents = 2;
cfg.routing.preferOrder = ['codex', 'claude'];
cfg.routing.failoverAfterMinutes = 60;
saveConfig(cfg);
const ctx = createApp({ cfg, echoLogs: false });

const goal = `# greet — dual-provider live acceptance

A tiny dependency-free Node.js (>= 22) ESM package with two functions, each with node:test tests, and a README.`;
const p = createProject(ctx, { goal, repo: 'new', name: 'greet-live' });
const sup = new Supervisor(ctx, { lock: true });
const ask = (q: string) => `IMPORTANT: this requirement intentionally leaves one detail open. Before writing any code you MUST ask the product_manager this blocking question via the messages array (type "question", blocking true) and return status "needs_input": "${q}". After the answer arrives, implement exactly what was answered.`;
sup.workflow.applyPlan(p, { agent_id: null, input: '{}', id: 'operator-plan' }, {
  product_name: 'greet', summary: 'Two tiny string functions with tests and docs (live acceptance fixture).',
  requirements: [
    { key: 'R-001', kind: 'functional', title: 'hello(name) greeting', description: 'src/hello.js exports hello(name).', acceptance: ['hello("Ada") returns the confirmed greeting', 'covered by node --test'], mandatory: true, priority: 0 },
    { key: 'R-002', kind: 'functional', title: 'shout(text) uppercase', description: 'src/shout.js exports shout(text).', acceptance: ['shout("hi") returns the confirmed form', 'covered by node --test'], mandatory: true, priority: 0 },
    { key: 'R-003', kind: 'nonfunctional', title: 'README', description: 'README.md documents usage of both functions.', acceptance: ['README.md shows usage of hello and shout'], mandatory: true, priority: 1 },
  ],
  work_items: [
    { key: 'W-001', type: 'feature', title: 'Implement hello(name)', description: `Create package.json (type module, "test": "node --test"), src/hello.js and test/hello.test.js. ${ask('Should hello("Ada") return "Hello, Ada!" or "Hi Ada"?')}`, acceptance: ['hello("Ada") matches the product decision', 'node --test passes'], requirement_keys: ['R-001'], depends_on: [], paths: ['src/hello.js', 'test/hello.test.js', 'package.json'], role: 'backend_engineer', complexity: 'low', priority: 0, milestone: 'MVP' },
    { key: 'W-002', type: 'feature', title: 'Implement shout(text)', description: `Create src/shout.js and test/shout.test.js (do not create package.json; W-001 owns it — if it is missing, create a minimal one with "type": "module"). ${ask('Should shout("hi") return "HI" or "HI!"?')}`, acceptance: ['shout("hi") matches the product decision', 'node --test passes'], requirement_keys: ['R-002'], depends_on: [], paths: ['src/shout.js', 'test/shout.test.js'], role: 'backend_engineer', complexity: 'low', priority: 0, milestone: 'MVP' },
    { key: 'W-003', type: 'docs', title: 'Write README', description: 'Document both functions with examples matching the implemented behavior.', acceptance: ['README.md shows hello and shout usage'], requirement_keys: ['R-003'], depends_on: ['W-001', 'W-002'], paths: ['README.md'], role: 'documentation_engineer', complexity: 'low', priority: 1, milestone: 'MVP' },
  ],
  milestones: [{ name: 'MVP', description: 'everything' }],
  team: [{ role: 'backend_engineer', responsibility: 'library code' }, { role: 'product_manager', responsibility: 'answers product questions' }, { role: 'documentation_engineer', responsibility: 'docs' }],
  decisions: [{ key: 'ADR-001', title: 'README format', problem: 'Should the README use a single usage section or one section per function? Keep the debate brief.', alternatives: ['single section', 'one section per function'], blocks: ['W-003'] }],
  gates: [{ name: 'test', command: 'node --test', required: true, kind: 'test' }],
  verify_commands: ['node --test'],
  messages: [],
});
writeFileSync(join(home, 'live-project-id'), p.id);
await sup.start();
console.log(`live acceptance running: project ${p.id} home ${home}`);
const t0 = Date.now();
const timer = setInterval(async () => {
  const cur = ctx.db.get<{ status: string; status_reason: string }>('SELECT status, status_reason FROM projects WHERE id=?', p.id)!;
  console.log(`${new Date().toISOString()} ${cur.status} ${cur.status_reason ?? ''}`);
  if (['completed', 'blocked', 'failed'].includes(cur.status) || Date.now() - t0 > 100 * 60_000) {
    clearInterval(timer);
    await sup.stop(60_000);
    console.log(`FINAL ${cur.status}`);
    process.exit(cur.status === 'completed' ? 0 : 1);
  }
}, 30_000);
