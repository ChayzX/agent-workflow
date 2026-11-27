# Build checkpoint (founding Engineering Director log)

This file is the durable hand-off for the session building this platform. Update it at each
milestone boundary. Scheduled auto-resume reads "Next executable actions".

## Current milestone (updated 2026-11-27 05:58 UTC)
- PR #1 MERGED into main (a7673a9) at the exact independently approved commit 06a82ed, after 5 review rounds
  (24 findings, all verified fixed). Branch restarted from main; follow-up commit 7a6924b (non-blocking review item).
- `npm test` 44/44. Live wordfreq run completed with a verified release (docs/evidence/wordfreq-live).
- Remaining:
  1. ~07:12 UTC (scheduled wake): dual-provider live run:
     `ORCH_LIVE_RELAX=claude node --disable-warning=ExperimentalWarning dist/test/live/live-acceptance.js <scratchpad>/orch-live2`
     (ORCH_LIVE_RELAX documented: on this managed host Claude's login lives outside the service home.)
     Record cross-provider Q&A/review/debate/audit evidence in docs/acceptance-matrix.md (⏳ rows) + docs/evidence/.
  2. Self-package ZIP + .sha256 → commit under release/ (no release-creation tool available) and send to the user.
  3. Open PR #2 (follow-up + live evidence), independent review, merge.
  4. GitHub issue tracking update (agent running), then delete the hourly "Resume orchestrator build" task.

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
0. Finish live runs above; write docs/acceptance-matrix.md + docs/live-acceptance.md from evidence; self-package + clean-dir install verification; independent review subagent on PR #1, then merge.

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
