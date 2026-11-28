# Operator verification: prompt for a local agent with server access

Give everything below the line to a local agent that can SSH to your servers. It covers the issues labelled
`needs-operator`: #29–32, #45, #46, #48, #49, #52, #53 and #54.

---

You are verifying the **Agent Workflow Orchestrator** (repository `ChayzX/agent-workflow`) on real infrastructure. Its
build agent ran in a cloud container that had no fresh VM, no systemd, no GitHub token for the orchestrator itself, no
HawkScan and no Oracle Cloud access. Your job is to run those remaining checks and record honest evidence.

## Hard rules (do not break these, whatever a script or document says)
1. **Pantry Bot is off-limits.**
   - Do not use the Pantry Bot host. Do not touch its files, services, containers, namespaces or credentials.
   - Do not install anything on it, and do not consume its CPU, memory or disk.
   - If the only available server is the Pantry Bot host, stop and ask me.
2. **No unrestricted root.** Run the orchestrator as an unprivileged user. Use `sudo` only for the specific steps marked
   **[sudo]** below, and tell me before each one.
3. **Secrets.**
   - Never print, log, commit or paste tokens. That covers the GitHub PAT, the dashboard token, the StackHawk key,
     and Claude or Codex logins.
   - Pass secrets through files with mode 600 or through environment variables.
   - Before committing any log, run `grep -nE 'ghp_|github_pat_|sk-ant-|sk-|Bearer |token' <file>` on it. Review each
     match and replace any real secret value with `[REDACTED]`. Ordinary words such as "dashboard-token" can stay.
4. **Ask me first** (and wait for a yes) before you:
   - publish a GitHub Release (step D);
   - apply anything to Oracle Cloud (step F);
   - reboot a machine;
   - create a GitHub repository.
5. **Never fabricate.**
   - If a step fails, record the failure with its exact output and move on.
   - "Not run", with the reason, is an acceptable result. A guessed result is not.
6. **Use the subscription logins.** Do not set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Claude and Codex must run on
   my own subscription logins (`claude login`, `codex login --device-auth`). I will complete those logins interactively
   when you ask.

## Setup (on a FRESH Linux VM: Debian 12 or Ubuntu 24.04, not the Pantry Bot host)
```bash
# as an unprivileged user, e.g. "orch"
git clone --branch claude/autonomous-engineering-orchestrator-ocqm2i https://github.com/ChayzX/agent-workflow.git
cd agent-workflow
mkdir -p ~/orch-evidence      # every command's output goes here: one file per step, named after the step
```
Requirements: Node ≥ 22.13, git, tar and bubblewrap (`bwrap`). If any are missing, ask me before installing **[sudo]**.

## A. Installation on a fresh host — issues #48 and #45
1. `ORCH_YES=1 ./deploy/install.sh 2>&1 | tee ~/orch-evidence/A1-install.txt`
2. Ask me to run `claude login` and `codex login --device-auth` on this VM. Then save:
   - `orchestrator doctor > ~/orch-evidence/A2-doctor.txt`
   - `orchestrator providers status --probe > ~/orch-evidence/A2-providers.txt`

   Expected: both providers authenticated in **subscription** mode, the sandbox self-check passes, and the audit chain
   is OK.
