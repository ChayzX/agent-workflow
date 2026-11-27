# Known limitations (v0.1.0)

Stated plainly so nothing is over-claimed. See `docs/acceptance-matrix.md` for what is verified, simulated or unverified.

## Integration
- **GitHub mode was not exercised against the live GitHub API in the build environment.** The session's GitHub access
  was a repository-scoped proxy token, which the REST API rejects (HTTP 401), so the orchestrator could not use it.
  The REST/GraphQL client and sync are contract-tested against an in-memory fake covering issues, sub-issues,
  dependencies, Projects v2 fields, PRs, checks, merges and releases. The live acceptance steps are in
  `docs/live-acceptance.md`.
- **Fine-grained PATs cannot manage user-owned Projects (v2)** (a GitHub limitation). Use a classic PAT with `repo` and
  `project` scopes for personal repositories.
- **Cloud execution (Codex Cloud, Claude Code cloud) is assessed but not implemented as an adapter.** See
  `docs/cloud-assessment.md`.
- **Oracle Cloud deployment is prepared** (manifests, IAM examples, preflight) **but was never run** against a real
  tenancy.
- **Claude exposes no usage-free capacity probe.** After a reset, one canary task confirms capacity. Codex is probed
  through `codex app-server` at no usage cost.
- **Usage-limit message formats change over time.** Structured provider signals are preferred; text parsing is the
  fallback, with fixtures from real output. Unknown formats fall back to bounded backoff (15 min to 6 h), never to a
  tight retry loop.

## Execution model
- **One supervisor per data directory, single node.** There is no high-availability failover between hosts; recovery
  works by restarting on the same host or restoring a backup.
- **Path-hint conflict avoidance depends on plan quality.** Real merge conflicts are still handled through remediation.
- **Debates and audits use bounded rounds**, so a determined disagreement ends with the decision owner's ruling,
  recorded with its rationale. Unresolved security-critical objections block the decision instead.
- **Completion audits may be conservative.** A requirement either auditor marks unsatisfied becomes work. After 6 failed
  audit rounds the project is blocked for operator review instead of looping.
- **Requirement verification is limited to auditors plus deterministic gates.** Gates prove only what the project's tests
  prove, and auditors cannot verify behavior that has no observable evidence.
- **Clean-environment verification** of a release runs the declared `verify_commands` in a fresh directory inside
  bubblewrap. It is not a fresh VM or container image; the build host had no container daemon.

## Security
- **Claude implementers' `Bash` tool is not OS-sandboxed by the orchestrator.** Use the dedicated service account and
  the hardened unit, or enable Claude Code's sandbox through `extraArgs`; see `docs/security.md`.
- **The dashboard has a single operator token** and no RBAC. Keep it on loopback or behind TLS.
- **HawkScan DAST was not run in the build environment** (installing the CLI was not permitted there). A manual probe of
  authentication, CSRF, headers, input limits, traversal and throttling was run, and two issues it found were fixed.

## Product
- The dashboard is functional and accessible-minded (semantic HTML, keyboard tabs, focus styles, `aria-live`, contrast
  tokens). It has not had a formal WCAG audit.
- Metrics are only what providers report. Claude reports cost estimates; Codex reports tokens. No balances or costs are
  estimated by the orchestrator.
