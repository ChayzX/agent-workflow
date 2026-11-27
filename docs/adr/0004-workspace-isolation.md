# ADR-0004: Bare managed clone + one git worktree per work item; supervisor-only integration

Status: Accepted (2026-11-27)

## Decision
- **Managed clone:** each project gets a bare clone (`repo.git`), an integration worktree on the default branch, and one
  worktree per work item (`wt/<KEY>`). Each worktree has its own branch and a recorded base commit. The operator's own
  checkouts are never touched.
- **Commits:** agents edit files only. The supervisor commits, so attribution is deterministic.
- **Conflict avoidance:** path-overlap detection, based on the plan's path hints, prevents conflicting concurrent work.
  Conflicts at merge time leave markers in the task worktree and become a remediation task.
- **Exact-commit merges:** the merged commit must equal the gated and reviewed commit.
  - The merged tree is re-gated before the default branch moves. Local mode does merge → gates → keep or reset; GitHub
    mode passes the PR merge `sha` precondition, then runs post-merge gates.
  - A clean update from the default branch keeps the review approval only when the item's patch-id is unchanged.
- **Credentials:** GitHub credentials are injected per git invocation through `GIT_CONFIG_*` env (never written to
  `.git/config`).

## Consequences
Worktrees are not security boundaries. Isolation comes from the provider sandboxes, scrubbed environments, bubblewrap for
gate commands, and the systemd hardening (ADR-0006).
