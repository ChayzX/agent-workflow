#!/usr/bin/env bash
# Read-only preflight for deploying an orchestrator-built project to Kubernetes (OKE).
#
# It NEVER creates, modifies or deletes anything. It only runs `kubectl get`,
# `kubectl auth can-i` (a SelfSubjectAccessReview: evaluated by the API server, not stored)
# and `kubectl config view`.
#
# Usage:
#   deploy/oci/preflight.sh --context CTX --namespace NS [--deny "pantry-bot pantrybot pantry"]
#   env: PREFLIGHT_DENY_NAMESPACES overrides the default deny list; KUBECTL overrides binary.
#
# Exit: 0 = all checks passed, 1 = at least one violation, 2 = usage / tooling error.
set -u -o pipefail

DENY_DEFAULT="pantry-bot pantrybot pantry"
DENY="${PREFLIGHT_DENY_NAMESPACES:-$DENY_DEFAULT}"
SYSTEM_NS="default kube-system kube-public kube-node-lease"
KUBECTL="${KUBECTL:-kubectl}"
CTX=""
NS=""

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --context) CTX="${2:-}"; shift 2 ;;
    --namespace|-n) NS="${2:-}"; shift 2 ;;
    --deny) DENY="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$CTX" ] && [ -n "$NS" ] || { echo "error: --context and --namespace are required" >&2; usage >&2; exit 2; }
command -v "$KUBECTL" >/dev/null 2>&1 || { echo "error: kubectl not found" >&2; exit 2; }

VIOLATIONS=0
WARNINGS=0
fail() { echo "FAIL  $*"; VIOLATIONS=$((VIOLATIONS + 1)); }
warn() { echo "WARN  $*"; WARNINGS=$((WARNINGS + 1)); }
pass() { echo "OK    $*"; }
k() { "$KUBECTL" --context "$CTX" "$@"; }

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
NS_LC="$(lc "$NS")"

echo "preflight: context=$CTX namespace=$NS deny=[$DENY]"

# 1. Namespace must not be Pantry Bot's (substring, case-insensitive) or a system namespace.
denied=0
for d in $DENY; do
  d_lc="$(lc "$d")"
  case "$NS_LC" in *"$d_lc"*) fail "namespace '$NS' matches deny-list entry '$d' (Pantry Bot is off limits)"; denied=1 ;; esac
done
for s in $SYSTEM_NS; do
  [ "$NS_LC" = "$s" ] && { fail "namespace '$NS' is a system namespace"; denied=1; }
done
[ "$denied" -eq 0 ] && pass "namespace '$NS' is not on the deny list"
case "$NS_LC" in orch-*) ;; *) [ "$denied" -eq 0 ] && warn "namespace '$NS' does not use the orch-<project> naming convention" ;; esac
# Refuse to continue against a denied namespace at all (no further API calls into it).
if [ "$denied" -ne 0 ]; then echo "result: $VIOLATIONS violation(s)"; exit 1; fi

# 2. Context must exist; warn if its name/cluster/user mentions a deny-list entry.
if ! ctx_info="$("$KUBECTL" config view -o jsonpath="{.contexts[?(@.name==\"$CTX\")].context}" 2>/dev/null)" || [ -z "$ctx_info" ]; then
  echo "error: context '$CTX' not found in kubeconfig" >&2; exit 2
fi
for d in $DENY; do
  case "$(lc "$CTX $ctx_info")" in *"$(lc "$d")"*) warn "context '$CTX' ($ctx_info) mentions '$d' - confirm this is not Pantry Bot's cluster/identity" ;; esac
done
ctx_ns="$("$KUBECTL" config view -o jsonpath="{.contexts[?(@.name==\"$CTX\")].context.namespace}" 2>/dev/null || true)"
if [ -n "$ctx_ns" ] && [ "$ctx_ns" != "$NS" ]; then warn "context default namespace is '$ctx_ns', not '$NS'"; fi

# 3. Permissions of this identity in the project namespace.
if ! cani="$(k auth can-i --list -n "$NS" 2>&1)"; then
  fail "kubectl auth can-i --list failed: $(printf '%s' "$cani" | head -n 3)"
else
  echo "----- kubectl auth can-i --list -n $NS -----"
  printf '%s\n' "$cani"
  echo "--------------------------------------------"
  # Columns: Resources  Non-Resource URLs  Resource Names  Verbs
  viol="$(printf '%s\n' "$cani" | awk 'NR>1 && NF>0' | while IFS= read -r line; do
    res="$(printf '%s' "$line" | awk '{print $1}')"
    verbs="$(printf '%s' "$line" | grep -o '\[[^]]*\]$' || true)"
    case "$res" in
      '*'|'*.*') echo "VIOL wildcard resource: $line" ;;
    esac
    case "$res" in
      secrets|secrets.*|'*.secrets')
        case "$verbs" in *'*'*) echo "VIOL wildcard verbs on secrets: $line" ;; esac ;;
    esac
    case "$res" in
      roles.rbac.authorization.k8s.io|rolebindings.rbac.authorization.k8s.io|networkpolicies.networking.k8s.io|resourcequotas|limitranges|namespaces)
        case "$verbs" in *create*|*update*|*patch*|*delete*|*'*'*) echo "VIOL can modify guardrail resource: $line" ;; esac ;;
    esac
    case "$verbs" in \[\*\]) [ "$res" != "*" ] && [ "$res" != "*.*" ] && echo "VIOL wildcard verbs: $line" ;; esac
  done)"
  if [ -n "$viol" ]; then
    while IFS= read -r v; do fail "${v#VIOL }"; done <<<"$viol"
  else
    pass "no wildcard or guardrail-modifying permissions in '$NS'"
  fi