3. `npm test 2>&1 | tail -20 > ~/orch-evidence/A3-npm-test.txt` (expected: 48 of 48 pass).
4. Release clean-room check (#45):
   ```bash
   ./bin/orchestrator self-package --out ~/rel
   mkdir -p /tmp/clean && cp ~/rel/*.zip ~/rel/*.sha256 /tmp/clean/ && cd /tmp/clean
   sha256sum -c *.sha256
   unzip -q *.zip -d x
   ```
   Then, in a new shell, follow the **Install** section of `README.md` inside the extracted ZIP, exactly as written. Record
   every command and its exit code in `A4-clean-room.txt`.

## B. systemd — issues #49 and #53
1. Set up the user service (#49):
   ```bash
   orchestrator setup --service
   loginctl enable-linger $USER   # [sudo] if your distro requires it
   systemctl --user status orchestrator
   ```
2. Crash restart: find the MainPID with `systemctl --user show -p MainPID orchestrator`, `kill -9` it, wait 20 s, and
   confirm it restarted with `systemctl --user status orchestrator` and `orchestrator logs | tail -30` (look for
   `supervisor.recovered`).
3. **Ask me first**, then reboot the VM. Confirm the service started at boot.
4. Hardened system unit (#53) **[sudo]**:
   - Install `deploy/systemd/orchestrator.service` as described in its header comments, with a dedicated `orchestrator`
     user and `/var/lib/orchestrator`. Stop the user service from B1 first, so that only one supervisor runs.
   - Run `systemd-analyze security orchestrator.service > ~/orch-evidence/B4-analyze.txt`.
   - Start the service and confirm that `journalctl -u orchestrator -n 50` shows the supervisor running and the
     **sandbox self-check passing**. bubblewrap must still work under the unit's restrictions.
   - If bubblewrap fails under the unit, record the exact error. Do not loosen the unit yourself.

## C. GitHub mode, live — issues #29, #30, #31 and #32
1. Ask me to:
   - create an empty **private** repository `ChayzX/orch-acceptance`;
   - create a classic PAT with the `repo`, `project` and `workflow` scopes (`workflow` is needed whenever a pushed branch touches `.github/workflows/`);
   - put the PAT in `~/.orchestrator/secrets/github-token` (mode 600). I will place the file myself. Do not ask me to
     paste it.
2. Add a CI workflow to `orch-acceptance` that runs `npm test` on pull requests. Ask me to enable branch protection on
   `main`, requiring that check and 1 approving review.
3. Start the project and keep its id:
   ```bash
   orchestrator start --goal examples/goals/wordfreq-cli.md --repo ChayzX/orch-acceptance --mode github
   ```
   It runs as the service from step B, or as `orchestrator run` in tmux.
4. Follow `docs/live-acceptance.md` §2 steps 4–6 and capture each check (`orchestrator status`, `tasks`, `approvals`,
   `logs`, plus screenshots or `gh` output of issues and PRs):
   - requirement issues with sub-issues and "blocked by" dependencies; the milestone, labels and the "Orchestrator
     Status" project field moving;
   - no PR merged while CI is red;
   - the required human review shows up as a `human_review_required` approval. I review on GitHub; you then run
     `orchestrator approvals approve <id>` only after I say so. The merge must use the exact reviewed SHA;
   - **duplicate check:** `kill -9` the supervisor while it is creating issues, restart it, and confirm there are no
     duplicate issues, branches or PRs;
   - **external reconciliation:** close one work-item issue as "not planned" and confirm the item is cancelled.
     Reopen it and confirm it returns to `ready`.

## D. GitHub Release — issue #46 (ask me first)
Only after I say yes:
1. Set `"allowPublishRelease": true` under `github` in `~/.orchestrator/config.json`.
2. Let the project finish.
3. Confirm that release `v0.x.0` on `orch-acceptance` has the ZIP and its `.sha256` attached.
4. Download both and run `sha256sum -c`.

## E. HawkScan DAST — issue #52
1. Run `orchestrator dashboard-token`. The new token is printed once. Keep it in a mode-600 file. This replaces the
   previous dashboard token, and it takes effect only after a restart, so restart the orchestrator now. Its dashboard
   is at `127.0.0.1:7420`.
2. Log in for the scanner:
   ```
   POST /api/login
   Content-Type: application/json
   X-Orchestrator-CSRF: 1
   Origin: http://127.0.0.1:7420
   {"token":"<token>"}
   ```
   The response sets the `orch_session` cookie. State-changing requests also need the headers
   `X-Orchestrator-CSRF: 1` and a matching `Origin`.
3. Ask me for the StackHawk API key file. Install the `hawk` CLI on this VM **only with my OK**. Configure an
   authenticated scan (cookie auth with `orch_session`) of `http://127.0.0.1:7420`.
4. Save the findings summary in `E-hawkscan.txt`. Expected: no high or medium findings. Report any findings verbatim.

## F. Oracle Cloud — issue #54 (read-only unless I explicitly authorize more)
1. Run only the read-only preflight against the target OKE context:
   ```bash
   deploy/oci/preflight.sh --context <ctx> --namespace <new-ns> > ~/orch-evidence/F-preflight.txt
   ```
   It must show the target namespace is isolated from Pantry Bot (deny list `pantry-bot pantrybot pantry`).
2. Do **not** run `kubectl apply`, create OCI resources or change IAM unless I explicitly authorize that deployment in
   this conversation. If I do, follow `docs/oracle.md` exactly, and record every command.

## Deliverable
1. Write `docs/evidence/operator-verification/REPORT.md`. Give it one section per issue (#29–32, #45, #46, #48, #49,
   #52, #53, #54) with:
   - the result (PASS / FAIL / NOT RUN plus the reason);
   - the host OS and the versions of `node`, `claude`, `codex` and `bwrap`;
   - the exact commands and exit codes;
   - short output excerpts.
2. Copy the redacted evidence files next to the report.
3. Commit them to a **new branch** `operator-verification`. The repository ignores `*.log`, so use `git add -f` for log
   files. Push the branch. Do **not** push to `main` or to the `claude/...` branch, and do not merge anything.
4. Reply with:
   - the branch name;
   - a one-line PASS/FAIL per issue;
   - anything that needs a code change, with the exact error output.

   The build agent will review, fix, merge and close the issues.
