# Cloud and hybrid execution assessment

Sources: official docs and CLI help checked on 2026-11-27 (see ADR-0002 and the research notes in `docs/providers.md`).

| Mode | Status | Notes |
|---|---|---|
| Self-hosted supervisor on Debian/Ubuntu (systemd) | **Implemented, verified** (Ubuntu 24.04 container; live Claude + Codex CLIs) | the mandatory mode; no cloud dependency |
| Local agents via `claude -p` / `codex exec` | **Implemented, verified live** | subscription auth inside the official CLIs |
| Codex Cloud task execution (`codex cloud exec --env ENV_ID`) | **Unsupported in this release (documented path)** | Programmatic task creation exists in the CLI, but each task is a single agent run returning a diff, with agent internet off by default and secrets only in setup scripts. A long-lived supervisor cannot run there, and no public REST API for cloud tasks was confirmed. A future adapter could submit implementation tasks and import diffs. |
| Claude Code cloud sessions (`claude --cloud`, routines API trigger) | **Unsupported in this release (documented path)** | Sessions pause when idle and can be reclaimed, and background processes are not restored, so a supervisor cannot live there. Routines can be fired by API (research preview, rate-limited). A future adapter could dispatch tasks and collect results via PRs. |
| Running the orchestrator itself inside Codex Cloud / Claude cloud | **Unsupported** | no indefinite execution or persistent containers; not a prerequisite for anything |
| Hybrid: local supervisor + remote agents | **Designed for** (`ProviderAdapter` is transport-agnostic; `codex exec --remote` / app-server remote is available) | Not implemented: no remote adapter ships. Use outbound connections from the supervisor; never open inbound SSH to it. |
| Deployment of finished projects to Oracle Cloud | **Prepared, not executed** | `deploy/oci/` + `docs/oracle.md`; approval-gated, namespace-scoped, isolated from Pantry Bot |

## Why the supervisor stays self-hosted
Usage-limit recovery across days and weeks needs a process that outlives sessions, and both vendors' cloud agent
environments are explicitly session-scoped. The orchestrator therefore keeps the durable state and scheduling on the
operator's server and treats every agent invocation, local or remote, as a bounded, resumable task.
