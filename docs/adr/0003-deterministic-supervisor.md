# ADR-0003: Deterministic supervisor with a durable task queue (no "keep going" model loops)

Status: Accepted (2026-11-27)

## Context
Autonomy must survive crashes, restarts, usage exhaustion and multi-day waits without duplicating work or burning tokens.

## Options
1. An in-process tick loop over SQLite with leases, idempotency keys and compare-and-set transitions (chosen).
2. Temporal or another durable workflow engine. Strong guarantees, but it needs a cluster or server, which is heavy for a
   modest host.
3. A long-running "director" agent that keeps prompting itself. Fragile, expensive, and non-deterministic.

## Decision
- **State:** every lifecycle step is an explicit state transition on durable rows.
- **Tasks:** agent invocations are tasks with
  - an idempotency key (unique),
  - an atomic claim (`UPDATE … WHERE status='queued'`),
  - a lease and heartbeat, with the lease owner fencing every write,
  - bounded attempts and exponential backoff,
  - a failure class that decides whether the retry budget is spent. Capacity and interruption events never spend it.
- **Outcomes** are stored before they are handled (`processed` flag), so a crash replays the handler, never the agent.
- **Long deterministic work** (git, gates, merges, packaging) runs as keyed jobs off the tick.
- **No model is called for** scheduling, routing, validation, retries, dependency resolution or gate evaluation.

## Consequences
- **Restart safety:** recovery requeues tasks owned by dead instances, pinned to their session provider so they resume
  natively. It also reaps orphan processes, verified by `ORCH_TASK_ID` in `/proc/<pid>/environ`, and repairs interrupted
  git operations.
- **Scaling:** a single supervisor per data directory is enforced by a lock file. Horizontal scale is not a goal.
