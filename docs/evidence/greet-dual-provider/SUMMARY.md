# Live dual-provider acceptance: `greet` (run 2, 2026-11-27 10:57–12:06 UTC)

Real `codex exec` (ChatGPT Plus) and real `claude -p` (Claude subscription, `apiKeySource: none`) were driven by the
supervisor from a fixed three-item plan (`test/live/live-acceptance.ts`). Cheap models were used (haiku/sonnet, low
effort). The project ended **COMPLETED** with a verified release. **It completed with operator help, on four
successive builds** (see "Builds used" below). It is evidence of the capabilities listed here, not of an unassisted
run on one build.

- Release: `greet-0.1.0.zip`, SHA-256 `029934413bd18d3ca0ea60e417cb3992319a10b729a3f6724aa0341c8f3899f2`
  (`greet-0.1.0.zip.sha256`).
- Full event log: `events-run2.log`. The rate-limit debug lines are omitted; nothing else was filtered.
- Run 1, which stalled and led to fixes: `events-run1-stopped.log`.

## Builds used (the run was used to find and fix orchestrator defects)

The supervisor was restarted onto newer builds while the project's state persisted. Each restart is also the
recovery evidence listed below.

| From (UTC) | Build | How the switch happened |
|---|---|---|
| 10:57:45 | da2b85f | Start, through the live harness |
| 11:21:01 | Code committed as 4905b9b (gate `repo.git`, auditor file reading) | Harness killed (crash), then `orchestrator run` |
| 11:51:19 | Same build | The background job hit its time limit, then a restart |
| 11:58:53 | fae4daf, which includes 77d2688 (audit verdicts, read-only Claude Bash, operator `unblock`) | Graceful SIGTERM, then restart |
| 12:03:39 | 456fc53 (operator `cancel`, no tracking state in repositories) | Graceful SIGTERM, then restart |

Completion depended on two operator actions using commands that did not exist when the run started:
`unblock D-007` (11:58:53) and `cancel D-008` (12:03:39). The final head of this PR has not been run live
end to end. A fresh run on one build is the next measurement.

## Independent re-verification (after the run, outside the orchestrator)
- `sha256sum -c greet-0.1.0.zip.sha256`: OK.
- `node --test` in the extracted ZIP: 16 tests, 11 pass, 0 fail, 5 skipped. The skipped ones are the git-dependent
  install tests, which skip outside a git checkout.
- `hello("Ada")` returns `Hello, Ada!` and `shout("hi")` returns `HI`. Both match the answers the product_manager gave
  to the agents' blocking questions.

## What was observed

| Capability | Evidence (times UTC) |
|---|---|
| Claude asks, Codex answers | 10:57:51 W-002 "HI or HI!?"; 10:57:55 W-001 "Hello, Ada! or Hi Ada?" (and later) |
| Codex asks, Claude answers | 11:15:25: a D-006 Codex agent asked `engineering_director` (log line 217), and the task yielded its slot (`task.waiting_message`). Claude answered at 11:15:44, and the Codex task resumed its own session. |
| Debate leading to an ADR | Codex proposed ADR-001, two Claude agents evaluated it, and Claude decided "single Usage section". W-003 followed it, and the audit checked it. |
| Cross-provider review | Codex reviewed Claude's W-001, W-002, D-001, D-003, D-005 and D-006. Claude reviewed Codex's W-003, D-002 and D-004. Codex `request_changes` drove real remediation. |
| Concurrent execution | One task per provider ran at the same time, each in its own worktree. |
| Usage limit and failover | 11:30:20 Codex became `exhausted`. The reset of 15:12 UTC was parsed from Codex's "try again at 3:12 PM" (container clock is UTC); `provider.status` labels the window kind "(unknown)". Claude continued all work. The final audit's Codex slot failed over to a second, independent Claude agent (recorded as "failover from codex"). |
| Crash recovery | 11:20 the harness process was killed. `orchestrator run` resumed: 2 tasks requeued, 0 orphans, both sessions resumed **natively** (log lines 262–264). Later SIGTERM restarts (11:51, 11:58, 12:03) lost no durable state. At 11:51 one in-flight read-only review was reported `killed` and re-run fresh instead of resumed, which is a gap to investigate. |
| Operator controls | `unblock D-007 --note …` (11:58:53) and `cancel D-008 --note …` (12:03:39). Both are in the audit log. Prompts are not logged, so delivery of the unblock note to the next agent is shown by the regression test (`operator can unblock a wrongly blocked item; guidance reaches the agent`), not by this log. |
| Completion audits | Round 1 (11:00) failed and round 2 (11:26) failed on a concrete CRLF defect. Round 3 (12:05) passed. In round 3 one auditor's structured output reports that it ran `node --test` (16 pass). That claim comes from the agent's own output in the `tasks` table, not from the event log; it is consistent with the supervisor's passing gate on the same commit. |

Successful tasks: 177 on Claude, 52 on Codex. 190 messages, 19 of them questions.

## Defects this run exposed in the orchestrator, all fixed with regression tests
1. The gate sandbox hid the shared `repo.git`, so project tests that use git failed only in gates (D-005 loop). It is
   now exposed read-only.
2. The audit prompt said "you cannot run commands", so Codex audited the summary instead of the files. Auditors are
   now told to read and cite files, and they get the tracked-file list. Codex then cited `src/hello.js:8–16`.
3. Boolean audit verdicts (`docs_accurate`, `install_reproducible`) were turned into vague work items (D-004, D-005,
   D-008, D-009). They now only summarize concrete defects, and a bare `false` counts as an unsupported decline.
4. Read-only Claude reviewers could not run tests, while Codex read-only reviewers could. Claude may now use Bash
   when bubblewrap enforces read-only.
5. An investigation blocked D-007 for non-external reasons. The prompt now defines what is not an external blocker,
   and the new operator `unblock` and `cancel` commands handle mistakes.
6. Agents wrote orchestration state into the product (`docs/defect-reconciliation.md`, with SHAs and test counts),
   which went stale on every commit and looped reviews. This is now forbidden by policy.
7. Killed-run messages included raw stream JSON. They now report the signal and stderr.

## Honest limitations of this run
- **Cost.** 239 agent sessions and about 3.0 M prompt characters for a two-function package. Defects 1–6 drove the
  cost, through meta-work loops on D-005, D-006 and D-008. A clean run on the fixed build should need a small
  fraction of that. This has not been re-measured yet.
- **The final audit was Claude + Claude** because Codex was exhausted. Rounds 1 and 2 were Claude + Codex.
- **The shipped product still contains `docs/defect-reconciliation.md`**, created before the policy fix. The final
  auditors judged it accurate. It is noise, not a functional defect.
- **The README says "Node.js 18 or later"** while the goal says Node ≥ 22. The auditors did not flag this. The
  package does run on 22.
- Run on a managed cloud host with `ORCH_LIVE_RELAX=claude`: Claude's login lives outside the service home, so other
  homes were visible to Claude agents, by recorded operator authorization. The orchestrator home stayed hidden.
