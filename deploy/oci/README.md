# OCI deployment package (for projects the orchestrator builds)

Templates for deploying a finished, verified project to an Oracle Cloud (OKE) tenancy, each
project fully isolated in its own namespace and compartment, and kept away from Pantry Bot.
Nothing here is needed for normal orchestrator operation, and nothing here has been
deployed to a real tenancy.

Read **[docs/oracle.md](../../docs/oracle.md)** before using anything here.

| Path | Purpose |
| --- | --- |
| `base/` | Kustomize base: namespace (PSA restricted), service accounts, namespace-scoped RBAC, default-deny NetworkPolicies, ResourceQuota, LimitRange, PVC, Deployment, Service, PDB |
| `base/*.template.yaml` | App secret (OCI Vault + External Secrets) and OCIR pull secret templates; never rendered, never real values |
| `overlays/example-project/` | Copy per project; sets `namespace`, `namePrefix`, project label, image digest |
| `iam-policies.example.txt` | Least-privilege OCI IAM policy examples per project compartment |
| `ssh-restricted-runner.md` | Fallback restricted SSH runner for VMs (forced command, pinned host keys) |
| `preflight.sh` | Read-only checks before a deploy; exits non-zero on violations |

```bash
kubectl kustomize deploy/oci/overlays/example-project        # render, no cluster needed
deploy/oci/preflight.sh --context orch-example-project --namespace orch-example-project
```
