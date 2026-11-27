# Requirements-to-evidence matrix

How to read the Status column:
- **✅ live:** verified against the real provider CLIs and real subscriptions in this environment.
- **✅ sim:** verified by deterministic automated tests. Providers are simulated, but git, worktrees, gates, sandbox,
  SQLite and packaging are real.
- **⏳ pending:** a live run is scheduled or needs operator credentials. The procedure is in `docs/live-acceptance.md`.
- **❌:** not done.

Automated suite: `npm test` passes 52 of 52 (`test/unit`, `github`, `web`, `e2e`, `recovery`, `regression`).

Live evidence on 2026-11-27 comes from the wordfreq run: a single goal, real Claude agents, with Codex exhausted for its
whole duration. The redacted timeline is in `docs/evidence/wordfreq-live/events.log`. The verified product ZIP and its
`.sha256` are in the same directory.

## A. Installation and operation
| Requirement | Evidence | Status |
|---|---|---|
| Installs in a clean Linux environment | Self-package ZIP extracted to an empty directory with a scrubbed environment (`env -i`). The CLI runs with no `npm install`; `setup`, `doctor`, then `npm ci && npm test` (28/28 at the time). | ✅ live (clean directory; no fresh VM was available, see limitations) |
| Guided configuration initializes a working service | `orchestrator setup` writes config (0600) and the DB, detects both CLIs, checks auth, and generates the dashboard token. `run` starts the supervisor and dashboard. The systemd units are in `deploy/systemd` (not exercised: no systemd in the container). | ✅ live / ⏳ systemd |
| A project starts from one goal | `orchestrator start --goal examples/goals/wordfreq-cli.md --repo new` → plan with 13 requirements and 9 work items → completed with verified release 0.1.0 | ✅ live |
| Dashboard and CLI reflect actual state | `status`, `logs` and `release` output, and `/api/overview` and `/api/projects/:id` read the DB only (`test/web.test.ts`, and the live dashboard on :7420 during the run) | ✅ live |

## B. Independent provider execution
| Requirement | Evidence | Status |
|---|---|---|
| Claude Code executes real tasks | 66 real `claude -p` sessions: plan, implement, review, security review, answer, investigate, integration and completion audits | ✅ live |
| Codex executes real tasks | Live run 2 (2026-11-27, `docs/evidence/greet-dual-provider/`): Codex completed 7 implement, 6 remediate, 8 review, 2 security_review, 5 verify_fix, 8 answer, 1 debate_propose and 1 completion_audit tasks, with native `exec resume` after yields. It then hit a real usage limit with a provider-reported reset (15:12 UTC), and Claude continued the work. | ✅ live |
| Both providers concurrently in isolated worktrees | Live run 2: W-001/W-002 and defects D-001..D-006 were worked by Claude and Codex at the same time, in separate worktrees (`maxConcurrent` 1 per provider, 2 overall). | ✅ live; ✅ sim (`e2e`) |
| Agents resume or reconstruct sessions | Live: `remediate W-007 → claude/haiku (resume)` after an `invalid_output` failure, which was a native `--resume`. Sim: killed/hung agent resumed after a crash; failover reconstruction. | ✅ live + ✅ sim |

## C. Collaboration
| Requirement | Evidence | Status |
|---|---|---|
| Codex asks Claude / Claude asks Codex | Live run 2: Claude-run agents asked and Codex answered (10:57:51 W-002 shout form, 10:57:55 W-001 greeting, and later). A Codex-run agent asked and Claude answered (11:15:25, D-006). The asking task yielded its slot and resumed its own session after the answer (`task.waiting_message` → `task.resumed`). | ✅ live (both directions); ✅ sim |
| Evidence-based debate with both providers | Live run 2: Codex proposed ADR-001 (README format), Claude agents evaluated it (2 positions), and Claude decided: "a single Usage section with one labeled example per function". W-003 was implemented to the ADR, and the completion audit checked it. Sim: a security objection, rebuttal, final round and documented resolution. | ✅ live; ✅ sim |
| Decisions and communications survive restarts | Live: graceful SIGTERM restart at 05:03 mid-run, with messages and decisions intact. Sim: restart while waiting for capacity. | ✅ live + ✅ sim |

## D. GitHub and development
| Requirement | Evidence | Status |
|---|---|---|
| Issues, dependencies, project statuses created and managed | `test/github.test.ts` against a fake GitHub: labels, milestones, requirement issues, sub-issues, `blocked_by` dependencies, Projects v2 fields, re-sync and crash-replay idempotency, external reconciliation. The live API was unavailable here (the repo-scoped proxy token is rejected by REST). | ✅ sim; ⏳ live (`docs/live-acceptance.md` §2) |
| Parallel implementation without overwriting work | Live: 15 work items in per-item worktrees, 2 agents at a time, 56 merge-gate runs, conflict path exercised (README conflict remediated) | ✅ live |
| Providers review each other's code | Live run 2: Codex reviewed Claude's work (W-001, W-002, D-001, D-003, D-005, D-006: reviews, security reviews, verify-fix), and Claude reviewed Codex's (W-003, D-002, D-004). Codex's `request_changes` drove real remediation rounds. When Codex was exhausted, the fallback was recorded as "same provider as excluded (cross-provider unavailable)". | ✅ live; ✅ sim |
| Deliberate defect detected and remediated | Sim: W-001 `add` subtracts, real `node --test` fails, remediation, pass. Sim: missing negative test → medium finding → fix → `verify_fix` by the reviewer. Live: audits created D-001…D-006, all remediated or handled. | ✅ sim + ✅ live |
| Independent verification and real CI prevent premature merge | Exact-commit invariant (gated = reviewed = merged). PR merge uses the `sha` precondition. CI `failure` → remediation. Required human review → approval, never impersonated (`github.test.ts`). | ✅ sim; ⏳ live CI |

