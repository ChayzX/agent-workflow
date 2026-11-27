// JSON Schemas for structured agent outputs. Every agent invocation has a specific purpose,
// a bounded context and one of these machine-checkable result formats.
import type { TaskKind } from '../core/types.js';

type S = Record<string, unknown>;
const str: S = { type: 'string' };
const bool: S = { type: 'boolean' };
const int: S = { type: 'integer' };
const strArr: S = { type: 'array', items: str };
const enumOf = (...v: string[]): S => ({ type: 'string', enum: v });
const obj = (properties: Record<string, S>, required = Object.keys(properties)): S => ({ type: 'object', properties, required, additionalProperties: false });
const arr = (items: S): S => ({ type: 'array', items });

export const MESSAGE_TYPES = ['question', 'assist_request', 'proposal', 'challenge', 'finding', 'revision_request', 'transfer', 'blocker', 'decision'];
const outboundMessages = arr(obj({ to_role: str, type: enumOf(...MESSAGE_TYPES), body: str, blocking: bool }));

const finding = obj({
  severity: enumOf('critical', 'high', 'medium', 'low', 'info'),
  category: str,
  title: str,
  locations: arr(obj({ path: str, line: int })),
  evidence: str,
  explanation: str,
  remediation: str,
  verification: str,
});

export const SCHEMAS: Record<TaskKind, S> = {
  plan: obj({
    product_name: str,
    summary: str,
    requirements: arr(obj({
      key: str, kind: enumOf('functional', 'nonfunctional', 'constraint'), title: str, description: str,
      acceptance: strArr, mandatory: bool, priority: int,
    })),
    work_items: arr(obj({
      key: str, type: enumOf('feature', 'chore', 'docs', 'test'), title: str, description: str, acceptance: strArr,
      requirement_keys: strArr, depends_on: strArr, paths: strArr, role: str, complexity: enumOf('low', 'medium', 'high'),
      priority: int, milestone: str,
    })),
    milestones: arr(obj({ name: str, description: str })),
    team: arr(obj({ role: str, responsibility: str })),
    decisions: arr(obj({ key: str, title: str, problem: str, alternatives: strArr, blocks: strArr })),
    gates: arr(obj({ name: str, command: str, required: bool, kind: enumOf('build', 'lint', 'typecheck', 'test', 'security', 'e2e', 'other') })),
    verify_commands: strArr,
    messages: outboundMessages,
  }),
  implement: obj({
    status: enumOf('completed', 'blocked', 'needs_input'),
    summary: str,
    files_changed: strArr,
    tests_added: strArr,
    acceptance_evidence: arr(obj({ criterion: str, evidence: str })),
    notes: str,
    messages: outboundMessages,
  }),
  remediate: obj({
    status: enumOf('completed', 'blocked', 'needs_input'),
    summary: str,
    files_changed: strArr,
    tests_added: strArr,
    addressed_finding_ids: strArr,
    root_cause: str,
    notes: str,
    messages: outboundMessages,
  }),
  review: obj({ verdict: enumOf('approve', 'request_changes'), summary: str, findings: arr(finding), messages: outboundMessages }),
  security_review: obj({ verdict: enumOf('approve', 'request_changes'), summary: str, findings: arr(finding), messages: outboundMessages }),
  verify_fix: obj({
    verdict: enumOf('approve', 'request_changes'), summary: str, resolved_finding_ids: strArr, unresolved_finding_ids: strArr,
    new_findings: arr(finding), messages: outboundMessages,
  }),
  answer: obj({ answer: str, confidence: enumOf('low', 'medium', 'high'), references: strArr, messages: outboundMessages }),
  debate_propose: obj({
    problem: str,
    alternatives: arr(obj({ name: str, description: str, pros: strArr, cons: strArr })),
    recommendation: str,
    rationale: str,
  }),
  debate_evaluate: obj({
    stance: enumOf('support', 'object', 'alternative', 'abstain'), summary: str, evidence: strArr, risks: strArr,
    objections: arr(obj({ text: str, security_critical: bool })), recommended_alternative: str,
  }),
  debate_rebut: obj({ revised: bool, proposal_summary: str, responses: arr(obj({ objection: str, response: str })), recommendation: str }),
  debate_final: obj({
    stance: enumOf('support', 'object', 'alternative', 'abstain'), summary: str, evidence: strArr, risks: strArr,
    objections: arr(obj({ text: str, security_critical: bool })), recommended_alternative: str,
  }),
  debate_decide: obj({
    outcome: str, rationale: str, consequences: strArr,
    security_resolutions: arr(obj({ objection: str, resolution: str })),
    adr_markdown: str,
  }),
  investigate: obj({
    root_cause: str,
    strategy: enumOf('retry_same', 'alternative_approach', 'reassign_specialist', 'split_task', 'block'),
    recommended_role: str,
    guidance: str,
    blocker: str,
  }),
  integration_audit: obj({
    summary: str,
    issues: arr(obj({ severity: enumOf('critical', 'high', 'medium', 'low'), title: str, description: str, requirement_keys: strArr, paths: strArr, acceptance: strArr })),
  }),
  completion_audit: obj({
    summary: str,
    requirements: arr(obj({ key: str, status: enumOf('satisfied', 'unsatisfied', 'blocked'), evidence: str, gap: str })),
    defects: arr(obj({ severity: enumOf('critical', 'high', 'medium', 'low'), title: str, description: str, paths: strArr, acceptance: strArr })),
    docs_accurate: bool,
    install_reproducible: bool,
    release_recommended: bool,
  }),
};

export function schemaFor(kind: TaskKind): S {
  return SCHEMAS[kind];
}
