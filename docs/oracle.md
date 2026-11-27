# Deploying orchestrator-built projects to Oracle Cloud (OCI)

Operator guide for the package in [`deploy/oci/`](../deploy/oci/README.md). This guide covers
the **finished projects** the orchestrator builds, such as a multi-tenant Twitch/Discord
bot. It does not cover the orchestrator itself: the orchestrator is self-hosted (see
`deploy/install.sh`) and **never needs Oracle connectivity to run normally**. If OCI is
unreachable or not configured, building, verifying and releasing projects all keep working.
Only the deploy step is unavailable.

> **Status: templates only.** Nothing in this package has been deployed to, or tested
> against, a real OCI tenancy or OKE cluster in this build. See "Verified vs unverified".

## Hard rules (Pantry Bot)

The target tenancy already runs **Pantry Bot**, a critical service that is unrelated to the
orchestrator. For every project:

- Never modify Pantry Bot. Never read or reuse its credentials, secrets, vaults, OCIR
  repositories, IAM groups or namespaces.
- Each project gets its **own** compartment, namespace, ServiceAccounts, RBAC, quota and
  secrets. No project gets unbounded resources on any host or cluster Pantry Bot uses.
- Preferred: run orchestrator projects on a **separate OKE cluster** (or a separate VM) in
  their own `orch-projects` compartment. If a shared cluster is unavoidable, the namespace
  guardrails below are the boundary, and `preflight.sh` must pass before every deploy.

## Prerequisites

- An OCI tenancy administrator (a human) for the one-time setup.
- An OKE cluster with a CNI that **enforces NetworkPolicy**, such as Calico on flannel
  clusters. For VCN-native pod networking, verify against current OCI docs.
- The OKE Block Volume CSI driver (storage class `oci-bv`). For Block Volume snapshots, the
  VolumeSnapshot CRDs and a snapshot class.
- Optional but recommended: the External Secrets Operator and OKE workload identity
  (enhanced cluster).
- Locally: `kubectl` (v1.14 or later includes kustomize), `bash`, and `oci` CLI for backups.

## One-time tenancy setup (administrator)

1. Create the compartment `orch-projects`, with one child compartment per project:
   `orch-projects:<project>`.
2. Create the groups, the dedicated OCIR pull user and the dynamic groups. Then apply the
   least-privilege statements from [`iam-policies.example.txt`](../deploy/oci/iam-policies.example.txt).
   Every statement is scoped to the project compartment, never to `in tenancy`, and never to
   Pantry Bot's compartment. Statements marked **VERIFY** must be checked against current
   OCI docs.
3. Create one OCI Vault per project (or one vault for all orchestrator projects, with a
   secret naming convention) and an OCIR repository `orch/<project>/app`.

## Per-project instantiation

```bash
cp -r deploy/oci/overlays/example-project deploy/oci/overlays/<project>
# edit: namespace orch-<project>, namePrefix <project>-, orchestrator.dev/project label,
#       images[].newName (this project's OCIR repo) and images[].digest (release digest)
# edit the base values if needed: quota sizes, egress CIDR allowlist (placeholder 203.0.113.0/24),
#       ingress-controller namespace, probe paths (/healthz, /readyz), port 8080
kubectl kustomize deploy/oci/overlays/<project>   # render and review; no cluster needed
```

A cluster administrator applies the **guardrails** layer once:

```bash
kubectl --context <admin-ctx> apply -k deploy/oci/overlays/<project> -l orchestrator.dev/layer=guardrails
```

Next, create the secrets out of band. Never put them in git, and never in an agent session:

- App secrets: use an `ExternalSecret` from OCI Vault (`base/secret.template.yaml`), or a
  SealedSecret. The resulting Secret is named `app-secrets`.
- OCIR pull secret `ocir-pull`: use the auth token of the dedicated read-only user
  `orch-pull-<project>` (`base/registry-secret.template.yaml`).

Finally, issue the deploy runner a **short-lived, namespace-scoped** credential:

```bash
kubectl --context <admin-ctx> -n orch-<project> create token <project>-deployer --duration=1h
# build a kubeconfig with that token, the cluster CA and `namespace: orch-<project>`;
# hand it to the runner only for the approved deploy window
```

## Deployment paths, in order of preference

1. **Namespace-scoped deploy runner.** This is a process, either in-cluster or on a
   dedicated runner host, that uses the `<project>-deployer` ServiceAccount (`base/rbac.yaml`):
   - It holds a Role and RoleBinding in the project namespace only. It has no ClusterRole,
     no wildcards, no Secret access, no delete, no exec.
   - It can view the guardrails (NetworkPolicy, quota, LimitRange) but cannot change them.
   - Its token is short-lived (TokenRequest, 1h), not a long-lived token Secret.
