# Operations runbook

## Install (Debian/Ubuntu, modest server: 2 vCPU / 4 GB RAM / 20 GB disk is enough)

```bash
# Recommended: a dedicated unprivileged account
sudo useradd --system --create-home --home-dir /var/lib/orchestrator --shell /usr/sbin/nologin orchestrator
sudo mkdir -p /opt/orchestrator && sudo unzip agent-workflow-orchestrator-<v>.zip -d /opt && sudo mv /opt/agent-workflow-orchestrator-<v>/* /opt/orchestrator/
sudo apt-get install -y git bubblewrap        # Node >= 22.13 also required (installer offers NodeSource)
sudo -u orchestrator -H env ORCH_HOME=/var/lib/orchestrator /opt/orchestrator/bin/orchestrator setup
sudo -u orchestrator -H npm install -g --prefix /var/lib/orchestrator/.npm-global @anthropic-ai/claude-code @openai/codex   # or system-wide
sudo -u orchestrator -H claude login              # or: claude setup-token
sudo -u orchestrator -H codex login --device-auth
sudo install -m 644 /opt/orchestrator/deploy/systemd/orchestrator.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now orchestrator
sudo -u orchestrator -H env ORCH_HOME=/var/lib/orchestrator /opt/orchestrator/bin/orchestrator doctor
```

For a personal user install instead, run `./deploy/install.sh`. It installs a systemd **user** unit; run
`sudo loginctl enable-linger $USER` once so the unit starts at boot.

## Daily operation
- `orchestrator status`: verified-requirement progress, active and waiting tasks with their reset times, approvals.
- `orchestrator logs --follow`: execution events. `journalctl -u orchestrator` shows process logs.
  `$ORCH_HOME/logs/orchestrator.log` holds structured, redacted JSON logs, rotated at 10 MB × 5.
- **Dashboard:** `http://127.0.0.1:7420/`. For remote access use an SSH tunnel (`ssh -L 7420:127.0.0.1:7420 host`), or
  terminate TLS in a reverse proxy and keep the token.
- `orchestrator approvals`: decide on anything the supervisor will not do on its own.
- **Concurrency:** start conservative (default 2 agents overall, 1 per provider). Raise
  `providers.<id>.maxConcurrent` / `supervisor.maxConcurrentAgents` in `config.json` (restart), or use the dashboard
  Providers page (runtime only).

## Health signals and what they mean
| Signal | Meaning | Action |
|---|---|---|
| provider `exhausted` with a reset time | usage window spent | none: work resumes automatically at the reset; other providers continue |
| provider `auth_required` + approval | session expired | re-run `claude login` / `codex login --device-auth` as the service user |
| provider `disabled` (billing_policy) | API-key auth detected | remove the key, or authorize billing explicitly, then `orchestrator providers reset <id>` |
| project `blocked` | genuine blocker (e.g. plan invalid 3×, requirement blocked) | read `status_reason`, act, then `orchestrator resume` |
| work item `blocked` | an investigation judged a blocker external (it may be wrong: tool limits or scope wording are not external) | read `orchestrator logs` for `workitem.blocked`; if it is not genuinely external, `orchestrator unblock D-007 --note "why, and the scope decision"`. The note is audited and shown to the next agent. |
| `task.lease_expired` events | a worker died | none: automatically requeued and resumed |
| repeated `job.error` | environment problem (disk, git) | `orchestrator doctor` |

## Backup and restore
```bash
orchestrator backup                      # consistent online snapshot (VACUUM INTO) → $ORCH_HOME/backups/
systemctl stop orchestrator && orchestrator restore <file.db> && systemctl start orchestrator
```
Also back up `$ORCH_HOME/releases/` and `$ORCH_HOME/config.json`. Workspaces are git clones and are re-created when
missing. Credentials for the GitHub token and the provider CLI config directories are deliberately excluded from
backups; re-authenticate after a restore onto a new host.

## Upgrade
```bash
orchestrator upgrade                     # takes a pre-upgrade backup and prints the steps
systemctl stop orchestrator
unzip -o agent-workflow-orchestrator-<new>.zip … over /opt/orchestrator   # dist/ is prebuilt
systemctl start orchestrator             # forward-only migrations apply automatically; active projects continue
```
Rollback: stop, restore the previous release directory, `orchestrator restore <pre-upgrade backup>`, start.

## Graceful shutdown and restarts
`SIGTERM` (or `systemctl stop`): dispatch stops, and running agents get `supervisor.shutdownGraceMs` (30 s) to finish.
After that they are interrupted, with their session ids kept, and resume natively after restart. A crash or reboot is
handled the same way through lease expiry and orphan reaping.

## Uninstall
`orchestrator uninstall` removes the service unit and CLI link and keeps data. `orchestrator uninstall --purge --yes`
also deletes `$ORCH_HOME`.

## Disk, logs, cleanup
Worktrees are removed after a work item is merged. Gate logs and transcripts accumulate under `$ORCH_HOME`; prune old
projects' `gate-logs/` and `transcripts/` directories as needed. `doctor` fails below `supervisor.minFreeDiskMb`
(1 GB).

## Agent VMs (security.agentBackend = "devvm")

Agents, gates and release verification run in throwaway VMs on the gaming PC; Chasebot runs only the control plane.
Full setup: `deploy/devvm/README.md`. Credentials (documented vendor methods only; run as the service user):

```bash
umask 077; mkdir -p ~/.orchestrator/secrets
claude setup-token                       # browser approval; prints a one-year token (Pro/Max). It is not saved anywhere.
install -m 600 /dev/stdin ~/.orchestrator/secrets/claude-oauth-token    # paste the token, Enter, then Ctrl-D
codex login --device-auth                # ChatGPT sign-in for the service user (writes ~/.codex/auth.json)
install -m 600 ~/.codex/auth.json ~/.orchestrator/secrets/codex-auth.json
orchestrator doctor                      # checks both copies, the VM backend and the egress proxy
```

- `orchestrator status` lists the agent VMs and says when work is waiting for the VM host.
- Gaming: `devvm pause` closes admission; work queues durably and resumes after `devvm resume`.
- A missing or unsafe credential copy raises a `provider_reauthentication` approval naming the file.
