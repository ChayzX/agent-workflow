# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `another supervisor is running (pid N)` | two daemons on one `ORCH_HOME` | stop the other (`systemctl stop orchestrator`). A stale lock from a dead pid is cleared automatically. |
| Nothing happens after `start` | daemon not running | `systemctl --user start orchestrator` or `orchestrator run`; check `orchestrator doctor` |
| Project stuck in `planning` | plan rejected by validation, or provider unavailable | `orchestrator logs` (look for `decision.retry` / `task.failed`); after 3 invalid plans the project is `blocked` with the reason, then `orchestrator resume` |
| `waiting for provider capacity` | all enabled providers exhausted | expected; `orchestrator providers status --probe` shows reset times (Codex probe uses no model usage) |
| Codex `401 Unauthorized … Missing bearer` | not logged in, as the service user | `sudo -u orchestrator -H codex login --device-auth` |
| Claude `Not logged in` / `authentication_error` | OAuth expired | `claude login` or `claude setup-token` as the service user |
| `billing_policy` / provider `disabled` | `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` present, or an API-key login | remove the key or set `providers.<id>.allowApiKeyBilling: true` deliberately, then `orchestrator providers reset <id>` |
| Gates fail with "command not found" | gate commands run with a minimal PATH, no network, empty HOME | include tool install in the project (lockfile, `npm ci` in a verify command), or set `security.gateNetwork: true` |
| `bubblewrap unavailable` | package missing, or user namespaces disabled | `apt-get install bubblewrap`. On hardened kernels: `sysctl kernel.unprivileged_userns_clone=1` (Debian), or accept unsandboxed gates. |
| GitHub `Resource not accessible by personal access token` on Projects | fine-grained PAT on a user-owned project | use a classic PAT with `repo` + `project` scopes |
| PR never merges; approval `human_review_required` | branch protection requires a human review | review on GitHub, then approve in `orchestrator approvals`; the merge is retried |
| Merge conflicts loop | overlapping work items | the item is remediated; after `maxRemediationRounds` an investigation chooses another strategy |
| Dashboard 401 after restart | sessions are kept; the token was rotated | sign in again with the new token |
| `refusing to read …github-token: permissions too open` | token file mode | `chmod 600 $ORCH_HOME/secrets/github-token` |
| Database errors | disk full or corruption | `orchestrator doctor` (integrity check); `orchestrator restore <backup>` |

Diagnostics bundle for a bug report (redacted by design): `orchestrator doctor`, `orchestrator status`,
`orchestrator logs --limit 200`, and `$ORCH_HOME/logs/orchestrator.log` (secrets redacted).