2. **OCI DevOps deployment pipeline.** The pipeline runs in the project compartment, with a
   dynamic group scoped to that compartment and cluster (`iam-policies.example.txt` §5).
   Verify which Kubernetes identity the OKE stage uses, and bind it to the namespace Role
   only.
3. **Restricted SSH to a VM, as a fallback.** See
   [`ssh-restricted-runner.md`](../deploy/oci/ssh-restricted-runner.md). The rules are:
   - a dedicated non-root account;
   - `restrict,from=,command=` in authorized_keys, and an sshd `Match` block with
     `ForceCommand`;
   - pinned `known_hosts` with `StrictHostKeyChecking=yes`;
   - no sudo, or a single exact sudoers rule;
   - approved destinations only.

   Never unrestricted root or unrestricted sudo.

Pull or outbound models (1, 2, or a pull agent on the VM) are preferred over inbound SSH.

## Approval flow (`production_deploy`)

A production deploy is an **authorized action**. `production_deploy` is in
`security.approvalRequiredFor` by default (`src/core/config.ts`), and the deterministic
policy layer (`src/security/policy.ts`) records approvals. Agent output cannot authorize a
deploy.

1. The orchestrator finishes a project and produces a **verified release**
   (`orchestrator release <project>`). The release contains the image digest and the rendered
   overlay for that digest.
2. A deploy needs an approval request: action `production_deploy`, with a payload that
   includes the project, the namespace, the cluster context and the **image digest**.
3. The operator reviews it, then runs `orchestrator approvals list` followed by
   `orchestrator approvals approve <ID>` (or `deny <ID>`), or uses the dashboard. The
   decision goes into the audit log.
4. The deploy can run only after approval, and only for exactly that digest and target. A
   new digest is a new approval.

**The orchestrator never deploys to production without an approved `production_deploy`.**
In this build, the orchestrator does not contain a built-in OCI or Kubernetes deploy
executor. It only has the approval gate and these manifests. The deploy itself is done by
the scoped runner or pipeline above, which the operator triggers after approval. Any future
automated deploy step must check the approval status for the matching dedup key first.

## Deploy

```bash
CTX=orch-<project>; NS=orch-<project>
deploy/oci/preflight.sh --context "$CTX" --namespace "$NS"       # must exit 0
kubectl --context "$CTX" diff  -k deploy/oci/overlays/<project> -l orchestrator.dev/layer=workload
kubectl --context "$CTX" apply -k deploy/oci/overlays/<project> -l orchestrator.dev/layer=workload
kubectl --context "$CTX" -n "$NS" rollout status deployment/<project>-app --timeout=5m
```

`preflight.sh` is read-only: it only runs `get`, `auth can-i` and `config view`. It fails
in these cases:

- the namespace matches the Pantry Bot deny list (default `pantry-bot pantrybot pantry`;
  override with `--deny` or `PREFLIGHT_DENY_NAMESPACES`), or is a system namespace;
- `kubectl auth can-i --list -n NS` shows wildcard permissions, wildcard verbs on Secrets, or
  write access to the guardrails;
- the identity has cluster-wide, system-namespace or Pantry Bot namespace access;
- the default-deny NetworkPolicy, ResourceQuota or LimitRange is missing, or a policy allows
  `0.0.0.0/0`;
- the namespace's PodSecurity label is not `restricted`.

## Verify (health checks)

- Probes: `startupProbe` and `livenessProbe` on `/healthz`, `readinessProbe` on `/readyz`
  (port 8080). The project must implement these endpoints.
- `kubectl -n $NS get deploy,pods,pdb,pvc` should show the rollout complete and the pods
  `Ready`.
- `kubectl -n $NS get events --sort-by=.lastTimestamp` should show no PSA, quota or probe
  failures.
- Run an app-level smoke check through the ingress (or `kubectl port-forward` as an admin;
  the runner has no port-forward permission).
- Confirm that the running image matches the approved digest:
  `kubectl -n $NS get deploy <project>-app -o jsonpath='{..image}'`.

## Rollback

- **Fast:** `kubectl -n $NS rollout undo deployment/<project>-app` (the Deployment keeps 10
  ReplicaSets in `revisionHistoryLimit`), then `rollout status`.
- **Authoritative:** re-apply the **previous release's** overlay, which pins the previous
  digest. Then git and the cluster agree, and the next apply does not roll forward by
  accident. Images are always referenced by `@sha256:` digest, never by a mutable tag.
- If a schema migration ran, restore the database dump or volume backup taken before it
  (see below). Code rollback alone is not enough after a non-backward-compatible migration.
- Deleting resources is a `destructive_operation`. It needs separate approval and is done by
  an administrator; the runner has no delete permission.

## Backup

