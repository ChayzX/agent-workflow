// Specialist role catalog. Roles define responsibility, permission level and a concise
// role card (kept short deliberately: every token here is paid on every invocation).
import type { RoleId, TaskKind } from '../core/types.js';

export interface RoleDef {
  id: RoleId;
  title: string;
  responsibility: string;
  writes: boolean;          // may modify workspaces (implementation roles)
  card: string;
}

const R = (id: RoleId, title: string, responsibility: string, writes: boolean, card: string): RoleDef => ({ id, title, responsibility, writes, card });

export const ROLES: Record<string, RoleDef> = Object.fromEntries(
  [
    R('engineering_director', 'Engineering Director', 'Coordinates scope, priorities, dependencies, decisions and completion.', false,
      'You coordinate the engineering organization. Decide scope, priorities and dependencies; resolve blockers; never inflate completion.'),
    R('product_manager', 'Product Manager', 'Turns goals into requirements and measurable acceptance criteria.', false,
      'You convert intent into precise, testable requirements. Every requirement needs measurable acceptance criteria.'),
    R('software_architect', 'Software Architect', 'Owns system design, interfaces and architecture decisions.', false,
      'You own architecture. Prefer the simplest design that satisfies requirements; justify tradeoffs with evidence.'),
    R('ux_designer', 'UX/UI Designer', 'Designs accessible, usable interfaces and interaction flows.', true,
      'You design accessible, usable interfaces (WCAG 2.1 AA). Specify states, errors and empty states.'),
    R('frontend_engineer', 'Frontend Engineer', 'Implements user interfaces with tests.', true,
      'You implement frontend features with tests. Keep components accessible and state predictable.'),
    R('backend_engineer', 'Backend Engineer', 'Implements services, APIs and business logic with tests.', true,
      'You implement backend features with tests. Validate inputs, handle errors explicitly, keep interfaces stable.'),
    R('database_engineer', 'Database Engineer', 'Owns schemas, migrations and data integrity.', true,
      'You own data models and migrations. Migrations must be reversible or documented; protect integrity.'),
    R('security_engineer', 'Security and Identity Engineer', 'Reviews and implements security, authn/authz and secret handling.', true,
      'You are a security engineer. Find exploitable defects with evidence (injection, authz, secrets, SSRF, deserialization). No speculation without a path.'),
    R('quality_engineer', 'Quality Engineer', 'Designs and implements automated tests and quality gates.', true,
      'You build reliable automated tests. Tests must assert behavior from acceptance criteria and fail on regressions.'),
    R('code_reviewer', 'Independent Code Reviewer', 'Reviews actual diffs for correctness, security and maintainability.', false,
      'You are an independent reviewer. Review the actual diff, not summaries. Report only real, actionable defects with evidence.'),
    R('devops_engineer', 'DevOps Engineer', 'Builds CI, packaging, containers and deployment manifests.', true,
      'You build CI, containers and deployment manifests with least privilege and reproducible builds.'),
    R('sre', 'Site Reliability Engineer', 'Owns observability, health checks, resilience and runbooks.', true,
      'You ensure reliability: health checks, graceful shutdown, resource limits, logs and runbooks.'),
    R('documentation_engineer', 'Documentation Engineer', 'Writes accurate user, developer and operations documentation.', true,
      'You write accurate documentation that matches the implementation. Verify commands before documenting them.'),
    R('release_engineer', 'Release Engineer', 'Owns versioning, release notes and package verification.', true,
      'You own releases: versioning, notes, reproducible packaging, rollback instructions.'),
  ].map((r) => [r.id, r]),
);

export function roleDef(id: RoleId, custom?: { responsibility?: string }): RoleDef {
  const known = ROLES[id];
  if (known) return known;
  // Domain-specific specialist created on demand from the plan (e.g. "twitch_api_specialist").
  const title = id.split(/[_-]/).map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
  const resp = custom?.responsibility ?? `Domain specialist: ${title}.`;
  return R(id, title, resp, true, `You are a ${title}. ${resp} Implement with tests and evidence.`);
}

/** Default role for orchestration task kinds (implementation kinds use the work item's role). */
export function defaultRoleFor(kind: TaskKind): RoleId {
  switch (kind) {
    case 'plan': return 'engineering_director';
    case 'review': case 'verify_fix': return 'code_reviewer';
    case 'security_review': return 'security_engineer';
    case 'investigate': return 'engineering_director';
    case 'integration_audit': return 'software_architect';
    case 'completion_audit': return 'quality_engineer';
    case 'debate_propose': case 'debate_rebut': return 'software_architect';
    case 'debate_decide': return 'engineering_director';
    default: return 'backend_engineer';
  }
}

export const READ_ONLY_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>([
  'plan', 'review', 'security_review', 'verify_fix', 'answer', 'debate_propose', 'debate_evaluate', 'debate_rebut',
  'debate_final', 'debate_decide', 'investigate', 'integration_audit', 'completion_audit',
]);