## E. Autonomous recovery
| Requirement | Evidence | Status |
|---|---|---|
| Terminate an active agent, verify recovery | Sim: `killed` failure retried and resumed; hung agent recovered after lease expiry. Real process-group termination covered in the Codex adapter test (abort → `interrupted`, session id kept). | ✅ sim |
| Restart the supervisor, verify continued execution | Live: SIGTERM at 05:03:24 → in-flight security review finished within the grace period → new supervisor at 05:03:41 → run completed | ✅ live |
| Codex exhaustion → Claude failover | **Live:** Codex exhausted for the whole run (probe at 04:59:06, reset 07:08:04 provider-reported). All work ran on Claude, and Codex was never called while exhausted. Sim: same, plus recovery via the non-model probe. | ✅ live + ✅ sim |
| Claude exhaustion → Codex failover | Sim (`recovery.test.ts`). Live: Claude hit its real 5-hour limit at 05:10:13 while Codex was also exhausted (see the next row). | ✅ sim |
| Simultaneous exhaustion | **Live:** 05:10:13–05:11:43 both exhausted. Project kept `waiting for provider capacity`, nothing failed, no polling. Sim: no calls for 2 h of simulated time. | ✅ live + ✅ sim |
| Staggered resets, automatic continuation | **Live:** Claude reset first → `recovering` → canary → `available` 05:11:55 → work continued while Codex stayed exhausted to 07:08. Sim: Codex resets first and resumes before Claude. | ✅ live + ✅ sim |
| Restart while waiting for capacity | Sim (`recovery.test.ts`) | ✅ sim |
| No duplicate issues, tasks, branches or PRs | Unique idempotency keys (asserted in sim). GitHub marker-based crash replay (`github.test.ts`). One branch per item. | ✅ sim |
| Pending communications and findings preserved | Durable `messages` and `findings` tables. Asker resumes after restart (sim). | ✅ sim |

## F. Completion and delivery
| Requirement | Evidence | Status |
|---|---|---|
| Audits detect incomplete requirements | **Live:** completion audit round 1 found R-006 unsatisfied (the agreed U+2019 rule was not implemented) and docs drift, creating D-004 to D-006 | ✅ live |
| Failed audits reopen development | **Live:** project went back to `active`, defects were implemented, reviewed, merged, and re-audited | ✅ live |
| Remediated requirements independently verified | **Live:** round 4 passed with 2 auditors on commit 5927b11b. Requirements are marked verified only by the audit. | ✅ live |
| Release ZIP generated automatically | **Live:** `wordfreq-0.1.0.zip`, sha256 `a50a35e5608a75fd…`: manifest, SBOM, test evidence, security assessment, requirements matrix, release notes, limitations, rollback, original goal | ✅ live |
| Dual-provider completion audit and release | **Live run 2:** audit rounds 1 and 2 used Claude + Codex. Round 2 found a concrete CRLF install defect, which was fixed. Round 3 passed with Claude + Claude, because Codex was exhausted (recorded failover); in round 3 an auditor ran `node --test` itself. Release `greet-0.1.0.zip`, sha256 `02993441…`, independently re-verified (11 pass, 0 fail, 5 git-dependent skips). | ✅ live |
| Package integrity and secret exclusion verified | Orchestrator: per-file checksums after clean extraction plus a re-scan. Independent re-check: `sha256sum -c` OK; `npm ci && npm test` → 97/97 in a clean directory; CLI behaviour spot-checked (`--json`, exit 2, stdin, ties). | ✅ live |
| Clean-environment installation succeeds | As above (release `verify_commands` run inside bubblewrap) | ✅ live |
| Package accessible to the operator | `orchestrator release`, the dashboard download link, and `docs/evidence/wordfreq-live/` | ✅ live |

## Independent review of this platform (PR #1)
An independent reviewer agent ran several rounds:
- **Round 1:** 12 defects (6 high, 3 medium, 3 low), most reproduced against the real supervisor. All fixed with
  regression tests in `cc58de6`.
- **Round 2:** confirmed 9 of the 12 fixes and found 6 more issues (N1 high: git-metadata sandbox escape; N2–N5 medium;
  N6 low). All fixed with regression tests in `2faadd4`. Verified live: a confined `claude -p` agent could not read
  orchestrator secrets or rewrite `.git`, and could still write its worktree.
- **Round 3:** in progress.

## Not yet verified
- Live GitHub mode, needing a classic PAT; see the procedure.
- Live Codex task execution and cross-provider Q&A, debate and review: scheduled after the 07:08 UTC Codex reset.
- systemd on a real host.
- HawkScan DAST (CLI install not permitted here).
- A fresh-VM install.
- Live OCI deployment (prepared only).
