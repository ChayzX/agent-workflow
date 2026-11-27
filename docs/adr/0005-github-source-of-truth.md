# ADR-0005: GitHub Issues/Projects as the source of truth; SQLite for execution state

Status: Accepted (2026-11-27)

## Decision
- **Issues:**
  - Requirements become issues.
  - Work items become sub-issues of their requirements, with `blocked_by` dependencies, milestones, and priority/type
    labels.
  - Defects found by reviews, gates or audits become issues.
- **Project board:** a Projects (v2) board gets "Orchestrator Status" and "Orchestrator Priority" single-select fields,
  whose ids are discovered or created dynamically.
- **Pull requests** open after local gates and independent review. Merges respect branch protection: a required human
  review becomes an operator approval and is never impersonated.
- **Duplicate prevention:** each managed issue carries a hidden marker
  `<!-- orchestrator:v1 project=… kind=… key=… -->`. The local mapping table is only a cache, and marker search makes
  crash replays idempotent.
- **External changes are reconciled:**
  - closing an issue as "not planned" descopes the item (an authorized operator action, audited);
  - reopening an issue reopens the item.
- **Local data:** leases, sessions, messages, findings, gate runs and checkpoints stay in SQLite.

## Consequences
- **Token type:** fine-grained PATs cannot manage *user-owned* Projects (GitHub documents this gap). Use a classic PAT
  with `repo` and `project` scopes, or a GitHub App or fine-grained token for organization projects.
- **Optional board:** board sync failures degrade gracefully; issues and PRs still work.