Back up before **every** deploy that includes a migration, and on a schedule:

- **Database dump:** before migrating, dump to a file stored outside the namespace's
  volume, for example Object Storage in the project compartment. For example
  `pg_dump -Fc` for Postgres, or `sqlite3 /data/app.db ".backup /data/backup-<ts>.db"` for
  SQLite. Record the dump in the approval payload.
- **Volume:** take an OCI Block Volume backup of the PVC's volume:
  - `oci bv backup create --volume-id <ocid> --type INCREMENTAL --display-name <project>-<ts>`
  - or a CSI `VolumeSnapshot`.

  Restore by creating a new PVC from the backup or snapshot. The quota allows a second PVC
  for this. Verify the CLI flags against current OCI docs.
- **Policies:** set a Block Volume backup policy (retention) on project volumes in the
  project compartment only.
- Test restores periodically. A backup that has never been restored is unverified.

## Isolation guarantees vs Pantry Bot

| Layer | Control | File |
| --- | --- | --- |
| IAM | Per-project compartment and groups; no `in tenancy`, no Pantry Bot compartment | `iam-policies.example.txt` |
| Cluster | Prefer a separate cluster; otherwise a dedicated namespace | overlay `namespace` |
| API access | Namespace Role/RoleBinding only, no ClusterRole, no Secret access, no wildcards | `base/rbac.yaml` |
| Network | Default-deny ingress and egress; DNS to kube-dns; HTTPS to allowlisted CIDRs only | `base/networkpolicy.yaml` |
| Resources | ResourceQuota and LimitRange; no LoadBalancer or NodePort | `base/resourcequota.yaml`, `base/limitrange.yaml` |
| Pods | PSA `restricted`; non-root, read-only root filesystem, all capabilities dropped, seccomp RuntimeDefault, no privilege escalation, no API token | `base/namespace.yaml`, `base/deployment.yaml` |
| Secrets | Per-project vault and pull user; templates only | `base/*.template.yaml` |
| Guard | Read-only preflight with the Pantry Bot deny list | `preflight.sh` |

Limits to be aware of:

- On a shared cluster, nodes, the kernel and the control plane are still shared, so
  namespaces are a soft boundary.
- NetworkPolicy only works if the CNI enforces it.
- Projects must not use high or system PriorityClasses, which could preempt Pantry Bot pods.
- The deny list matches names only. Set it to Pantry Bot's real namespace names.

## Can a Codex Cloud task or Claude Code cloud session deploy to OCI?

**Technically possible, but not recommended, and not how this package is designed.**

- Cloud agent sessions should **not hold production credentials**. That includes OCI API
  keys, kubeconfigs, OCIR tokens and SSH deploy keys. A session that runs agent-generated
  code, reads untrusted repository content or has internet access can leak or misuse any
  credential it can read. A compromise could reach Pantry Bot's tenancy.
- Codex Cloud environments have agent internet access **off by default**, and secrets are
  available only to setup scripts, not to the agent phase. Storing OCI credentials there is
  discouraged. They would be available to setup code on every run, and using them during the
  agent phase would mean weakening those defaults.
- Claude Code cloud sessions run in sandboxed containers with proxied, policy-controlled
  network access. The same principle applies: do not place production credentials in the
  session or its environment.

**Recommended pattern:**

1. The orchestrator (or a cloud agent session) produces a **verified release** and its
   **rendered manifests**, with the image pinned by digest.
2. The **operator approves** `production_deploy` for that exact digest and target.
3. A **scoped deploy runner** (an OCI DevOps pipeline or the namespace-scoped runner with a
   1h token) performs the deployment and reports back. The credentials stay with that
   runner.

## Verified vs unverified

Verified in this build (locally, with no cloud access):

- `kustomize build deploy/oci/overlays/example-project` (kustomize v5.4.3) renders
  successfully. The `namespace` and `namePrefix` settings propagate to every object. The
  RoleBinding subject resolves to `<project>-deployer` in the project namespace. The
  kube-dns selector stays untouched. The image is pinned by digest.
- All YAML files parse, including the templates.
- `bash -n deploy/oci/preflight.sh` passes. Its pass and fail logic was exercised against a
  stubbed `kubectl`, not a real cluster.

Unverified:

- Nothing was deployed to a real OCI tenancy or OKE cluster.
- The OCI IAM statements, especially those marked VERIFY.
- The OKE workload identity variables, the ESO OCI provider fields and the OCIR username
  format.
- The DevOps pipeline permissions, NetworkPolicy enforcement by the cluster CNI, the `oci-bv`
  storage class and minimum volume size, and the Block Volume CLI flags.
- Server-side admission (PSA, quota) of the rendered objects.
- The SSH runner configuration.

Validate all of these in a non-production compartment before the first real deploy.
