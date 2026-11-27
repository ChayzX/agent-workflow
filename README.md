# Agent Workflow Orchestrator

A self-hosted, persistent supervisor that turns **one natural-language product goal** into a planned, implemented,
independently reviewed, tested, audited and **packaged** product, using **OpenAI Codex** and **Anthropic Claude Code** as
first-class agent providers on your own subscriptions.

```
orchestrator setup
orchestrator start --goal examples/goals/wordfreq-cli.md --repo new
orchestrator status          # or open the dashboard: http://127.0.0.1:7420/
orchestrator release         # verified ZIP + SHA-256 when the completion audit passes
```

GitHub Issues and Projects are the source of truth for requirements and work tracking (GitHub mode). A purely local git
mode exists for trying it without GitHub.

---

## How it works (the mental model)

Think of it as **a small engineering company with a very strict operations manager**:

| Company role | In this system |
|---|---|
| The operations manager who never sleeps and never improvises | The **supervisor**: deterministic code with a durable SQLite database. It schedules, enforces policy, runs tests, merges, and never "asks a model to keep going". |
| Specialist employees hired per project | **Agents**: an Engineering Director, Architect, Backend/Frontend engineers, Security engineer, Reviewer, QA, Docs, and so on. Each assignment is a fresh, bounded invocation of `codex exec` or `claude -p` with its own working copy. |
| Contractors from two agencies | **Providers**: Codex and Claude Code. Work is routed between them by availability, reliability and load. Reviews are deliberately given to *the other* agency. |
| Ticket system | **GitHub Issues + Projects** (requirements → work items as sub-issues, with dependencies, milestones, priorities and status fields). |
| Desks, so people don't overwrite each other | **Git worktrees**: one branch and directory per work item, created from a recorded base commit. |
| Internal mail | **Durable message bus**: an agent that needs an answer posts a question, *gives up its desk* (no model usage while it waits), and is resumed when the answer arrives. |
| Design reviews | **Bounded debates** for material decisions: propose → independent evaluation (both providers) → rebuttal → final positions → decision owner rules. Security objections must be explicitly resolved. The result is an ADR. |
| Building inspector | **Deterministic quality gates**: real test/lint/build commands with recorded exit codes. An agent cannot talk its way past a failing test. |
| Final walkthrough before handover | **Independent completion audit** by both providers, cross-checked against gate results and open findings. Failing it reopens development automatically. |
| The handover box | A **versioned ZIP** built from the exact audited commit, with manifest, checksums, SBOM, test evidence, security assessment, release notes, limitations and rollback steps. It is verified by extracting it into a clean directory and running its documented install commands. |

### A real example (from the live run on 2026-11-27)

At 04:59 UTC the operator submitted the `wordfreq` goal. In order:

1. The supervisor started. Before spending any model usage, its Codex capacity probe (`codex app-server` →
   `account/rateLimits/read`) reported the 5-hour window at **100%, resetting at 07:08:04 UTC**. Codex was marked
   *exhausted* with that provider-reported reset time.
2. Planning went to Claude, which produced requirements, work items, a dependency graph and quality-gate commands.
3. W-001 was implemented by Claude Haiku in its own worktree. The supervisor committed the change and ran the gates
   (`tests`, `syntax check`, `install verification`, `secret-scan`), and they passed.
4. Review was routed *away from* the implementer. With Codex exhausted it fell back to a different Claude agent and
   recorded it as `same-provider review (cross-provider unavailable)`, so nothing is hidden.
5. When the Codex window reset, Codex resumed taking work automatically. No human intervened.

See `docs/acceptance-matrix.md` for the evidence trail.

---

## Lifecycle

```
goal ─▶ plan (requirements, work items, gates) ─▶ debates for material decisions
     ─▶ per work item:  worktree ─▶ implement ─▶ commit ─▶ GATES ─▶ independent review(s)
                                     ▲                     │fail          │findings
                                     └────── remediation ◀─┴──────────────┘
                         ─▶ verified-fix review ─▶ merge (exact reviewed+gated commit, merged tree re-gated)
     ─▶ periodic integration audits ─▶ completion audit (both providers + deterministic checks)
     ─▶ release ZIP ─▶ clean-room install verification ─▶ GitHub Release / local download
```

Every arrow is a compare-and-set state transition in SQLite. Every spawned task has an idempotency key. Restarts, crashes
and usage-limit waits resume from durable state; nothing is duplicated.

## Usage limits, the release-blocking feature

- Each provider has **independent availability state**: `available`, `exhausted` (with reset time), `throttled`,
  `recovering` (canary), `auth_required`, `disabled`.
- **Reset times come from the provider whenever it exposes them.** For Codex that is `account/rateLimits/read` and the
  "try again at 7:08 AM" message. For Claude it is the `rate_limit_event.resetsAt` field. When neither is available, a
  bounded backoff is used (15 min → 6 h). Exhausted providers are **not polled**.
- When an agent hits a limit, its session id, worktree, task ownership and pending messages are kept. The task waits for
  its own provider: Claude and Codex both resume natively with `--resume` / `exec resume`. If the wait exceeds the
  failover threshold (default 30 min), the task fails over to the other provider, and its context is rebuilt from
  durable checkpoints rather than by replaying the conversation.
