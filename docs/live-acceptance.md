# Guided live acceptance procedure

Use this to verify the integrations that need the operator's own credentials or infrastructure. Each step names the
scenario from the mission's acceptance list and the evidence to record in `docs/acceptance-matrix.md`.

## 0. Prerequisites
```bash
orchestrator doctor                       # must report: claude + codex authenticated (subscription), GitHub token valid
orchestrator providers status --probe     # shows Codex windows (no model usage)
```

## 1. Dual-provider collaboration (B, C)
```bash
npm run build
node --disable-warning=ExperimentalWarning dist/test/live/live-acceptance.js ~/.orchestrator-live
```
The script installs a fixed three-item plan and runs the real supervisor with cheap models:
- W-001 and W-002 each require a blocking question before implementation;
- ADR-001 is debated;
- W-003 depends on both items and on the decision.

Expected evidence:
- `orchestrator --home ~/.orchestrator-live messages`: one question from a Codex-run agent answered by a Claude-run agent,
  and one in the reverse direction (check `tasks.provider` for the asking and answering tasks).
- `tasks` shows W-001 and W-002 implemented concurrently on different providers, each reviewed by the other provider.
- `decisions`: ADR-001 has positions from both providers.
- Completion-audit tasks ran on both providers, and the release ZIP is verified.

## 2. GitHub mode (D)
1. Create an empty private test repository `you/orch-acceptance` and a classic PAT with `repo`, `project` and `workflow` scopes (GitHub refuses pushes that touch `.github/workflows/` without `workflow`).
   Save the PAT to `$ORCH_HOME/secrets/github-token` (mode 600).
2. Optionally add a CI workflow that runs `npm test`, and require it plus one approving review in branch protection.
3. `orchestrator start --goal examples/goals/wordfreq-cli.md --repo you/orch-acceptance --mode github`
4. Verify:
   - Requirement issues exist, with work-item sub-issues and "blocked by" dependencies.
   - The milestone, labels and the **Orchestrator Status** field on the project board move as work progresses.
   - PRs open only after local gates and independent review pass. When CI is red, the PR is not merged and a
     remediation round starts.
   - With a required review, an approval `human_review_required` appears and the PR stays unmerged. Review it on
     GitHub, approve it in `orchestrator approvals`, and confirm the merge happens with the exact reviewed SHA.
5. **Duplicate check.** `kill -9` the supervisor during issue creation, restart it, and confirm no duplicate issues,
   branches or PRs exist (`gh issue list --label orchestrator`).
6. **External reconciliation.** Close one work-item issue as "not planned" and confirm the item is cancelled and
   audited. Reopen it and confirm it returns to `ready`.
7. **Release.** With `github.allowPublishRelease: true`, the verified ZIP and `.sha256` are attached to a release
   `v0.x.0`.

## 3. Recovery (E) on the real service
- **Kill an agent:** `orchestrator tasks` → note a running task id → `kill -9 <pid of its claude/codex process>`. Expect
  `task.failed … killed` followed by a resume.
- **Restart:** `systemctl restart orchestrator` while agents run. Expect a graceful interrupt and a native resume
  (`(resume)` in `task.started`).
- **Usage limits** happen naturally on subscriptions. Confirm `provider.status … → exhausted` carries a provider
  `resetAt`, that the other provider continues the work, and that the provider returns to `recovering`/`available`
  after the reset.

## 4. Installation (A)
Install on a fresh Debian 12 VM with `deploy/install.sh` and `ORCH_YES=1`, then `setup --service`, `doctor`, a reboot,
and `systemctl --user status orchestrator`. Linger is required for the user service to start at boot.

## 5. Security
Run HawkScan (or another DAST tool) against `http://127.0.0.1:7420` with the dashboard token. Expected: no high or
medium findings. CSP, frame denial, HttpOnly/SameSite cookies, CSRF header enforcement and a 413 for oversized bodies
are already covered by `test/web.test.ts`.
