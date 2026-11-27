// Core domain types shared across the orchestrator.
// State enums are string unions so they persist readably in SQLite and JSON.

export type ProviderId = 'claude' | 'codex' | 'simulated' | (string & {});

export type ProjectStatus =
  | 'planning'        // goal analysis / backlog creation in progress
  | 'debating'        // material decisions being resolved before dependent work
  | 'active'          // implementation lifecycle running
  | 'auditing'        // completion audit running
  | 'releasing'       // package build + verification
  | 'completed'       // verified release produced
  | 'paused'          // operator paused
  | 'stopped'         // operator stopped (terminal unless resumed explicitly)
  | 'blocked'         // essential external blocker; needs operator
  | 'failed';         // unrecoverable failure (bounded retries exhausted at project level)

export type WorkItemStatus =
  | 'backlog' | 'ready' | 'implementing' | 'gating' | 'in_review' | 'remediation'
  | 'merge_ready' | 'merging' | 'merged' | 'done' | 'blocked' | 'cancelled';

export type TaskKind =
  | 'plan'              // goal → requirements/backlog (Director + PM)
  | 'implement'         // implement a work item in its worktree
  | 'review'            // independent code review of a diff
  | 'security_review'   // specialist security review
  | 'remediate'         // fix findings / failing gates / conflicts
  | 'verify_fix'        // reviewer verifies findings were resolved
  | 'answer'            // answer a question from another agent
  | 'debate_propose' | 'debate_evaluate' | 'debate_rebut' | 'debate_final' | 'debate_decide'
  | 'investigate'       // root-cause investigation after repeated failure
  | 'integration_audit' // periodic project-wide audit
  | 'completion_audit'; // independent completion audit

export type TaskStatus =
  | 'queued'            // eligible when not_before passed and deps satisfied
  | 'running'           // claimed with a live lease
  | 'waiting_message'   // yielded capacity awaiting an answer
  | 'waiting_capacity'  // provider exhausted; resumes when capacity returns
  | 'succeeded' | 'failed' | 'cancelled'
  | 'dead';             // bounded retries exhausted

export type FailureClass =
  | 'usage_limit'       // subscription / plan usage exhausted (temporary, has reset)
  | 'rate_limit'        // short-term throttling (seconds-minutes)
  | 'auth'              // authentication missing/expired: needs operator reauth
  | 'billing_policy'    // would incur unauthorized API billing → refuse
  | 'timeout'
  | 'killed'            // process terminated externally / crashed
  | 'interrupted'       // supervisor restart / shutdown
  | 'transient'         // network / 5xx / overloaded
  | 'invalid_output'    // structured output missing / schema violation
  | 'context_overflow'
  | 'policy_refusal'
  | 'tool_missing'
  | 'task_failure'      // agent ran but reported it could not complete
  | 'unknown';

export type ProviderStatus =
  | 'available'
  | 'recovering'     // reset time passed; one canary task allowed
  | 'exhausted'      // usage limit hit; waiting for reset
  | 'throttled'      // short-term rate limit
  | 'auth_required'  // operator must reauthenticate
  | 'unavailable'    // CLI missing / broken
  | 'disabled';      // operator disabled

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export type MessageType =
  | 'question' | 'answer' | 'assist_request' | 'proposal' | 'challenge'
  | 'finding' | 'revision_request' | 'transfer' | 'blocker' | 'decision';

export type RoleId =
  | 'engineering_director' | 'product_manager' | 'software_architect' | 'ux_designer'
  | 'frontend_engineer' | 'backend_engineer' | 'database_engineer' | 'security_engineer'
  | 'quality_engineer' | 'code_reviewer' | 'devops_engineer' | 'sre'
  | 'documentation_engineer' | 'release_engineer' | (string & {});

export type Complexity = 'low' | 'medium' | 'high';

export interface ProjectRow {
  id: string;
  name: string;
  goal_text: string;
  goal_sha256: string;
  status: ProjectStatus;
  repo_mode: 'local' | 'github';
  repo_source: string;           // local path or owner/name
  workspace_dir: string;
  default_branch: string;
  settings: string;              // JSON ProjectSettings
  plan: string | null;           // JSON validated plan
  status_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface QualityGate {
  name: string;
  command: string;               // run via sh -c in sandbox
  required: boolean;
  timeout_sec?: number;
  kind?: 'build' | 'lint' | 'typecheck' | 'test' | 'security' | 'e2e' | 'other';
}

export interface ProjectSettings {
  gates: QualityGate[];
  verify_commands: string[];     // clean-environment install/build verification for the release
  auto_merge: boolean;
  integration_audit_every: number; // merges between integration audits
  version?: string;
  github?: { project_number?: number; project_id?: string; owner?: string; repo?: string; create_project?: boolean };
  provider_preference?: ProviderId[];
}

export interface TaskRow {
  id: string;
  project_id: string;
  work_item_id: string | null;
  kind: TaskKind;
  role: RoleId;
  agent_id: string | null;
  status: TaskStatus;
  priority: number;
  complexity: Complexity;
  provider: ProviderId | null;          // assigned provider for current/last attempt
  provider_pinned: ProviderId | null;   // must run on this provider (session continuity)
  exclude_providers: string;            // JSON ProviderId[] (e.g. cross-review)
  exclude_agents: string;               // JSON agent ids (never self-review)
  not_before: number;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
  pid: number | null;
  idempotency_key: string;
  input: string;                        // JSON
  output: string | null;                // JSON
  error_class: FailureClass | null;
  error_message: string | null;
  session_id: string | null;            // provider session id (resume)
  session_provider: ProviderId | null;
  workspace_path: string | null;
  read_only: number;                    // 1 => reviewer / auditor
  parent_task_id: string | null;
  processed: number;                    // 1 once the lifecycle handler applied the outcome
  created_at: number;
  updated_at: number;
}

export interface WorkItemRow {
  id: string;
  project_id: string;
  key: string;
  type: 'feature' | 'defect' | 'chore' | 'docs' | 'test';
  title: string;
  description: string;
  acceptance: string;             // JSON string[]
  requirement_keys: string;       // JSON string[]
  depends_on: string;             // JSON keys of work items or decisions
  paths: string;                  // JSON path hints (conflict detection, context)
  role: RoleId;
  complexity: Complexity;
  priority: number;               // 0 (highest) .. 3
  milestone: string | null;
  status: WorkItemStatus;
  branch: string | null;
  base_commit: string | null;
  head_commit: string | null;
  reviewed_commit: string | null;
  gated_commit: string | null;
  merged_commit: string | null;
  implementer_agent_id: string | null;
  implementer_provider: ProviderId | null;
  remediation_rounds: number;
  pr_number: number | null;
  github_issue_number: number | null;
  status_reason: string | null;
  source: string | null;          // 'plan' | 'review' | 'audit' | 'gate' | 'release'
  created_at: number;
  updated_at: number;
}
