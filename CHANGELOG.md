# Changelog

## 0.1.1 (2026-11-28)

Fixes for defects found by the first operator verification on real infrastructure: a fresh Ubuntu 24.04 VM, systemd
units, live GitHub with branch protection, and HawkScan (`docs/evidence/operator-verification/REPORT.md`). Each fix was
independently reviewed (PRs #63 and #64). Code fixes have regression tests; the installer, dashboard-token and
`doctor` reporting changes are not covered by automated tests. **Upgrade from 0.1.0 is recommended**:
0.1.0 can run agents unconfined when bubblewrap is broken.

### Security
- The sandbox fails closed. With the default `auto`, a missing or broken bubblewrap used to run agents and gates
  unconfined with only a warning. Now agents are not dispatched and gates are recorded as errors. An explicit `"none"`
  is required to run unconfined, and is audited at every start.
- The sandbox self-check uses the same mounts and namespaces as the real sandboxes and runs inside the service.
  `doctor` reports its result.
- Provider CLIs installed under a hidden home are bound read-only as their package or single binary. A hidden root such
  as `$HOME` is never re-exposed.
- Dashboard tokens are printed only to a terminal. Otherwise they are written to `secrets/dashboard-token` (0600).

### GitHub mode
- Git pushes now carry the supervisor's token, injected per call through the environment and never written to disk.
  Before this, pushes had no credentials of their own and failed unless the host already had git credentials set up.
- Reconciliation compares GitHub with both the last synced state and the state the local status implies. Merges, and
  "Closes #N" closing an issue, are no longer misread as human changes. That misreading caused a re-integration loop
  of 4,892 pushes.
- Human reopens of merged or cancelled items return them to the backlog. Reverted external changes are restored
  once. Every GitHub-driven transition is audited.
- Rejected pushes back off (30 s, 1, 2, 4 min), then block. A missing `workflow` scope, or bad credentials, blocks at
  once with the exact fix. An item that is backing off gives up the integration slot.
- Items already finished at their first sync get closed issues.

### Operations
- systemd: `PrivateTmp` removed from the user unit; `ProtectKernelTunables` and `ProtectKernelLogs` removed from the
  system unit. All three break bubblewrap.
- `install.sh` falls back to a `~/.local` npm prefix when the global prefix isn't writable. It checks bubblewrap with
  the real flags and offers the Ubuntu 24.04 AppArmor profile, with consent.
- Capacity: a usage limit without a reset time triggers an immediate usage-free probe to get the provider's real
  reset.
- Per-item limits restart after an operator unblock or a human reopen; post-merge verification runs again in that case.

### Docs
- The PAT needs the `repo`, `project` and `workflow` scopes. Troubleshooting now covers AppArmor and systemd.
- The acceptance matrix records the operator results, including what has not yet been re-verified.

## 0.1.0 (2026-11-27)
First release. See `docs/acceptance-matrix.md` and `docs/evidence/`.
