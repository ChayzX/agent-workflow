# On-demand Debian development VMs

Chasebot runs the `devvm` CLI. It sends Wake-on-LAN when the gaming PC's controller listener is unreachable, authenticates to Windows OpenSSH, and opens guest SSH through the same restricted connection. A Windows background task creates and destroys each VM using an independent Terraform state file and the installed Oracle VirtualBox CLI.

## Agent commands

Run these on Chasebot as the orchestrator's service account (`<service-user>` below). The CLI is installed at `~/.local/bin/devvm`. Host-specific values (the gaming PC's address and MAC, the broadcast address) live in `~/.local/share/devvm/config.json` (mode 600), never in this repository; start from `config.example.json`. Successful management commands print JSON to stdout. Guest SSH forwards the command's stdout, stderr, and exit status.

```sh
vm="$HOME/.local/bin/devvm"
id=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
trap '"$vm" destroy "$id"' EXIT
"$vm" provision --id "$id" --cpus 2 --ram-mib 2048 --disk-gib 12 --ttl-minutes 60
"$vm" status "$id"
"$vm" ssh "$id" 'cat /etc/os-release; id; nproc; df -h /'
# Run build commands or launch an interactive shell
"$vm" ssh "$id"
```

For a shell-free script, save the lease ID before provisioning and call `destroy ID` in the script's cleanup handler. The Windows reaper also removes expired leases and incomplete operations. To use an existing agent Ed25519 key, add `--public-key /path/to/id_ed25519.pub` when provisioning and then call `devvm ssh --identity /path/to/id_ed25519 ID`. With an external key, the first SSH connection can need a short retry while cloud-init finishes.

| Command | Behavior |
| --- | --- |
| `provision [--id ID] [--cpus N] [--ram-mib N] [--disk-gib N] [--ttl-minutes N]` | Wake if needed, reserve capacity, apply Terraform, and print the lease. Reuse the same ID and options to retry an in-flight allocation. The CLI prints the ID to stderr before making the request. |
| `ssh [--identity KEY] ID [COMMAND]` | Connect as `dev` using a strict host-key pin for that guest. Commands run inside the guest with the guest's current shell. |
| `status ID`, `list` | Inspect active or absent leases and the gaming pause while the PC is awake. |
| `destroy ID` | Wake the host if needed, remove the VM and its disk through Terraform, and clear the local SSH identity. Repeating destroy on an absent lease succeeds. |
| `pause`, `resume` | Close or reopen admission on an awake host. Existing jobs keep running during pause. To drain before gaming, pause, list the leases, then let them finish or explicitly destroy the ones you own. |
| `wake` | Wake as needed and wait for the Windows worker's authenticated health response. |
| `reachable` | Report whether the gaming PC's listener answers right now, without waking it. |
| `renew ID [--ttl-minutes N]` | Extend a running lease to now + N minutes (at most 480). |
| `image-build [--proxy URL]` | Build and activate a new base image (see Base image). |

## Capacity and access

- **Development may use the whole PC.** By default the pool may take every logical CPU and all RAM except a small
  floor kept for Windows (2 logical CPUs, 4 GiB RAM, 30 GiB disk), up to 16 leases. Per lease: 1–32 vCPUs,
  1–64 GiB RAM, 8–512 GiB disk, 1–480 minute lifetime (renewable with `devvm renew`). Change any of it in
  `C:\ProgramData\AIDevVM\host.json`:
  `"reserve": {"cpus": 2, "ram_mib": 4096, "disk_gib": 30}`, `"limits": {...}` (absolute pool limits),
  `"ranges": {"cpus": [1, 32], ...}` (per lease) and `"vm": {"cpu_cap": 100, "priority": "low"}`.
- Guests run headless at low VirtualBox process priority, so Windows stays responsive. 3D acceleration, USB,
  clipboard sharing and drag-and-drop are off. **`devvm pause` is the operator's manual control for gaming**: it closes
  admission (existing leases keep running; destroy them to free everything). Nothing pauses automatically. While paused
  or full, the orchestrator's work stays queued in its database and resumes when admission reopens.
