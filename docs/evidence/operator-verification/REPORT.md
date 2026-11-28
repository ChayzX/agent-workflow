# Operator verification report

This report covers `docs/operator-verification-prompt.md`, tested at commit `8ee27cb` of
`claude/autonomous-engineering-orchestrator-ocqm2i`. I ran it on 2026-11-27 and 2026-11-28 (UTC).

## Summary

| Issue | Title | Result |
|---|---|---|
| #48 | Installer script | **FAIL** |
| #45 | Clean-environment verification of the release | **FAIL** |
| #49 | systemd unit for the supervisor | **FAIL** |
| #53 | systemd hardening | **FAIL** |
| #29 | GitHub REST/GraphQL client | **FAIL** |
| #30 | Idempotent issue, sub-issue, dependency and project-field sync | **PASS** (with one gap, see below) |
| #31 | Pull requests with CI check gating and merge | **FAIL** (review and merge-SHA path passes; red-CI case NOT RUN) |
| #32 | Reconcile external GitHub changes | **FAIL** |
| #46 | Publish GitHub Release | **NOT RUN** |
| #52 | HawkScan DAST of the dashboard | **PASS** |
| #54 | Oracle Cloud deployment preparation | **NOT RUN** |

## Environment

| | |
|---|---|
| Physical host | `minecraftmachine`, Ubuntu 24.04.5 LTS, kernel 7.0.0-43-generic. Only used to run the VM. Nothing related to Pantry Bot was used or changed. |
| Test machine | A disposable QEMU/KVM VM built from the cloud image `ubuntu-24.04-server-cloudimg-amd64.img` (sha256 checked): Ubuntu 24.04.5 LTS, kernel 6.8.0-147-generic, 2 vCPU, 3 GB RAM, 20 GB disk. Its only network is user-mode networking with SSH on 127.0.0.1:2222. |
| Users | `orch` is unprivileged and runs everything. `vmadmin` is used only for the steps marked [sudo]. The system unit runs as the `orchestrator` system user. |
| node | v22.23.5 (official tarball, checked against SHASUMS256) |
| claude | 2.1.332 (Claude Code), logged in with the claude.ai subscription |
| codex | codex-cli 0.172.0, logged in with ChatGPT |
| bwrap | bubblewrap 0.9.0 |
| git / tar | 2.43.0 / 1.35 |

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` were never set.

**AppArmor prerequisite.** Ubuntu 24.04 ships with `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks
bubblewrap. With operator approval I installed `/etc/apparmor.d/bwrap`, which sets `userns,` and `flags=(unconfined)`
for `/usr/bin/bwrap` (see `A0-bwrap-apparmor.txt`). Neither the README nor `install.sh` mentions this step. Before
the fix, `npm test` gave 53 passes and 3 skips. After it, 56 of 56 passed (`A3-npm-test.txt` and
`A3b-npm-test-with-bwrap.txt`).

All evidence files are in this directory. Dashboard tokens, the PAT and the StackHawk key have been replaced with
`[REDACTED]`.

---

## #48 Installer script — FAIL

**Command:** `./deploy/install.sh`, run as the unprivileged `orch` user, with node installed system-wide under `/usr/local`.

**Result:** exit 243 (`A1-install.txt`). The script runs `npm install -g "$pkg"` (`deploy/install.sh:49`) for the
Claude and Codex CLIs. That fails for any non-root user whose npm prefix is root-owned, and `set -e` then stops the
script before it reaches setup:

```
npm error code EACCES
npm error syscall mkdir
npm error path /usr/local/lib/node_modules/@anthropic-ai
npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@anthropic-ai'
```

When I set `npm config set prefix ~/.local` first, the script exited 0 (`A1b-install-user-prefix.txt`). That
exposed the sandbox bug described under #49 and #53: bwrap hides `/home`, and the CLI symlinks in `~/.local/bin`
point into `~/.local/lib`, which is hidden. The result was `bwrap: execvp claude: No such file or directory`. To
continue, I reinstalled the CLIs under `/usr/local` with sudo (`A2-0-provider-reinstall.txt`). After that,
`orchestrator doctor` showed "All checks passed" (`A2-doctor.txt` and `A2-providers.txt`).

The installer also prints the dashboard token to stdout, so it ends up in any log the output is tee'd into.

**Needs a code change:** install the CLIs with a user-writable prefix, or skip them with a warning when the prefix
isn't writable. Don't print the token.

## #45 Clean-environment verification of the release — FAIL

