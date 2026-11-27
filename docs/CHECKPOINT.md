# Build checkpoint (founding Engineering Director log)

This file is the durable hand-off for the session building this platform. Update it at each
milestone boundary. Scheduled auto-resume reads "Next executable actions".

## Current milestone (updated 2026-11-27 11:30 UTC)
- PR #1 merged (a7673a9). Follow-ups on branch claude/autonomous-engineering-orchestrator-ocqm2i:
  da2b85f (blocked-claim override), 4905b9b (gate git access, auditor file reading, vague audit defects). `npm test` 48/48.
- Live dual-provider run 2 (`<scratchpad>/orch-live3`) verified: Claude→Codex and Codex→Claude Q&A, cross-provider
  reviews in both directions, debate ADR-001 (Codex proposed, Claude evaluated/decided), concurrent implementation by
  both providers, live crash recovery (harness killed 11:20; `orchestrator run` resumed both sessions natively).
  Its first completion audit failed for a prompt bug (fixed in 4905b9b); resumed on the fixed build at 11:21.
- Issues needing the operator are labelled `needs-operator` with exact requirements: #29-32, #46 (PAT),
  #45, #48 (fresh VM), #49, #53 (systemd host), #52 (HawkScan), #54 (OCI).
- Remaining:
  1. Let run 2 finish (watch with `ORCH_HOME=<scratchpad>/orch-live3 ./bin/orchestrator status`; resume with
     `ORCH_HOME=... ./bin/orchestrator run --no-dashboard` if the supervisor is not running). Copy evidence to
     docs/evidence/greet-dual-provider/ (`git add -f` for logs) and update ⏳ rows in docs/acceptance-matrix.md.
  2. Self-package ZIP + .sha256 under release/; send to the user.
  3. Open PR #2, independent review subagent, merge only on APPROVE; then close #17, #19, #36, #37, #56, #57 with evidence.
  4. Delete the hourly "Resume orchestrator build" task (trig_017TYriJi3K7RCRCucUNw7M5) and report.

## Verified facts (live evidence, 2026-11-27)
- Claude Code CLI 2.1.332, subscription OAuth (`apiKeySource: "none"`). `claude -p --output-format stream-json`
  emits `system/init`, `rate_limit_event` (with `resetsAt` epoch seconds, per-window `utilization` for `five_hour`/`seven_day`),
  and `result` (with `structured_output` when `--json-schema` is used). `--resume <id>` keeps the session id. Fixture:
  `test/fixtures/claude-stream-success.jsonl`.
- Codex CLI 0.172.0 signed in with ChatGPT (Plus). `codex exec --json` emits `thread.started{thread_id}`, `turn.started`,
  `error`, `turn.failed{error.message}`. Usage-limit text: "You’ve hit your usage limit … try again at 7:08 AM." Fixture:
  `test/fixtures/codex-exec-usage-limit.jsonl`.
- `codex app-server` JSON-RPC: `initialize` → `account/read` (account type `chatgpt`, planType) → `account/rateLimits/read`
  returns `ordinaryUsageAllowed`, primary (300 min) / secondary (10080 min) windows with `usedPercent` and `resetsAt`.
  This is a NON-MODEL capacity probe. Fixture: `test/fixtures/codex-app-server-ratelimits.json`.
- At 04:10 UTC the Codex 5-hour window was 100% used, reset 07:08:04 UTC (both the exec message and app-server agree).

## Decisions so far
- TypeScript on Node ≥ 22.13, built-in `node:sqlite` (WAL), zero runtime npm dependencies.
- Drive official CLIs (`claude -p`, `codex exec`) rather than SDKs: subscription auth stays inside unmodified binaries.
- Bare managed clone + git worktrees per task; supervisor alone holds GitHub credentials, commits, pushes and merges.
- Scrubbed agent env (no GitHub/cloud creds; API keys removed unless billing explicitly authorized).

## Files written (src/)
core: types, db (schema v1), clock, ids, redact, log, events (hash-chained audit), config
providers: types, process, classify, claude, codex
engine: schemas, roles, queue, capacity, router
git: git (Workspace)
security: sandbox, policy, secrets
util: validate

## Next executable actions (remaining)
See "Remaining" under Current milestone.

## Original plan (done unless noted)
1. Write: providers/simulated.ts + registry; engine/context.ts (prompt builder), team.ts, messages.ts, debate.ts,
   gates.ts, workflow.ts (lifecycle handlers), supervisor.ts (tick loop, leases, recovery, shutdown), release.ts + util/zip.ts.
2. github/client.ts (REST+GraphQL), github/sync.ts (idempotent issues/sub-issues/dependencies/projects/PRs/releases).
3. web/server.ts + web/ui (dashboard), cli/main.ts (setup, doctor, providers status, start, status, pause, resume, stop, logs,
   release, approvals, backup, restore, uninstall), deploy/install.sh, deploy/systemd unit.
4. `npm run build` until clean; tests in test/ with node:test: unit + simulated E2E scenarios A–F.
5. Live: run a small demo goal end-to-end with real Claude (+ Codex after 07:08 UTC reset): question/answer both ways,
   cross-review, debate. Keep low cost (haiku/sonnet, low effort).
6. Docs: ADRs, architecture, security, operations, troubleshooting, oracle, cloud assessment, acceptance matrix, limitations.
7. Self-package release ZIP + checksums; verify clean install in a container.

## Scheduled continuations
- Hourly auto-resume task "Resume orchestrator build" (delete it when the mission is complete).
- One-off at 07:12 UTC: live Codex verification after its usage reset.

## Repository governance (operator instruction, 2026-11-27)
- The operator delegated ownership of this repo to the agents: open/maintain issues, labels, epics, PRs; merge as needed.
- Every merge requires an independent review subagent first (review the actual diff; approve or list required changes).
  Address findings, then merge. Never merge on the implementer's own assertion.
- Tracking: epic issue per milestone ("[Mx] …") with task sub-issues; update `status:*` labels and close tasks with evidence.
- PR #1 (branch claude/autonomous-engineering-orchestrator-ocqm2i → main) is open; after it merges, restart the branch
  from the latest main for the next PR.
