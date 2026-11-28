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
| Agent reads secrets from the environment, files or supervisor memory | Allowlisted agent environment (`GITHUB_TOKEN`, `AWS_*`, `*_SECRET*`, SSH agent and API keys removed), plus a bubblewrap agent sandbox: `$ORCH_HOME` and all homes hidden, own PID namespace, read-only shared repo | `unit: security`, `regression: review#5` |
| Agent plants git hooks or config to hijack an authenticated push | Hooks disabled for all supervisor git calls; repo config allowlisted before fetch/push; `--no-verify` push | `git.ts` (`sanitizeConfig`) |
| Symlink smuggles outside files into a release | `lstat` walkers; escaping links fail packaging and scanning; extraction refuses unsafe links | `regression: review#4` |
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
- **Agent processes are confined with bubblewrap when it is available** (`security.agentSandbox: auto`).
  - Hidden from them: every home directory, `$ORCH_HOME` (secrets, other projects, the shared repo config and hooks) and the supervisor's processes (own PID namespace).
  - Read-only: toolchains and the shared repository objects.
  - Writable: only their worktree, its git index directory, and the provider's own session and cache directories.
  - Network: kept.
  - **Without a working bubblewrap, no agent runs (fail closed).** The supervisor probes bubblewrap at start, inside its own service environment and with the same mounts and namespaces the sandboxes use, and records `security.sandbox_ok` or `security.sandbox_unavailable`; `doctor` reports that result. Only an explicit `security.agentSandbox: "none"` runs agents unconfined (scrubbed environment only), and that is audited at every start.
- **Worktree git metadata is never trusted.** Before every supervisor git operation on a worktree, the `.git` pointer,
  `gitdir`, `commondir` and `HEAD` are verified against values the supervisor recorded outside agent reach. Mismatches
  are repaired and audited as `security.git_tamper`. Git then runs with explicit `GIT_DIR`/`GIT_WORK_TREE`/
  `GIT_COMMON_DIR`; diffs use `--no-ext-diff --no-textconv`.
- **Agents see only their own provider's session directories.** Those providers' settings, hook and config files are
  read-only to agents. Supervisor-side CLI calls (version, auth status, the Codex app-server probe) run in the same
  confinement.
- **A startup self-check verifies each provider authenticates inside the sandbox, and it fails closed.** If
  authentication only works when other accounts' homes are visible (managed hosts that keep the login elsewhere), the
  supervisor does **not** widen access on its own. Instead it:
  - raises a `credential_expansion` approval;
  - marks the provider `auth_required`;
  - relaxes that one aspect only after operator approval, or when `security.agentSandboxRelaxFor` names the provider.
  The relaxation is audited. The recommended fix is to run `claude login` / `codex login` as the service user, so
  credentials live in its own home. `$ORCH_HOME` and the service user's home stay hidden in all cases.
- **Provider configuration agents could plant is read-only:**
  - Claude: `settings*.json`, hooks, plugins, agents, commands and skills.
  - Codex: `config.toml`, `hooks.json` and rules.
  - Missing files are created with neutral defaults first.
  - `~/.claude.json` must stay writable, so its `mcpServers` entries are snapshotted at startup, and any change during an
    agent run is reverted and audited.
- **Supervisor git operations** run with hooks disabled (`core.hooksPath=/dev/null`), `fsmonitor` off and `ext::` transport disabled. The shared repository config is reduced to an allowlist before every fetch and push, so agents cannot redirect authenticated pushes (`url.*.insteadOf`, `http.*`, `include.*`, credential helpers).
- **Gate backend.** `security.gateBackend` selects where gate and release-verification commands run: `local`
  (bubblewrap here) or `devvm` (a fresh VM per command on the gaming PC, `deploy/devvm/`). The choice is audited at
  every start and reported by `doctor`. The `devvm` executable must be a trusted file (absolute path, owned by root or
  the service user, nothing group/world-writable). If the VM host is unavailable, gates wait and retry; they never fall
  back to this host. Credentials found by the built-in scan block the export.
- **Without a working bubblewrap, gate commands do not run**: each gate is recorded as an error with the reason (fail closed). Only an explicit `security.sandbox: "none"` runs them unconfined.
- **The dashboard has a single operator role.** There are no per-user accounts.
- **HawkScan DAST was not run** in the build environment, because installing the hawk CLI was not permitted there. A
  manual probe of authentication, CSRF, headers, limits, traversal and throttling was run instead; see the acceptance
  matrix. Run `hawk scan` against the dashboard in your environment.

## Reporting
Open a GitHub issue with the `security` label for non-sensitive issues. For sensitive reports, contact the repository
owner privately.
