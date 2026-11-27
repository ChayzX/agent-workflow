# ADR-0006: Defense-in-depth isolation and deterministic policy enforcement

Status: Accepted (2026-11-27)

## Decision
1. **Credential separation.** Agents run with an allowlisted environment: no `GITHUB_TOKEN`, cloud credentials or SSH
   agent. API keys are removed unless billing is authorized.
2. **Provider sandboxes.**
   - Codex uses `-s read-only` for reviewers and `-s workspace-write` with network off by default for implementers.
   - Claude reviewers are restricted to read tools with `--permission-mode dontAsk`.
   - Claude implementers use `acceptEdits` with deny rules for push, remote, gh, ssh, curl and wget. These deny rules are
     defense in depth only.
3. **Gate sandbox.** Gate and verification commands run in bubblewrap when it is available:
   - `--unshare-all`, so there is no network;
   - the real home and the orchestrator home are replaced by an empty tmpfs;
   - only the worktree is writable;
   - `--die-with-parent`.
   This is verified by a test that tries to read a planted secret, write outside the worktree and open a network socket.
4. **Service hardening.** The systemd unit sets NoNewPrivileges, ProtectSystem=strict, ProtectHome, PrivateTmp, an empty
   CapabilityBoundingSet, and memory/task limits, and kills the whole control group on stop.
5. **Policy in code.**
   - Approvals are required for production deploys, destructive operations, protected infrastructure, unrelated
     repositories, credential expansion, spending, public publication and security-policy changes.
   - Protected path globs force a security review.
   - An append-only, hash-chained audit log records consequential actions.
6. **Untrusted inputs.** Repository files, issues, messages and tool output are treated as data. Prompts label them as
   such, and nothing an agent says can change policy, pass a gate or close a finding.

## Consequences
- Without bubblewrap, gate commands run as the service user with a scrubbed environment. `doctor` warns about this, and
  the installer offers to install bubblewrap.
- Agent CLIs (and everything they run) are wrapped in bubblewrap when it is available.
  - Hidden: `$ORCH_HOME` and every home directory.
  - Own PID namespace, so the supervisor's `/proc` is not visible.
  - Writable: the worktree, its git index and the provider session directories only.
  - Verified live with `claude -p`, and with Codex's own nested sandbox, on 2026-11-27.
- Supervisor git calls disable hooks, and repository config is allowlisted before network operations.