- Windows SSH accepts only Chasebot's Ed25519 key from `<chasebot-ip>`, uses a forced management command, and permits
  forwarding only to the pool's loopback SSH ports. Each guest has a separate disk, NAT interface and SSH host key.
- **Egress: guests reach only the Chasebot egress proxy.** `Set-EgressFirewall.ps1` adds Windows Firewall Block rules
  on the VirtualBox VM processes for every destination except `<chasebot-ip>:<proxy-port>` (LAN, router, this PC,
  Chasebot's other ports, Pantry Bot, the internet). The NAT DNS relay and host resolver are off, so guests resolve
  nothing themselves. `chasebot-egress-firewall.sh` lets only the gaming PC use the proxy port. The proxy
  (`orchestrator egress-proxy`) allows only allowlisted host names and refuses any name that resolves to a private,
  loopback or link-local address. Prove every refusal with `egress_acceptance.py`.
- Chasebot's `<service-user>` account is the trusted controller boundary and can manage every lease.
- Windows holds an idle-sleep request while leases exist. The orchestrator keeps leases only while work needs them,
  so the PC can sleep when idle. A user-initiated sleep, shutdown, or power loss can interrupt work; the orchestrator
  waits, and rebuilds lost leases from its checkpoints. Treat VM disks as disposable.

## Base image

`devvm image-build` boots a builder VM, runs `image/provision-guest.sh` in it (git, build tools, Python, Node 22,
Claude Code and Codex CLIs, proxy settings for apt/npm/pip; **no credentials**), and captures its disk as the new base
image (`<DataRoot>\images\`, the newest three are kept; `images\current.json` points at the one in use). The
`devvm-image.timer` user unit rebuilds it weekly. Set `"proxy": "http://<chasebot-ip>:3128"` in `config.json`.
Debian package downloads are cached by the egress proxy; npm and pip downloads go through it uncached (HTTPS).

## Agent Workflow Orchestrator

The orchestrator can run quality gates and release verification in these VMs. The backend is chosen **explicitly**:

```json
{
  "security": { "gateBackend": "devvm", "gateNetwork": false },
  "vm": { "command": "/home/<service-user>/.local/bin/devvm", "unavailableRetryMin": 5, "gate": { "cpus": 2, "ramMib": 2048, "diskGib": 12 } }
}
```

- The selection is written to the audit log (`security.gate_backend`) at every supervisor start, and `orchestrator doctor` reports it.
- `vm.command` must be an absolute path to a regular, executable file owned by root or the service user, with no
  group- or world-writable file or parent directory. Otherwise gates do not run at all (fail closed).
- Each gate archives the exact gated commit (`git archive`: no `.git`, no untracked files), streams it to a fresh guest,
  and records the command's real exit code and log. Gate commands run as the separate non-sudo user `devgate`, and in a
  private network namespace unless `security.gateNetwork` is true.
- The exact archive is built once per gate run and scanned exhaustively (every directory including `dist/` and
  `node_modules/`, binary and large files) before anything leaves Chasebot. Any hit blocks the export, for gates and
  for release verification alike.
- The command's exit status comes back out-of-band (`devvm gate --status-file`), so a command that itself exits 75
  or 255 is recorded as a failure, not mistaken for an outage.
- **When the VM host cannot run a gate** (PC asleep and not waking, gaming pause, pool full, SSH lost mid-run), `devvm`
  exits 75 and writes no status. That is not a gate result: no result is recorded, no remediation starts, and gates wait
  `vm.unavailableRetryMin` minutes before trying again. One `gates.backend_unavailable` event is emitted per outage, and
  `orchestrator status` shows the wait. **Gates never fall back to running on Chasebot.**
- The legacy key `security.devVmGateCommand` (from the first version of this branch) is rejected with a message naming
  its replacement.

Manual check from a scratch repository on Chasebot: `sh deploy/devvm/gate-smoke.sh` (four checks; expect four PASS lines).

### Agent sessions in VMs (`security.agentBackend: "devvm"`)

```json
{
  "security": { "agentBackend": "devvm", "gateBackend": "devvm" },
  "supervisor": { "maxConcurrentAgents": 6 },
  "vm": { "command": "/home/<service-user>/.local/bin/devvm", "egressProxy": "http://<chasebot-ip>:3128",
          "agent": { "cpus": 4, "ramMib": 8192, "diskGib": 32, "ttlMinutes": 240, "renewBeforeMin": 45 },
          "review": { "cpus": 2, "ramMib": 4096, "diskGib": 24 }, "warmPool": 1, "maxLeases": 4 },
  "egress": { "allowClients": ["<gaming-pc-ip>"] }
}
```

- **One VM per work item**, kept from implementation through remediation so `claude --resume` and `codex exec resume`
  keep working; destroyed when the item is merged, cancelled or blocked. Its TTL is renewed while in use. If it is lost
  or expires anyway, the next task builds a new one and the session is rebuilt from checkpoints (no resume).
- **Reviews, audits, planning and other read-only tasks run in a separate per-project VM** that no implementer ever
  runs in, so an implementing agent cannot change the reviewer's CLI config, hooks or binaries. Each read-only task
  gets its own directory there.
- **Workspace in, result out.** The supervisor sends a git bundle of the item's commit (and any uncommitted
  supervisor state, such as an in-progress merge) into the guest, and takes back a binary patch of the guest
  directory, which it applies, commits and pushes itself. Patches touching `.git` are refused. **The GitHub token never
  enters a VM**; the agent runs with the egress proxy as its only route out.
- **Credentials.** The Claude token (`claude setup-token`) and Codex `auth.json` live on Chasebot in
  `$ORCH_HOME/secrets/claude-oauth-token` and `$ORCH_HOME/secrets/codex-auth.json` (mode 600) and are copied into each
  VM over SSH stdin at provision (never on a command line, in an image, in Terraform state or in logs).
  `vm.codexAuthWriteBack` (default false) keeps a refreshed Codex `auth.json` from a VM. The API-billing guard is
  unchanged: no API key is ever placed in a VM.
- **Warm pool.** `vm.warmPool` spare VMs (default 1) are kept booted only while some project has runnable work, and the
  next work item adopts one instead of waiting ~2.5 minutes for a boot.
- **Fallback.** If no VM can be provisioned (asleep and not waking, paused, full), tasks wait in the queue and one
  `vm.unavailable` event is raised per outage; agents never run on Chasebot.

## Windows and Chasebot setup

1. On Chasebot, generate a dedicated Ed25519 key with `ssh-keygen -t ed25519 -f ~/.local/share/devvm/windows_ed25519 -N ''`, using a data directory with mode 700. Supply only the resulting public key file to the Windows installer. Install `devvm` with mode 700 into `~/.local/bin`, and the two `devvm-prune` units in `~/.config/systemd/user`. Enable the timer with `systemctl --user daemon-reload && systemctl --user enable --now devvm-prune.timer`. Copy `config.example.json` to `~/.local/share/devvm/config.json` (mode 600) and fill in the gaming PC's LAN address, its MAC address (for Wake-on-LAN) and the LAN broadcast address.
2. On Windows, run `Prepare-Assets.ps1 -Destination <asset-directory>`. It verifies the fixed Debian, Terraform and pycdlib downloads. With an elevated PowerShell, run `Install-Windows.ps1 -Assets <asset-directory> -ControllerKeyFile <chasebot-key.pub> -ControllerAddress <chasebot-ip> -ListenAddress <gaming-pc-ip> -Result <install.json>`. It creates the standard local account `aidevvm`, grants its batch logon right, starts `AIDevVM-Worker`, and brings up the SSH listener on port 2224. A clean installation expects the Windows OpenSSH service to be stopped and its server config to be absent.
3. Transfer the **public** host key from the Windows result over a trusted channel. Write a single line to Chasebot's `~/.local/share/devvm/windows_known_hosts` containing `[<gaming-pc-ip>]:2224` followed by the two key fields `ssh-ed25519 BASE64`. Run `devvm wake`, then run `python3 acceptance.py` on Chasebot for the real lifecycle checks.

4. On this host, move the worker to the signed-in desktop account. From an elevated PowerShell started by that account, run `Use-DesktopWorker.ps1 -DesktopUser <account>` (add `-Resume` to finish an interrupted run). The `aidevvm` account stays the SSH entry point and can only queue requests in the spool folder. The reason: this CPU exposes no AMD-V to VirtualBox, so VirtualBox uses the Windows Hypervisor Platform (NEM). In the `aidevvm` batch session (session 0), VirtualBox's hardening rejects `WinHvPlatform.dll` as unsigned, and `startvm` fails with `VERR_NEM_INIT_FAILED`. In the desktop session it loads normally. The tradeoff: leases run with that account's token and only while it is signed in, because the task starts at logon.

The Windows program is in `C:\ProgramData\AIDevVM`. With the desktop worker, its data, VirtualBox registry, and Terraform lease state live under `E:\AIDevVM-Desktop` (the original `E:\AIDevVM` is left unused). The worker's separate `VBOX_USER_HOME` starts its own VBoxSVC, so the account's personal VirtualBox VMs are not affected.

Under NEM, a fresh guest takes about 2.5 minutes to finish first boot and cloud-init, and longer when several boot at once. `devvm provision` waits up to 7 minutes (capped at the lease's expiry). The orchestrator backend adds a 20-minute VM lifecycle allowance (wake, provisioning, first boot) on top of each gate's `timeout_sec`, and gives `devvm` two minutes after SIGTERM to destroy its lease. The Debian base disk is shared read-only as the source for independent full clones. Check failed starts with `Get-ScheduledTaskInfo AIDevVM-Worker`, `Get-Content E:\AIDevVM-Desktop\worker.log -Tail 30`, and the Windows OpenSSH event log. Keep any lease records with cleanup errors so the reaper can retry them.

5. **Egress lockdown (agent VMs).** On Windows (elevated): `Set-EgressFirewall.ps1 -ControllerAddress <chasebot-ip>`.
   On Chasebot: `sudo sh deploy/devvm/chasebot-egress-firewall.sh <gaming-pc-ip>`, set `egress.allowClients` to
   `["<gaming-pc-ip>"]` in `$ORCH_HOME/config.json`, and start `orchestrator-egress.service`. Then run
   `python3 deploy/devvm/egress_acceptance.py --proxy http://<chasebot-ip>:3128 --chasebot <chasebot-ip> --gateway <router-ip> --pc <gaming-pc-ip> --deny-host <pantry-bot-host> ...`
   and expect `ALL PASS`.
6. **Base image.** `devvm image-build --proxy http://<chasebot-ip>:3128`, then enable the weekly rebuild:
   copy `devvm-image.service` and `devvm-image.timer` to `~/.config/systemd/user/` and
   `systemctl --user enable --now devvm-image.timer`.

## Integration decision

| Integration | Finding |
| --- | --- |
| `terra-farm/virtualbox` | Its registry release was the 2021 alpha. The project uses Vagrant-style VM image assumptions. [Release history](https://github.com/terra-farm/terraform-provider-virtualbox/releases) |
| `eran132/vbox` | The fork publishes a Windows amd64 binary and uses VBoxManage. The Windows artifact establishes distribution coverage. This installation needs control over cloud-init, Windows session ownership, host admission, SSH restrictions, and recovery outside Terraform. [Provider repository](https://github.com/eran132/terraform-provider-vbox) |
| `terraform_data` and VBoxManage | The selected integration uses Terraform's built-in lifecycle and Oracle's installed CLI. The host worker reconciles partial applies and verifies deletion independently because Terraform can skip the destroy provisioner for tainted state. The worker is the supported entry point for these leases. [Terraform provisioners](https://developer.hashicorp.com/terraform/language/provisioners) · [VirtualBox 7.2 manual](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/) |
