# Build checkpoint (founding Engineering Director log)

This file is the durable hand-off for the session building this platform. Update it at each
milestone boundary. Scheduled auto-resume reads "Next executable actions".

## Current milestone (updated 2026-11-28 06:00 UTC)
- The operator verification ran on real infrastructure (Ubuntu 24.04 VM, systemd, live GitHub `ChayzX/orch-acceptance`,
  HawkScan): `docs/evidence/operator-verification/REPORT.md`. Every major finding was confirmed in the code and fixed in
  PR #63, merged at 9275518 after REQUEST_CHANGES then APPROVE (the review caught a sandbox home-exposure regression).
- This branch: the PR #63 re-review follow-ups, plus the 0.1.1 release and CHANGELOG. `npm test` 69/69.
- The fixes have NOT been re-run on that infrastructure. The operator prefers using the tool on a real project over
  another test cycle.
- Next (operator direction, 2026-11-28):
  1. Run the orchestrator on the operator's real, large project, phase by phase (one milestone per goal), on the VM in
     GitHub mode. Fix what the run surfaces. The operator will share the project plan.
  2. Planned infrastructure integration: chasebot as the always-on control plane; the gaming PC (Windows 11 Home,
     Ryzen 9 7900X, 32 GB, RTX 4070 Ti) as a Wake-on-LAN burst worker; ephemeral VMs (VirtualBox + Terraform, being
     built by Codex; not pushed yet). Design rules:
     - only the supervisor runs Terraform, with a bounded module;
     - VMs are tied to task leases, have a TTL, and are reaped on recovery;
     - no provider credentials inside VMs;
     - VMs are network-isolated from the LAN and Pantry Bot.
  3. Proposed: a per-project session/token budget cap (no such cap exists yet).

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
