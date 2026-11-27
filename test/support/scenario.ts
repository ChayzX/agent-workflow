// Deterministic simulated "engineering team" for end-to-end tests. Agents really edit files in
// their worktrees and real `node --test` quality gates judge the results. The scenario includes:
//  - W-001's first implementation has a deliberate bug (add subtracts) → gates fail → remediation
//  - W-002's first review (by the other provider) finds a missing test → remediation → verify_fix
//  - W-003's documentation agent asks the backend engineer a blocking question → answered → resumed
//  - ADR-001 goes through a full debate before W-002 may start
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SimBehaviour, SimOutcome } from '../../src/providers/simulated.js';
import type { ExecRequest } from '../../src/providers/types.js';

const w = (dir: string, rel: string, content: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), content); };

export const DEMO_GOAL = `# Calculator library

Build a tiny dependency-free Node.js calculator library ("calc") exposing add(a, b) and multiply(a, b),
with automated tests runnable via \`node --test\` and a README documenting installation and usage.`;

export function demoPlan(): Record<string, unknown> {
  return {
    product_name: 'calc', summary: 'A tiny dependency-free calculator library with tests and docs.',
    requirements: [
      { key: 'R-001', kind: 'functional', title: 'add(a, b) returns the sum', description: 'Export add.', acceptance: ['add(2,3) === 5', 'covered by node --test'], mandatory: true, priority: 0 },
      { key: 'R-002', kind: 'functional', title: 'multiply(a, b) returns the product', description: 'Export multiply.', acceptance: ['multiply(4,5) === 20', 'negative numbers tested'], mandatory: true, priority: 1 },
      { key: 'R-003', kind: 'nonfunctional', title: 'README documents install and usage', description: 'Docs.', acceptance: ['README.md exists with usage examples'], mandatory: true, priority: 2 },
    ],
    work_items: [
      { key: 'W-001', type: 'feature', title: 'Scaffold package and implement add', description: 'Create package.json, src/calc.js with add, tests.', acceptance: ['add(2,3) === 5', 'node --test passes'], requirement_keys: ['R-001'], depends_on: [], paths: ['src/calc.js', 'test/add.test.js', 'package.json'], role: 'backend_engineer', complexity: 'low', priority: 0, milestone: 'MVP' },
      { key: 'W-002', type: 'feature', title: 'Implement multiply', description: 'Add multiply to src/multiply.js with tests including negatives.', acceptance: ['multiply(4,5) === 20', 'negative numbers tested'], requirement_keys: ['R-002'], depends_on: ['W-001'], paths: ['src/multiply.js', 'test/multiply.test.js'], role: 'backend_engineer', complexity: 'low', priority: 1, milestone: 'MVP' },
      { key: 'W-003', type: 'docs', title: 'Write README', description: 'Document install and usage.', acceptance: ['README.md with usage'], requirement_keys: ['R-003'], depends_on: ['W-001'], paths: ['README.md'], role: 'documentation_engineer', complexity: 'low', priority: 2, milestone: 'MVP' },
    ],
    milestones: [{ name: 'MVP', description: 'All features' }],
    team: [{ role: 'backend_engineer', responsibility: 'Library code' }, { role: 'documentation_engineer', responsibility: 'Docs' }],
    decisions: [{ key: 'ADR-001', title: 'Module format', problem: 'ESM or CommonJS?', alternatives: ['ESM', 'CommonJS'], blocks: ['W-002'] }],
    gates: [{ name: 'test', command: 'node --test', required: true, kind: 'test' }],
    verify_commands: ['node --test'],
    messages: [],
  };
}

export interface ScenarioState { calls: Record<string, number>; log: string[] }

const impl = (status: string, summary: string, files: string[], extra: Record<string, unknown> = {}) => ({
  status, summary, files_changed: files, tests_added: files.filter((f) => f.includes('test')), acceptance_evidence: [], notes: '', messages: [], ...extra,
});
const rem = (summary: string, ids: string[], files: string[]) => ({ status: 'completed', summary, files_changed: files, tests_added: [], addressed_finding_ids: ids, root_cause: summary, notes: '', messages: [] });

