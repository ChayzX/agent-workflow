# Architecture

## Components

```
                 ┌──────────────────────── supervisor process (systemd: orchestrator daemon) ───────────────────────┐
 operator ──CLI──▶ commands table ─┐                                                                                 │
 operator ─HTTP─▶ Dashboard ───────┤   Supervisor tick (deterministic, ~2 s, wakes early on events)                 │
                                   ├─▶ processCommands → capacity.tick (probes/resets/auth) → lease reclaim          │
                                   │   → wake waiting tasks → processOutcomes (single-flight) → Workflow.advance()    │
                                   │   → dispatch (Router → atomic claim → runTask)                                  │
                                   │                                                                                 │
 SQLite (WAL) ◀────────────────────┴── projects · requirements · work_items · tasks · sessions · messages · decisions │
                                        findings · gate_runs · audits · releases · approvals · checkpoints · events  │
                                        audit_log (hash chain) · provider_state · github_objects · usage             │
                                                                                                                     │
 runTask ─▶ Workflow.prepare (worktree, diff, findings, gate output) ─▶ buildPrompt (bounded, progressive)            │
        ─▶ Adapter.execute ── spawn ──▶ claude -p … --json-schema  |  codex exec --json --output-schema … [resume]    │
        ◀─ structured result, session id, usage, rate-limit windows ── validate(schema) ── outcome handler            │
                                                                                                                     │
 Jobs (keyed, off-tick): workspace clone · gates (bubblewrap) · merge + merge-gates · PR/CI · release build+verify   │
 GitHubSync: labels/milestones/issues/sub-issues/deps/board fields/PRs/checks/merge/releases (idempotent markers)    │
                 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Module | Responsibility |
|---|---|
| `src/core` | types, SQLite + migrations (immutable goal trigger, append-only audit triggers), config, redacting logger, events/audit chain |
| `src/providers` | provider-independent interface, Claude/Codex/simulated adapters, process runner (process-group kill), failure classifier |
| `src/engine/queue.ts` | durable queue: idempotent enqueue, atomic claim, fenced lease, heartbeat, recovery |
| `src/engine/capacity.ts` | per-provider availability and usage-limit recovery |
| `src/engine/router.ts` | provider/model selection |
| `src/engine/workflow.ts` | lifecycle state machine and outcome handlers |
| `src/engine/context.ts` | progressive context construction and budget trimming |
| `src/engine/{messages,debate,team,gates,release}.ts` | message bus, debates, team assembly, quality gates, packaging |
| `src/git/git.ts` | bare clone, worktrees, diffs, staged merges, recovery |
| `src/github` | REST/GraphQL client and idempotent sync |
| `src/security` | env scrubbing + bubblewrap sandbox, approvals policy, secret scanning |
| `src/web` | dashboard server and UI |
| `src/cli/main.ts` | CLI |

## Work item state machine

```
backlog ──deps satisfied──▶ ready ──WIP slot & no path conflict──▶ implementing ──commit──▶ gating
gating ──pass──▶ in_review ──approve (no ≥medium findings)──▶ merge_ready ──exact-commit merge + merge gates──▶ merged ──▶ done
gating ──fail──▶ remediation ◀──findings── in_review          merge_ready ──conflict / merge-gate fail / CI fail──▶ remediation
remediation ──commit──▶ gating ──pass──▶ in_review(verify_fix by the reviewer who raised the findings)
remediation rounds > limit, dead task, or agent "blocked" ──▶ investigate (root cause) ──▶ retry / alternative / reassign / block
dependency blocked ──▶ blocked (cascades; reported as requirement blocker)
```

## Project state machine

```
planning ──valid plan (DAG, coverage, real gates)──▶ debating ──decisions resolved──▶ active
active ──no open work, no tasks/messages/jobs──▶ auditing ──both auditors + deterministic checks pass──▶ releasing
auditing ──gaps/defects──▶ active (new defect work items)        releasing ──verified ZIP──▶ completed
releasing ──package verification fails──▶ active (release defect)   blocked requirements ──▶ blocked (partial release)
any ──operator──▶ paused / stopped ──resume──▶ previous state
```

## Failure classes → actions

| Class | Provider state | Task | Retry budget |
|---|---|---|---|
| usage_limit | exhausted until reset (or model-limited) | waiting_capacity, pinned to its session's provider, failover after threshold | not consumed |
| rate_limit | throttled briefly | queued after reset | not consumed |
| auth | auth_required + approval | queued, unpinned | not consumed |
| billing_policy | disabled + spending approval | queued on another provider | not consumed |
| interrupted (shutdown, lease loss) | – | queued, session kept | not consumed |
| timeout / killed / transient / invalid_output / task_failure | failure counted | backoff, resume with a correction note | consumed; dead → investigate |
| policy_refusal | – | dead | – |

## Context strategy (token efficiency)

- **Prompts are layered.** Every prompt has priority-0 sections that are never trimmed: role card, enforced policies,
  task, acceptance criteria and output contract. Below them come the linked requirements and path hints, then bounded
  material (diff ≤ 40k chars, gate output tail-weighted ≤ 6k), inbox messages, decisions in force, and a collaboration
  hint. Low-priority sections are halved until the prompt fits `limits.maxPromptChars`.
- **Native resume sends deltas only:** the reason and the new information.
- **Reconstructed sessions** (failover, or a lost session) get **checkpoints**, short structured summaries written at
  task boundaries, plus an instruction to inspect `git status` and `git diff`. Transcripts are never replayed.
- **Bounded output.** Results are structured JSON validated against schemas. Debates have at most 2 rounds, plus 1 for
  unresolved security objections. Remediation rounds, messages per task and delegation depth are all capped.
- **Idle agents cost nothing.** Waiting agents hold no session, scheduling is event-driven, and capacity probes use no
  model calls.
- **Measured.** `sessions.prompt_chars` and the provider-reported tokens are shown per task kind and session mode in the
  dashboard's Usage tab.

## Data retention
Transcripts (redacted) are kept in `$ORCH_HOME/transcripts`, gate logs in `gate-logs/`, releases in `releases/`, backups
in `backups/`. Logs rotate at 10 MB × 5.
