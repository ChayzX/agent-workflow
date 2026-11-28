# devvm status / handoff

## Working and verified live (Chasebot -> Windows host), 2026-11-28, before the 0.1.1 integration
- Worker runs in the desktop session (`Use-DesktopWorker.ps1`), because VirtualBox hardening rejects
  WinHvPlatform.dll in the `aidevvm` session-0 batch logon. This host is NEM-only (no AMD-V exposed).
- `acceptance.py` passed on Chasebot (254 s): two concurrent Debian 13 VMs, requested vCPU/RAM/disk, file and SSH-key
  isolation, aggregate vCPU limit, reaper removing an expired lease.
- Orchestrator gate backend: the archive reached the guest, and real exit codes were recorded (`capture-real-exit`
  returned 7).

## Resolved in the 0.1.1 integration (repository tests; NOT yet re-run on the real host)
- **Smoke gate 1 (`debian-and-network-namespace`).** Likely cause found: in a fresh network namespace, current
  kernels create the main routing table lazily, so `/proc/net/route` is *empty* (0 lines, no header). The check
  "`/proc/net/route` has 1 line" fails even though the namespace is isolated. Reproduced on Linux 6.18 in the
  repository test `devvm smoke gate 1`. The four checks now live in `gate-smoke.sh` (one gate each, so a failure names
  the check), and the network check (`netns-check.sh`) looks at `/proc/net/dev` (only `lo`) and counts routes after
  the header. **Pending:** the operator runs `sh deploy/devvm/gate-smoke.sh` on Chasebot.
- **`prune` removes lock-only lease folders.** `provision` re-checks the lock's inode after locking, so a concurrent
  prune cannot strand it. Covered by the repository test `devvm CLI: prune ...`.
- **Wake-on-LAN acceptance.** `wake_acceptance.py` was not in the repository; a new one is in this folder.
  **Pending:** the operator puts the PC to sleep and runs `python3 deploy/devvm/wake_acceptance.py` on Chasebot.
- **Host-specific values** (LAN addresses, MAC, account name) moved out of the code: `devvm` reads
  `~/.local/share/devvm/config.json`; `Install-Windows.ps1` takes `-ControllerAddress` and `-ListenAddress`.
  The earlier values remain in the public history of `claude/devvm-vm-gates`; removing them needs a history rewrite,
  which is destructive and needs the operator's approval.
- **Unavailable vs failed.** `devvm gate` exits 75 when it cannot get a VM (asleep, pause, capacity, provisioning
  error) and reports a lost SSH connection; the orchestrator then waits instead of recording a gate failure.