**Steps (`A4-clean-room.txt`):**
- `orchestrator self-package` produced the ZIP with 167 files, and its own verification passed: exit 0.
- `sha256sum -c`: OK, exit 0.
- `unzip` into a clean directory: exit 0.
- I then followed the README Install section in an `env -i HOME=/tmp/cleanhome` shell.

**Result:** `./deploy/install.sh` exits 243 with the same EACCES error as #48. When I answered `n` to the CLI
installs, the script exited 0, but `orchestrator doctor` then exited 1 because the CLIs weren't installed. So the
documented procedure doesn't produce a working install for an unprivileged user on a stock host.

**Needs a code change:** the same installer fix as #48. The README should also mention the AppArmor
bubblewrap profile for Ubuntu 24.04.

## #49 systemd unit for the supervisor — FAIL

**What passed:**
- B1: the user service installs and starts. Linger is on (`Linger=yes`), and the unit is `active (running)` (`B1-service.txt`).
- B2: after `kill -9 23145`, systemd restarted the supervisor as PID 23600 with `NRestarts=1`, and the log shows `supervisor.recovered` (`B2-crash-restart.txt`).
- B3: after a VM reboot, the service was active at boot, before anyone logged in, with a new boot_id (`B3-reboot.txt`).

**What failed:** the agent sandbox doesn't work under the user unit. `deploy/systemd/orchestrator-user.service` sets
`PrivateTmp=yes`, which stops bwrap from creating a namespace inside a user manager. The supervisor then **fails
open**: it carries on without a sandbox instead of refusing to run agents.

```
2026-11-28 00:04:09Z warn  security.sandbox  agent sandbox unavailable (no bubblewrap): agents run with a scrubbed environment only

$ systemd-run --user --wait --pipe -p NoNewPrivileges=yes /usr/bin/bwrap --ro-bind / / --dev /dev --unshare-all true
exit=0
$ systemd-run --user --wait --pipe -p PrivateTmp=yes /usr/bin/bwrap --ro-bind / / --dev /dev --unshare-all true
bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.
exit=1
```

In a login shell, `orchestrator doctor` reports "bubblewrap sandbox works" for the same user, so doctor doesn't
catch this.

**Needs a code change:**
- Remove `PrivateTmp=yes` from the user unit, or replace it with something compatible.
- Make a missing sandbox stop agents from running (fail closed), or require an explicit opt-out.
- Have doctor check the sandbox from inside the unit.
- `src/security/sandbox.ts:136-180` (`wrapAgentCommand`) should also bind the real targets of CLI symlinks it finds on PATH.

## #53 systemd hardening — FAIL

**Steps (`B4-system-unit.txt`, `B4-analyze.txt`):** created the system user `orchestrator`, copied the code to
`/opt/orchestrator`, ran `orchestrator setup` as `orchestrator`, installed `deploy/systemd/orchestrator.service`
and enabled it. `systemd-analyze security` rates the unit **3.8 OK**. The supervisor runs, and doctor reports
"bubblewrap sandbox works".

**Result:** the gate sandbox that actually runs builds and tests fails under the unit. The self-check at
`src/security/sandbox.ts:49` runs bwrap without `--proc`, so it passes. The gate sandbox (`sandbox.ts:82`) uses
`--proc /proc`, and two of the unit's settings block that mount. I tested each restriction separately as transient
units with `User=orchestrator`:

```
--- bwrap under ALL [Service] restrictions of orchestrator.service combined (24 properties)
bwrap: Can't mount proc on /newroot/proc: Operation not permitted
exit=1
--- one restriction at a time, gate-sandbox flags (--proc /proc --tmpfs /tmp)
ProtectKernelTunables=yes -> rc=1 bwrap: Can't mount proc on /newroot/proc: Operation not permitted
ProtectKernelLogs=yes -> rc=1 bwrap: Can't mount proc on /newroot/proc: Operation not permitted
(all other 14 restrictions -> rc=0)
```

I didn't loosen the unit. I disabled it again afterwards.

**Needs a code change:** drop `ProtectKernelTunables` and `ProtectKernelLogs`, or change how the gate sandbox mounts
`/proc`. Make the self-check run with the same flags as the gate sandbox.

---

## Section C setup (applies to #29–#32)

