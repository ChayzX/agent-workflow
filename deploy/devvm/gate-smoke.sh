#!/bin/sh
# Operator-run smoke test of `devvm gate` (STATUS.md, gate 1 "debian-and-network-namespace").
# Run on Chasebot as the account that owns devvm:   sh deploy/devvm/gate-smoke.sh [path-to-devvm]
# Each of the four original checks runs as its own gate so a failure names the check. Expect 4 PASS lines.
set -u
devvm=${1:-"$HOME/.local/bin/devvm"}
here=$(cd "$(dirname "$0")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
git -C "$scratch" init -q
printf 'probe-ok\n' > "$scratch/probe.txt"
cp "$here/netns-check.sh" "$scratch/netns-check.sh"
git -C "$scratch" add probe.txt netns-check.sh
git -C "$scratch" -c user.name=smoke -c user.email=smoke@localhost commit -q -m smoke
failed=0
check() {
  name=$1; command=$2
  output=$(git -C "$scratch" archive HEAD | "$devvm" gate -- "$command" 2>&1); status=$?
  if [ "$status" -eq 0 ]; then echo "PASS $name"; else echo "FAIL $name (exit $status)"; failed=1; fi
  printf '%s\n' "$output" | sed 's/^/    /'
}
check probe-content 'test "$(cat probe.txt)" = probe-ok && echo "probe.txt ok"'
check debian-13 '. /etc/os-release; echo "VERSION_ID=$VERSION_ID"; test "$VERSION_ID" = 13'
check gate-user 'echo "user=$(id -un)"; test "$(id -un)" = devgate'
check network-namespace 'echo "netns=$(readlink /proc/self/ns/net)"; echo "route lines=$(wc -l < /proc/net/route)"; sh ./netns-check.sh'
exit $failed
