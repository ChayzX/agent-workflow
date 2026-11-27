# ADR-0007: Provider-reported resets, non-model probes, canaries and bounded backoff

Status: Accepted (2026-11-27)

## Decision
- **Reset source order:**
  1. a structured provider signal (Claude `rate_limit_event.resetsAt`, Codex `account/rateLimits/read`);
  2. parsed provider text ("try again at 7:08 AM", "resets 3:45pm", "resets Mon 12:00am");
  3. bounded backoff (15 m, 30 m, 1 h, 2 h, 4 h, 6 h).
  Resets are clamped to [1 min, 8 days].
- **Probes and canaries:**
  - **Codex:** while available, it is probed every 15 minutes at no usage cost, so work is never dispatched into a known
    exhausted window. After a reset passes, a probe confirms capacity before work resumes.
  - **Claude:** it has no free probe, so after a reset passes exactly one canary task runs. Success restores full
    concurrency; a limit failure escalates the backoff.
- **Interrupted tasks:** a task that hits a limit keeps its session, worktree and ownership, pinned to its provider. It
  fails over to another provider, with context rebuilt from checkpoints, only if the expected wait exceeds
  `routing.failoverAfterMinutes`.
- **Throttling and auth:**
  - Model-specific limits block only that model. Non-security tasks may move down a tier.
  - Short-term 429s set the provider to `throttled`, without changing the exhausted state.
  - Auth failures set `auth_required` and create an operator approval. A periodic CLI auth check clears it.
- **Nothing left to run:** when no provider can run, the supervisor sleeps until the earliest change and keeps all state.