- **Repository:** `ChayzX/orch-acceptance`. The operator created it, and I added `.github/workflows/ci.yml` (job `npm test`, commit 2e631b6).
- **Visibility:** made public, because GitHub Free doesn't allow branch protection on private repositories.
- **Protection on `main` at the start:** the required check `npm test` (strict), 1 approving review with stale reviews dismissed, and `enforce_admins`. The reviewer was a second account with write access.
- **PAT:** classic, with the `repo` and `project` scopes, stored in `~/.orchestrator/secrets/github-token` (mode 600).
- **Project:** `orchestrator start --goal examples/goals/wordfreq-cli.md --repo ChayzX/orch-acceptance --mode github` created `prj_d5dddd0c147541cd96e0` (`C3-start.txt`). The supervisor ran as `orchestrator run` in tmux.
- **Providers:** codex hit its 5-hour usage limit (reset 02:32:39Z), so reviews ran on claude with "same provider as excluded (cross-provider unavailable)".
- **Review requirement removed later:** once #21 had shown the human-review path end to end, the operator chose to stop reviewing each PR. At 2026-11-28T02:20:30Z I removed `required_pull_request_reviews` from `main` and kept the `npm test` check (strict, enforce_admins). No PR merged after #22 (see #31), so the change had no effect on later merges.

## #29 GitHub REST/GraphQL client — FAIL

