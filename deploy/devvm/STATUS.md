# devvm status / handoff (2026-11-28)

## Working and verified live (Chasebot -> Windows host)
- Worker runs in the desktop session (`Use-DesktopWorker.ps1`). Data is in `E:\AIDevVM-Desktop`.
  It runs there because VirtualBox hardening rejects WinHvPlatform.dll in the aidevvm
  session-0 batch logon. This host is NEM-only (no AMD-V exposed).
- `acceptance.py` passes on Chasebot (254 s): two concurrent Debian 13 VMs, requested
  vCPU/RAM/disk, file and SSH-key isolation, aggregate vCPU limit, reaper removing
  an expired lease.
- Orchestrator gate backend: the archive reaches the guest, and real exit codes are
  recorded (`capture-real-exit` returned 7).

## Fixed in this push (devvm CLI)
- Cloud-init wait raised from 125 s to 420 s. First boot under NEM takes ~2.5 min.
- Provisioning ssh/ssh-keygen calls used to inherit stdin and swallow the gate's tar
  archive. They now use stdin=DEVNULL.
- The gate used to `cd` into a devgate-owned 0700 directory as `dev`. It now uses
  `env -C` as devgate.

## In progress / next
- `work/orchestrator-vm-smoke.mjs` (outside the repo, on Chasebot at
  ~/.local/share/devvm/) still fails gate 1 (`debian-and-network-namespace`)
  with exit 1 and no output. One of these checks fails:
  probe.txt content, VERSION_ID=13, `id -un`=devgate, or `/proc/net/route` having 1 line.
  Suspect: the route check inside `unshare --net` (with --mount-proc, /proc/net may
  still show the host netns). Next step: run
  `git archive HEAD | devvm gate -- 'echo $(id -un); wc -l < /proc/net/route; ...'`
  from a scratch repo on Chasebot and fix either the check or the namespace setup.
- Lease folders on Chasebot (~/.local/share/devvm/leases/<id>/lock) are never removed.
  `prune` could rmdir lock-only folders.
- Not yet run after these fixes: `wake_acceptance.py` (Wake-on-LAN path).
