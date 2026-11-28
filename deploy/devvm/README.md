# On-demand Debian development VMs

Chasebot runs the `devvm` CLI. It sends Wake-on-LAN when the gaming PC's controller listener is unreachable, authenticates to Windows OpenSSH, and opens guest SSH through the same restricted connection. A Windows background task creates and destroys each VM using an independent Terraform state file and the installed Oracle VirtualBox CLI.

## Agent commands

Run these on Chasebot as `cpederson`. The CLI is installed at `~/.local/bin/devvm`. Successful management commands print JSON to stdout. Guest SSH forwards the command's stdout, stderr, and exit status.

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

## Capacity and access

- Each lease allows 1–4 vCPUs, 1–4 GiB RAM, an 8–24 GiB disk, and a 1–480 minute lifetime. Defaults are 2 vCPUs, 2 GiB RAM, 12 GiB disk, and 60 minutes.
- Windows admits at most 3 leases, 6 assigned vCPUs, 8 GiB RAM, and 72 GiB of reserved virtual disk total. It also checks for at least 8 GiB of free host RAM after the requested allocation and 30 GiB of disk headroom after counting the reservations. Limits apply to the managed pool. Host applications and manually launched VMs still consume physical resources.
- Guests run headless at low VirtualBox process priority with a 75% vCPU execution cap. The guest configuration disables 3D acceleration, USB, clipboard sharing and drag-and-drop. Game and anti-cheat compatibility depends on the title and must be checked with that title. Pause and drain the development pool for a session that needs all host resources.
- Windows SSH accepts only Chasebot's Ed25519 key from `192.168.40.200`, uses a forced management command, and permits forwarding only to the pool's loopback SSH ports. Each guest has a separate disk, NAT interface and SSH host key. Guests with standard interactive networking may reach LAN destinations through NAT. Chasebot's `cpederson` account is the trusted controller boundary and can manage every lease. Give agents in separate trust contexts their own guest key and keep the controller key under the service account.
- Windows holds an idle-sleep request while leases exist. A user-initiated sleep, shutdown, or power loss can interrupt work. The worker reaps abandoned and expired leases after Windows becomes available. Treat VM disks as disposable and keep source and outputs outside the lease.

## Agent Workflow Orchestrator

This repository includes an opt-in backend for the existing quality gates. The tested upstream base is `8ee27cbd332bb58e2cd92dcd1b687ce876039209`. The backend archives the exact managed Git commit, sends only that archive to a fresh guest, and saves the command's actual exit code and logs in the orchestrator. Claude and Codex adapter processes, provider credentials, and Git operations stay on Chasebot. The built-in secret scan blocks export when it detects credentials. Gate commands use a separate non-sudo guest user and a private network namespace by default.

Check out this branch on Chasebot, build it with Node.js 22, and merge this setting into its `$ORCH_HOME/config.json`. Projects that opt into VM gates should use tools present in the Debian image or explicitly arrange their prerequisites. Git submodules and untracked files are outside a Git archive.

```json
{
  "security": {
    "devVmGateCommand": "/home/cpederson/.local/bin/devvm",
    "gateNetwork": false
  }
}
```

For a manual check of the same backend from a Git checkout on Chasebot, run:

```sh
git archive HEAD | ~/.local/bin/devvm gate -- '. /etc/os-release; test "$VERSION_ID" = 13'
```

## Windows and Chasebot setup

1. On Chasebot, generate a dedicated Ed25519 key with `ssh-keygen -t ed25519 -f ~/.local/share/devvm/windows_ed25519 -N ''`, using a data directory with mode 700. Supply only the resulting public key file to the Windows installer. Install `devvm` with mode 700 into `~/.local/bin`, and the two `devvm-prune` units in `~/.config/systemd/user`. Enable the timer with `systemctl --user daemon-reload && systemctl --user enable --now devvm-prune.timer`.
2. On Windows, run `Prepare-Assets.ps1 -Destination <asset-directory>`. It verifies the fixed Debian, Terraform and pycdlib downloads. With an elevated PowerShell, run `Install-Windows.ps1 -Assets <asset-directory> -ControllerKeyFile <chasebot-key.pub> -Result <install.json>`. It creates the standard local account `aidevvm`, grants its batch logon right, starts `AIDevVM-Worker`, and brings up the SSH listener on port 2224. A clean installation expects the Windows OpenSSH service to be stopped and its server config to be absent.
3. Transfer the **public** host key from the Windows result over a trusted channel. Write a single line to Chasebot's `~/.local/share/devvm/windows_known_hosts` containing `[192.168.40.136]:2224` followed by the two key fields `ssh-ed25519 BASE64`. Run `devvm wake`, then run `python3 acceptance.py` on Chasebot for the real lifecycle checks.

4. On this host, move the worker to the signed-in desktop account. From an elevated PowerShell started by that account, run `Use-DesktopWorker.ps1 -DesktopUser <account>` (add `-Resume` to finish an interrupted run). The `aidevvm` account stays the SSH entry point and can only queue requests in the spool folder. The reason: this CPU exposes no AMD-V to VirtualBox, so VirtualBox uses the Windows Hypervisor Platform (NEM). In the `aidevvm` batch session (session 0), VirtualBox's hardening rejects `WinHvPlatform.dll` as unsigned, and `startvm` fails with `VERR_NEM_INIT_FAILED`. In the desktop session it loads normally. The tradeoff: leases run with that account's token and only while it is signed in, because the task starts at logon.

The Windows program is in `C:\ProgramData\AIDevVM`. With the desktop worker, its data, VirtualBox registry, and Terraform lease state live under `E:\AIDevVM-Desktop` (the original `E:\AIDevVM` is left unused). The worker's separate `VBOX_USER_HOME` starts its own VBoxSVC, so the account's personal VirtualBox VMs are not affected.

Under NEM, a fresh guest takes about 2.5 minutes to finish first boot and cloud-init, and longer when several boot at once. `devvm provision` waits up to 7 minutes (capped at the lease's expiry). The orchestrator backend adds a 12-minute VM lifecycle allowance on top of each gate's `timeout_sec`. The Debian base disk is shared read-only as the source for independent full clones. Check failed starts with `Get-ScheduledTaskInfo AIDevVM-Worker`, `Get-Content E:\AIDevVM-Desktop\worker.log -Tail 30`, and the Windows OpenSSH event log. Keep any lease records with cleanup errors so the reaper can retry them.

## Integration decision

| Integration | Finding |
| --- | --- |
| `terra-farm/virtualbox` | Its registry release was the 2021 alpha. The project uses Vagrant-style VM image assumptions. [Release history](https://github.com/terra-farm/terraform-provider-virtualbox/releases) |
| `eran132/vbox` | The fork publishes a Windows amd64 binary and uses VBoxManage. The Windows artifact establishes distribution coverage. This installation needs control over cloud-init, Windows session ownership, host admission, SSH restrictions, and recovery outside Terraform. [Provider repository](https://github.com/eran132/terraform-provider-vbox) |
| `terraform_data` and VBoxManage | The selected integration uses Terraform's built-in lifecycle and Oracle's installed CLI. The host worker reconciles partial applies and verifies deletion independently because Terraform can skip the destroy provisioner for tainted state. The worker is the supported entry point for these leases. [Terraform provisioners](https://developer.hashicorp.com/terraform/language/provisioners) · [VirtualBox 7.2 manual](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/) |
