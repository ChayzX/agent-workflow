#!/bin/sh
# Prints "isolated" and exits 0 when the calling process has no network interface other than loopback.
# Used by gate-smoke.sh inside a guest and by the repository's tests under `unshare --net`.
#
# Do not count lines of /proc/net/route: in a fresh network namespace the kernel creates the main routing table
# lazily, so the file is EMPTY (no header line) on current kernels, and has a header on others. /proc/net/dev
# always lists the namespace's own interfaces after two header lines.
set -eu
interfaces=$(awk -F: 'NR > 2 { gsub(/ /, "", $1); print $1 }' /proc/net/dev)
routes=$(awk 'NR > 1' /proc/net/route | wc -l)
if [ "$interfaces" = "lo" ] && [ "$routes" -eq 0 ]; then
  echo isolated
  exit 0
fi
echo "not isolated: interfaces=[$(echo $interfaces)] routes=$routes"
exit 1