export function demoBehaviour(state: ScenarioState = { calls: {}, log: [] }): SimBehaviour {
  return (req: ExecRequest, c): SimOutcome => {
    const k = `${req.meta.taskKind}:${req.meta.workItemKey ?? ''}`;
    state.calls[k] = (state.calls[k] ?? 0) + 1;
    state.log.push(`${c.provider} ${k}${c.resumed ? ' (resumed)' : ''}`);
    const d = req.cwd;
    switch (req.meta.taskKind) {
      case 'plan': return { structured: demoPlan() };
      case 'implement':
        if (req.meta.workItemKey === 'W-001') {
          w(d, 'package.json', JSON.stringify({ name: 'calc', version: '0.1.0', type: 'module', main: 'src/calc.js' }, null, 2));
          // Deliberate defect: subtraction instead of addition. Real gates will catch it.
          w(d, 'src/calc.js', 'export function add(a, b) {\n  return a - b;\n}\n');
          w(d, 'test/add.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.js';\ntest('add', () => { assert.equal(add(2, 3), 5); });\n");
          return { structured: impl('completed', 'scaffolded package and add()', ['package.json', 'src/calc.js', 'test/add.test.js']) };
        }
        if (req.meta.workItemKey === 'W-002') {
          w(d, 'src/multiply.js', 'export function multiply(a, b) {\n  return a * b;\n}\n');
          w(d, 'test/multiply.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply } from '../src/multiply.js';\ntest('multiply', () => { assert.equal(multiply(4, 5), 20); });\n");
          return { structured: impl('completed', 'implemented multiply()', ['src/multiply.js', 'test/multiply.test.js']) };
        }
        if (req.meta.workItemKey === 'W-003') {
          if (!c.resumed && !req.prompt.includes('New information')) {
            return { structured: impl('needs_input', 'need API details', [], { messages: [{ to_role: 'backend_engineer', type: 'question', body: 'What is the public API and import path of the calc package?', blocking: true }] }) };
          }
          w(d, 'README.md', '# calc\n\nInstall: copy the package or `npm install ./calc`.\n\n```js\nimport { add } from "calc";\nadd(2, 3); // 5\n```\n');
          return { structured: impl('completed', 'README written using the answer from backend', ['README.md']) };
        }
        return { structured: impl('blocked', 'unknown item', []) };
      case 'remediate':
        if (req.meta.workItemKey === 'W-001') {
          w(d, 'src/calc.js', 'export function add(a, b) {\n  return a + b;\n}\n');
          return { structured: rem('fixed add() using + instead of -', [], ['src/calc.js']) };
        }
        if (req.meta.workItemKey === 'W-002') {
          const ids = [...req.prompt.matchAll(/id (fnd_[a-z0-9]+)/g)].map((m) => m[1]!);
          w(d, 'test/multiply.test.js', readFileSync(join(d, 'test/multiply.test.js'), 'utf8') + "test('multiply negatives', () => { assert.equal(multiply(-2, 3), -6); });\n");
          return { structured: rem('added negative-number test', ids, ['test/multiply.test.js']) };
        }
        return { structured: rem('re-ran gates', [], []) };
      case 'review':
      case 'security_review': {
        const first = state.calls[k] === 1;
        if (req.meta.workItemKey === 'W-002' && first && req.meta.taskKind === 'review') {
          return { structured: { verdict: 'request_changes', summary: 'missing negative-number test', messages: [], findings: [{ severity: 'medium', category: 'tests', title: 'No test for negative numbers', locations: [{ path: 'test/multiply.test.js', line: 4 }], evidence: 'only multiply(4,5) is tested', explanation: 'Acceptance criterion "negative numbers tested" is unmet.', remediation: 'Add a negative-number test.', verification: 'test/multiply.test.js asserts multiply(-2,3) === -6' }] } };
        }
        return { structured: { verdict: 'approve', summary: 'looks correct', findings: [], messages: [] } };
      }
      case 'verify_fix': {
        const ids = [...req.prompt.matchAll(/id (fnd_[a-z0-9]+)/g)].map((m) => m[1]!);
        const ok = existsSync(join(d, 'test/multiply.test.js')) && readFileSync(join(d, 'test/multiply.test.js'), 'utf8').includes('-6');
        return { structured: { verdict: ok ? 'approve' : 'request_changes', summary: ok ? 'negative test present' : 'still missing', resolved_finding_ids: ok ? ids : [], unresolved_finding_ids: ok ? [] : ids, new_findings: [], messages: [] } };
      }
      case 'answer':
        return { structured: { answer: 'Import { add } from "calc" (src/calc.js) and { multiply } from src/multiply.js; ESM only.', confidence: 'high', references: ['src/calc.js'], messages: [] } };
      case 'debate_propose':
        return { structured: { problem: 'Choose module format', alternatives: [{ name: 'ESM', description: 'native modules', pros: ['standard'], cons: ['older tooling'] }, { name: 'CommonJS', description: 'require()', pros: ['legacy'], cons: ['not standard'] }], recommendation: 'ESM', rationale: 'Node >= 22 supports ESM natively.' } };
      case 'debate_evaluate':
        return { structured: req.meta.role === 'security_engineer'
          ? { stance: 'object', summary: 'ok if no dynamic import of user paths', evidence: ['n/a'], risks: ['dynamic import'], objections: [{ text: 'Avoid dynamic import of user-controlled paths', security_critical: true }], recommended_alternative: '' }
          : { stance: 'support', summary: 'ESM is standard', evidence: ['node docs'], risks: [], objections: [], recommended_alternative: '' } };
      case 'debate_rebut':
        return { structured: { revised: true, proposal_summary: 'ESM with static imports only', responses: [{ objection: 'Avoid dynamic import of user-controlled paths', response: 'Only static imports are used.' }], recommendation: 'ESM' } };
      case 'debate_final':
        return { structured: { stance: 'support', summary: 'resolved', evidence: [], risks: [], objections: req.meta.role === 'security_engineer' ? [{ text: 'Avoid dynamic import of user-controlled paths', security_critical: true }] : [], recommended_alternative: '' } };
      case 'debate_decide':
        return { structured: { outcome: 'ESM with static imports only', rationale: 'standard; satisfies security constraint', consequences: ['package.json type=module'], security_resolutions: [{ objection: 'Avoid dynamic import of user-controlled paths', resolution: 'Static imports only; enforced in review.' }], adr_markdown: '' } };
      case 'investigate':
        return { structured: { root_cause: 'transient', strategy: 'retry_same', recommended_role: '', guidance: 'retry', blocker: '' } };
      case 'integration_audit':
        return { structured: { summary: 'no integration issues', issues: [] } };
      case 'completion_audit':
        return { structured: {
          summary: 'all requirements satisfied', docs_accurate: true, install_reproducible: true, release_recommended: true, defects: [],
          requirements: ['R-001', 'R-002', 'R-003'].map((key) => ({ key, status: 'satisfied', evidence: 'tests pass; files present', gap: '' })),
        } };
    }
    return { failure: { cls: 'unknown', message: `no behaviour for ${req.meta.taskKind}` } };
  };
}