fi

# 3b. Cluster-wide and cross-namespace reach must be absent.
before=$VIOLATIONS
can() { k auth can-i "$@" >/dev/null 2>&1; }
can '*' '*' --all-namespaces && fail "identity has '*' on '*' cluster-wide (cluster-admin?)"
can create clusterrolebindings && fail "identity can create ClusterRoleBindings"
can create namespaces && fail "identity can create Namespaces"
can list secrets --all-namespaces && fail "identity can list Secrets in all namespaces"
for d in $DENY; do
  for verb_res in "get secrets" "list pods" "create deployments" "patch deployments"; do
    # shellcheck disable=SC2086
    can $verb_res -n "$d" && fail "identity can '$verb_res' in namespace '$d' (Pantry Bot)"
  done
done
for s in kube-system default; do
  can create deployments -n "$s" && fail "identity can create Deployments in '$s'"
done
[ "$VIOLATIONS" -eq "$before" ] && pass "no cluster-wide, system-namespace or Pantry Bot namespace access"

# 4. Guardrail objects must exist in the namespace.
np="$(k get networkpolicy -n "$NS" -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.spec.podSelector}{"|"}{.spec.policyTypes}{"|"}{.spec.ingress}{"|"}{.spec.egress}{"\n"}{end}' 2>&1)" || { fail "cannot list NetworkPolicies: $np"; np=""; }
if [ -n "$np" ]; then
  if printf '%s\n' "$np" | awk -F'|' '$2=="{}" && $3 ~ /Ingress/ && $3 ~ /Egress/ && $4=="" && $5=="" {f=1} END {exit !f}'; then
    pass "default-deny (ingress+egress) NetworkPolicy present"
  else
    fail "no default-deny NetworkPolicy (podSelector {} with policyTypes Ingress+Egress and no rules)"
  fi
  if printf '%s\n' "$np" | grep -q '0\.0\.0\.0/0'; then fail "a NetworkPolicy allows 0.0.0.0/0"; fi
else
  fail "no NetworkPolicy in '$NS'"
fi

for kind in resourcequota limitrange; do
  out="$(k get "$kind" -n "$NS" -o name 2>&1)" || { fail "cannot list $kind: $out"; continue; }
  if [ -n "$out" ]; then pass "$kind present: $(printf '%s' "$out" | tr '\n' ' ')"; else fail "no $kind in '$NS'"; fi
done

# 5. Pod Security Admission label (needs `get namespace`, which the deployer may lack).
if psa="$(k get namespace "$NS" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}' 2>/dev/null)"; then
  if [ "$psa" = "restricted" ]; then pass "PodSecurity enforce=restricted"; else fail "PodSecurity enforce label is '${psa:-unset}', expected 'restricted'"; fi
else
  warn "cannot read namespace labels (no 'get namespaces' permission) - verify PSA labels as an admin"
fi

echo "result: $VIOLATIONS violation(s), $WARNINGS warning(s)"
[ "$VIOLATIONS" -eq 0 ]
