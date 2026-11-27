# Restricted SSH deploy runner (fallback only)

Use SSH only when a project runs on a plain OCI Compute VM and neither an OCI DevOps
deployment pipeline nor a pull-based agent on the VM is possible. Preferred order:

1. Pull-based: a systemd timer/agent on the VM pulls the approved, digest-pinned release
   (no inbound access at all).
2. OCI DevOps deployment pipeline (instance-group deployment stage).
3. This document: inbound SSH with a forced command, as a dedicated non-root account.

Never: root login, unrestricted `sudo`, a shell for the deploy key, agent/port forwarding,
the same key or account on more than one project, or any SSH access to Pantry Bot hosts.
The orchestrator only uses this runner after the operator approved `production_deploy`.

## 1. Dedicated account on the VM (one per project)

```bash
sudo useradd --system --create-home --home-dir /srv/orch-deploy-<project> \
  --shell /bin/sh orch-deploy-<project>        # a shell is needed to run the forced command
sudo install -d -m 0750 -o orch-deploy-<project> -g orch-deploy-<project> \
  /srv/<project>/releases
sudo passwd -l orch-deploy-<project>          # no password login
```

The account owns only `/srv/<project>`. It is not in `sudo`, `wheel`, `docker` or `adm`
(membership in `docker` is equivalent to root).

## 2. `authorized_keys` with a forced command

`/srv/orch-deploy-<project>/.ssh/authorized_keys` (mode 0600, directory 0700, owned by the
account; consider making it root-owned and read-only via `AuthorizedKeysFile` so the
account cannot add keys):

```
restrict,from="10.20.30.40/32",command="/usr/local/bin/orch-deploy-gate <project>",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc ssh-ed25519 AAAAC3...REPLACE... orch-deploy-<project>@runner
```

- `restrict` (OpenSSH >= 7.2) disables all forwarding, PTY and rc; the explicit `no-*`
  options are kept for older servers and for readability.
- `from=` pins the runner's egress IP (the deploy runner, never "any").
- `command=` ignores whatever the client asks for; the gate reads `SSH_ORIGINAL_COMMAND`.

## 3. `sshd_config` Match block

```
# /etc/ssh/sshd_config (global)
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no

# /etc/ssh/sshd_config.d/50-orch-deploy-<project>.conf
Match User orch-deploy-<project>
    AuthenticationMethods publickey
    AuthorizedKeysFile /etc/ssh/authorized_keys.d/orch-deploy-<project>
    ForceCommand /usr/local/bin/orch-deploy-gate <project>
    PermitTTY no
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    GatewayPorts no
    PermitUserRC no
    MaxSessions 1
```

Validate with `sudo sshd -t` before reloading. Restrict TCP 22 to the runner's IP in the
VM's Network Security Group as well (or use the OCI Bastion service with time-limited
sessions instead of a public port; verify against current OCI docs).

## 4. Forced-command gate (allowlisted verbs only)

`/usr/local/bin/orch-deploy-gate` (root-owned, 0755):

```bash
#!/bin/bash
set -euo pipefail
project="$1"
read -r verb arg extra <<<"${SSH_ORIGINAL_COMMAND:-}"
[[ -z "${extra:-}" ]] || { echo "denied: extra arguments" >&2; exit 2; }
case "$verb" in
  deploy)   # deploy sha256:<64 hex>  - only immutable digests, never tags
    [[ "$arg" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "denied: digest required" >&2; exit 2; }
    exec /srv/"$project"/bin/deploy "$arg" ;;
  rollback) [[ -z "${arg:-}" ]] || exit 2; exec /srv/"$project"/bin/rollback ;;
  status)   [[ -z "${arg:-}" ]] || exit 2; exec /srv/"$project"/bin/status ;;
  *) echo "denied: $verb" >&2; exit 2 ;;
esac
```

The `bin/` scripts are root-owned (not writable by the deploy account) and only touch
`/srv/<project>`.

## 5. If a privileged step is unavoidable: one narrow sudoers rule

Prefer a systemd *path unit* or a user service (`loginctl enable-linger`) so no sudo is
needed. If the service must be restarted as root, allow exactly one command:

```
# /etc/sudoers.d/orch-deploy-<project>   (visudo -cf to validate)
orch-deploy-<project> ALL=(root) NOPASSWD: /usr/bin/systemctl restart <project>.service
```

No wildcards, no editors, no shells, no `ALL`.

## 6. Runner (client) side: pinned host keys

```bash
# Obtain the host key fingerprint OUT OF BAND (OCI console serial/console connection or
# cloud-init output: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), then pin it:
echo '10.20.30.50 ssh-ed25519 AAAAC3...HOSTKEY...' > /etc/orchestrator/known_hosts.d/<project>

ssh -i /etc/orchestrator/keys/orch-deploy-<project> \
    -o IdentitiesOnly=yes -o BatchMode=yes \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=/etc/orchestrator/known_hosts.d/<project> \
    -o ForwardAgent=no -o ClearAllForwardings=yes \
    orch-deploy-<project>@10.20.30.50 "deploy sha256:<digest>"
```

- Never `StrictHostKeyChecking=no` or `accept-new`, never `ssh-keyscan` at deploy time.
- Only destinations listed in the project's approved deploy config are contacted.
- Prefer short-lived SSH certificates (`ssh-keygen -s ca_key -V +1h ...`, server side
  `TrustedUserCAKeys`) over long-lived keys; rotate keys otherwise.
- The private key lives with the deploy runner, never in an agent/cloud session.