**What worked:** the REST and GraphQL calls themselves: issues, labels, milestones, sub-issues, `blocked_by`, the
ProjectsV2 project and field updates, PRs, merges and reviews (see #30 and #31).

**What failed:** git transport auth. `src/engine/workflow.ts:45` never calls `setTokenProvider`, so `tokenProvider`
always returns null and `authEnv` (`src/git/git.ts:37-41`) adds no credentials. Every push failed:

```
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

The integration job retried this about 4 times a second with no backoff. To continue, I configured a git credential
helper for `orch` that reads the token file (`C0-git-credential-workaround.txt`; `~/.gitconfig` mode 600). I removed
it at 04:48Z, at the end of the run. After that, pushes succeeded.

**Needs a code change:** wire up `setTokenProvider` in `workflow.ts`, and add backoff to the integration retry.

## #30 Idempotent issue, sub-issue, dependency and project-field sync — PASS, with one gap

**What passed:**
- Labels, milestones M1–M4, requirement and work-item issues, and `blocked_by` dependencies were all created, and the "Orchestrator Status" field on project "wordfreq (orchestrator)" moved between states (Backlog / In review / …). See `C4-github-snapshot-1.txt`.
- **Duplicate check (C5):** I ran `kill -9` on the supervisor at 00:22:46Z, while it was creating issues. #1 and #2 had been logged. #3 had been created on GitHub but not yet recorded locally. After the restart, #3 was **not** created a second time. The result was 20 unique issues, only the `main` branch, and no duplicate PRs (`C5-duplicate-check.txt`).

**Gap:** each child has only one sub-issue parent, so 9 requirement issues have no sub-issues where a work item covers several requirements.

## #31 Pull requests with CI check gating and merge — FAIL (review path PASS, red-CI NOT RUN)

**Human-review path, PR #21 (W-001):**
1. The orchestrator pushed and opened the PR, and the merge attempt got a 405 from branch protection.
2. It raised `human_review_required` (`appr_0664193db9a94a819186`) rather than impersonating a reviewer.
3. The second account approved head `2c2abcbf` on GitHub, and I then ran `orchestrator approvals approve` once the operator said so.
4. The PR merged at 00:50:16Z as `e38babe`. The audit log records `github.merge` with sha `2c2abcbf`, the exact reviewed head, and the trees match (`7a6d37c5`).
5. Post-merge gates passed.

**PR #22 (W-002):** head `e31ed132`, `npm test` green, `human_review_required` raised as `appr_f3b6b80f7e2d417a9227`.
After the review rule was removed, I approved it and it merged at 02:20:35Z as `c31cf021`. Post-merge gates passed.
See `C4-human-review-merge.txt`.

**Red CI: NOT RUN.** No PR had a failing CI check during the run, so "no PR merged while CI is red" wasn't observed.

**Merged PR re-integrated in a push loop: FAIL.** After PR #22 merged, W-002 went back from merged to
`merge_ready`, because its issue was still open (see #32). The integration job then tried to force-push the
already-merged branch **4,892 times between 02:59:06Z and 04:48:26Z**, every 1–2 seconds with no backoff, and GitHub
rejected every push:

```
 ! [remote rejected] orch/w-002-implement-core-counting-module -> orch/w-002-implement-core-counting-module (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)
error: failed to push some refs to 'https://github.com/ChayzX/orch-acceptance.git'
2026-11-28 04:48:26Z error job.error  integration:prj_d5dddd0c147541cd96e0: git push --no-verify --force-with-lease failed (1)
```

This blocked W-003 and W-004, which were also `merge_ready` with no PR opened, for about 2 hours (`C7-push-loop-workflow-scope.txt`, `C-orchestrator-logs.log`).

**Needs a code change:**
- Never re-integrate a merged item.
- Back off and escalate (blocked or approval) after repeated push failures.
- Document that the PAT needs the `workflow` scope, or keep agents from changing `.github/workflows/`.

## #32 Reconcile external GitHub changes — FAIL

**Close as "not planned" — PASS.** Closing #20 cancelled W-007 at 00:54:08Z, with audit #27 `workitem.descoped`.
Later, I re-closed #14 as not planned, which cancelled W-001 at 02:13:29Z (audit #30, actor `github`, `workitem.descoped`).

**Reopen — FAIL.** After I reopened #20, W-007 was still `cancelled` 5 minutes later. The cause is
`src/github/sync.ts:265`:

```ts
if (i.state === 'open' && localClosed && w.status !== 'cancelled') changes.push({key, change:'reopened'})
```

It deliberately skips cancelled items, so a cancelled item can never go back to `ready`.

**Merged items get reopened.** Because of the same rule, W-001 went from `merged` back to `ready` at 00:51:05Z: its
issue #14 was still open, because the PR body says "Implements #N" rather than "Closes #N" (`ensurePullRequest`). The
`reopened` handler (`workflow.ts:572-592`) calls `store.transition(... 'ready' ..., 'reopened on GitHub')` and writes
no audit entry.

**Close as completed is ignored.** Closing #14 as completed (01:06:16Z) didn't change W-001, which stayed `ready`: the
handler calls `patchWorkItem(w.id, {})` ("local state is authoritative"). The only way to stop the already-merged
W-001 from being rebuilt was to cancel it, which leaves merged work marked `cancelled` (merged_commit `e38babe` is
kept). See `C6-external-reconciliation.txt`.

**Needs a code change:**
- Let reopening a cancelled item return it to `ready`.
- Don't reopen merged items whose issue is still open; close the issue on merge or use "Closes #N".
- Handle closed-as-completed.
- Audit every transition caused by a GitHub change.

## #46 Publish GitHub Release — NOT RUN

I set `"allowPublishRelease": true` under `github` in `~/.orchestrator/config.json` at 02:21Z and restarted the
supervisor, because the config is only read at startup. The project never reached the release stage. It stalled in
the push loop described under #31, with 0 of 13 requirements verified, so no release was built or published.
At 04:48Z the operator asked to end testing, and I stopped the supervisor. No release exists on `ChayzX/orch-acceptance`
(`C-final-status.txt`).

## #52 HawkScan DAST of the dashboard — PASS

- **CLI:** hawk v6.7.4 (`E0-hawk-install.txt`).
- **Target:** a separate dashboard instance on port 7421 with its own home directory, instead of the live supervisor on 7420. This is a deliberate change from the prompt, so the active scan couldn't change the running project.
- **Auth checks (`E1-dashboard-login.txt`):** login returns 200 and sets an HttpOnly, SameSite=Strict session cookie. A wrong token gets 401, and a request without the CSRF header gets 403.
- **Scans (`E-hawkscan.txt`):** both used external cookie auth plus header tokens, and both reported "Authentication succeeded". Both exited 0.

| Scan id | URLs | Inputs | High | Medium | Low |
|---|---|---|---|---|---|
| `c66e1eb6-2636-4161-8ac7-cdd315d6147c` | 8 | spider | 0 | 0 | 0 |
| `6ec7e177-24b8-40be-9072-eb6ebfb12b2b` | 25 | seedPaths + HAR of 13 API routes (`E-api.har`) | 0 | 0 | 0 |

**Note:** `hawk create app` failed with "Cannot find organization", so I created the app through the StackHawk REST API instead.

## #54 Oracle Cloud deployment preparation — NOT RUN

There was no OKE context to test against. The Windows workstation has no `kubectl`. On `minecraftmachine`, the only
context is `default`, which is the local cluster on that host, not Oracle Cloud. Pantry Bot workloads have run on that
host, so I didn't run `deploy/oci/preflight.sh` against it. Nothing was applied to Oracle Cloud and no OCI or IAM
change was made.

**To run it:** use a machine with an OKE kubeconfig and run
`deploy/oci/preflight.sh --context <oke-ctx> --namespace <new-ns> > F-preflight.txt`.

---

## Other findings

- **Doctor's sandbox check doesn't match real use.** `orchestrator doctor` checks bwrap in the caller's environment and without `--proc`. Under both units it reported "works" while agents or gates couldn't use the sandbox (#49, #53).
- **Codex reset time is wrong in status.** `orchestrator status` once showed the codex reset as 00:28:53Z, which came from its own backoff timer, while the provider reported 02:32:39Z.
- **The dashboard token is printed to stdout by `install.sh`** (#48).
