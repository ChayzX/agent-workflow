# Security

The orchestrator is a privileged automation system: it holds GitHub credentials, runs code written by models, and can
merge and publish. The design assumes **every model output and every repository byte is untrusted**.

## Assets
GitHub token · provider subscription sessions (inside the CLIs' own config dirs) · operator's other repositories ·
the host (including the unrelated Pantry Bot infrastructure) · release integrity · audit trail.

## Threats and controls

| Threat | Control (enforced in code / OS, not prompts) | Verified by |
|---|---|---|
| Prompt injection via repo files, issues or messages makes an agent push, merge, exfiltrate or skip checks | Agents have no GitHub/cloud credentials, and the supervisor alone pushes and merges. Gates decide pass/fail from exit codes. Findings close only through independent verification. Approvals are needed for consequential actions. | `test/e2e.test.ts`, `unit: env scrubbing` |
| Agent reads secrets from the environment | Allowlisted agent environment; `GITHUB_TOKEN`, `AWS_*`, `*_SECRET*`, SSH agent and API keys removed | `unit: security` |
| Gate or verification command (untrusted) reads credentials, writes outside the worktree, or calls home | bubblewrap: `--unshare-all` (no network), real home and orchestrator home replaced by tmpfs, only the worktree writable, `--die-with-parent` | `unit: sandbox (bubblewrap)` |
| Silent switch to paid API billing | API keys stripped. Claude `apiKeySource` and Codex account-type guards abort the run and create a spending approval. | `unit: claude adapter billing` |
| Duplicate or unauthorized merges | Exact-commit invariant (gated = reviewed = merged head). GitHub merge uses the `sha` precondition. A required human review becomes an approval and is never impersonated. | `github.test.ts` (409/405) |
| Self-review | `exclude_agents` hard constraint. Cross-provider preference, and same-provider fallback is recorded explicitly. | e2e assertion `selfReview == 0` |
| Secrets in releases | Forbidden-file rules and secret scan on the tree; build fails on hits; re-scan after clean extraction | release verification, `unit: secret scanning` |
| Zip-slip on extraction | Path resolution check rejects `..` and absolute names | `unit: zip` |
| Dashboard compromise | Loopback bind by default. Token hashed at rest. HttpOnly + SameSite=Strict session. CSRF header + Origin check. Strict CSP. Login rate limit. 256 KB body cap (413). `textContent`-only rendering. | `web.test.ts`, manual probe in acceptance matrix |
| Tampering with history | Goal baseline immutable (DB trigger). Audit log append-only (triggers) and hash-chained (`doctor` verifies). | `unit: db` |
| Runaway resource use | Concurrency caps (global, per project, per provider). Timeouts. Process-group kill. systemd `MemoryMax` and `TasksMax`. Disk check in `doctor`. | config validation |
| Touching unrelated repos / Pantry Bot | Repo allowlist (`security.allowedRepos`). Workspaces are managed clones only. OCI package refuses Pantry Bot namespaces (`deploy/oci/preflight.sh`). | `createProject` checks |

## Authorization model
Routine reversible work proceeds without prompts: planning, implementation, tests, reviews, merges into the project's
own default branch that satisfy gates and reviews, and local release packaging.

These require an operator approval (`orchestrator approvals`, or the dashboard):
- `production_deploy`
- `destructive_operation`
- `protected_infrastructure`
- `unrelated_repository`
- `credential_expansion`
- `additional_spending`
- `public_publication` (GitHub Release publication is opt-in via `github.allowPublishRelease`)
- `security_policy_change`
- `human_review_required`
- `provider_reauthentication`

## Residual risks (documented, not hidden)
- **Claude implementers' `Bash`** runs with the service user's permissions inside the worktree's cwd. It is not
  OS-sandboxed by the orchestrator. Mitigations are the dedicated unprivileged service account, the hardened unit
  (`ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths` limited to the data dir), and the scrubbed environment. For
  stronger isolation, enable Claude Code's sandbox through `providers.claude.extraArgs`
  (`["--settings", "{\"sandbox\":{\"enabled\":true}}"]`).
- **Without bubblewrap**, gate commands run unsandboxed (`doctor` warns about this).
- **The dashboard has a single operator role.** There are no per-user accounts.
- **HawkScan DAST was not run** in the build environment, because installing the hawk CLI was not permitted there. A
  manual probe of authentication, CSRF, headers, limits, traversal and throttling was run instead; see the acceptance
  matrix. Run `hawk scan` against the dashboard in your environment.

## Reporting
Open a GitHub issue with the `security` label for non-sensitive issues. For sensitive reports, contact the repository
owner privately.