- **When both providers are exhausted**, the supervisor keeps running, keeps everything persisted, and sleeps until the
  earliest reset.
- **Authentication expiry is handled separately.** The operator is asked to re-authenticate, and a periodic CLI auth
  check (no model usage) restores the provider.
- **API billing is never used silently.** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are stripped from agent
  environments. If Claude reports `apiKeySource` ≠ `none`, or Codex reports an API-key account, the run is aborted unless
  you explicitly set `providers.<id>.allowApiKeyBilling`.

## Security posture (short version)

- The supervisor alone holds GitHub credentials and alone commits, pushes and merges. Agents get a scrubbed environment:
  no GitHub token, no cloud credentials, no API keys.
- Reviewers and auditors run read-only: Claude with read tools only, Codex with `-s read-only`.
- Gate commands come from the plan or repository, so they are treated as untrusted. They run in **bubblewrap** when it is
  available: no network, real home and orchestrator data hidden, writes limited to the worktree.
- Repository content, issues, tool output and agent messages are untrusted data. Policies are enforced in code
  (approvals, allowlists, protected paths, exact-commit merges), not in prompts.
- Consequential actions go to a hash-chained, append-only audit log. Required human reviews on GitHub are respected and
  never impersonated.

Full details: `docs/security.md`.

## Install

Requirements: Linux, Node.js ≥ 22.13, git, tar. bubblewrap is optional but recommended. Zero runtime npm dependencies.

```bash
./deploy/install.sh          # guided: checks OS/deps, links the CLI, detects providers, runs setup, optional service
# or manually:
npm ci && npm run build && ./bin/orchestrator setup --service
claude login                 # Claude Pro/Max subscription (or: claude setup-token)
codex login --device-auth    # ChatGPT plan (headless-friendly)
orchestrator doctor
```

## Commands

| Command | Purpose |
|---|---|
| `setup [--service]` | Config, dashboard token, database; optional systemd user service |
| `doctor` | OS, Node, git, sandbox, config perms, DB integrity, audit chain, providers/auth/billing mode, GitHub token |
| `providers status [--probe]` | Availability, reset times, provider-reported windows; `--probe` runs usage-free checks |
| `start --goal F --repo R` | New project from a goal (`R` = `owner/name`, a local git path, or `new`) |
| `status`, `tasks`, `messages`, `decisions`, `logs [--follow]` | Inspect real persisted state |
| `pause`, `resume`, `stop` | Project control (queued to the supervisor) |
| `unblock ITEM --note TEXT` | Return a wrongly blocked work item to ready, with guidance the next agent sees (audited) |
| `cancel ITEM --note TEXT` | Descope a work item (operator decision, audited; local equivalent of closing its issue as not planned) |
| `approvals [approve\|deny ID]` | Operator authorizations (spending, re-auth, human review, deploys…) |
| `release [--out DIR]` | Verified release ZIP location / export |
| `run` / `daemon` | Foreground supervisor + dashboard (systemd runs `daemon`) |
| `backup`, `restore`, `upgrade`, `uninstall [--purge --yes]`, `dashboard-token`, `self-package` | Operations |

## Documentation

- `docs/architecture.md`: components, state machines, data model, context strategy
- `docs/adr/`: architecture decision records
- `docs/providers.md`: provider capability matrix, auth, usage-limit signals, policy notes
- `docs/security.md`: threat model and controls
- `docs/operations.md` · `docs/troubleshooting.md`: runbooks
- `docs/cloud-assessment.md`: Codex Cloud / Claude Code cloud / hybrid execution
- `docs/oracle.md` + `deploy/oci/`: scoped Oracle Cloud deployment preparation
- `docs/acceptance-matrix.md`: requirements-to-evidence matrix (what is verified, simulated or unverified)
- `docs/limitations.md`: known limitations

## Status

**v0.1.0.** The build was merged after five rounds of independent agent code review, which found 24 defects, all fixed
with regression tests. `npm test` passes 52 of 52.

- **Verified live:**
  - A complete product, `wordfreq`, built autonomously from one goal by real Claude agents. Verified release:
    `docs/evidence/wordfreq-live/`.
  - Codex usage-limit detection with provider-reported reset times.
  - Real Claude limit exhaustion with both providers out, followed by staggered recovery.
  - Graceful restart.
  - Confined agent sandbox.
  - Dual-provider collaboration on `greet` (`docs/evidence/greet-dual-provider/`):
    - Codex and Claude asked each other questions in both directions.
    - Each reviewed the other's code, and they debated a design decision into an ADR.
    - They ran concurrently.
    - When Codex hit a real usage limit, the work failed over to Claude.
    - The run recovered from a crash, and operator unblock/cancel commands were used.
    - The result was a verified release.
- **Verified with simulated providers:** duplicate prevention, plus the GitHub sync against a fake GitHub.
- **Pending (needs the operator; issues labelled `needs-operator`):** GitHub mode against the live API (needs a PAT),
  a fresh-VM install, systemd on a real host, HawkScan DAST, OCI deployment. The run book for a local agent with server
  access is `docs/operator-verification-prompt.md`.

Details: `docs/acceptance-matrix.md`.
