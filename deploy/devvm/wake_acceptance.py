#!/usr/bin/env python3
"""Operator-run Wake-on-LAN acceptance test, run on Chasebot.

Put the gaming PC to sleep first (Start > Power > Sleep), wait until it is fully asleep, then run:
    python3 deploy/devvm/wake_acceptance.py [path-to-devvm]
It proves: the PC is unreachable while asleep; `devvm wake` wakes it and gets the worker's authenticated health
response; a lease can be provisioned, used and destroyed right after the wake. Prints PASS lines and timings.
"""

import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

DEVVM = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / ".local" / "bin" / "devvm"


def cli(*args, timeout=900):
    return subprocess.run([str(DEVVM), *map(str, args)], capture_output=True, text=True, timeout=timeout)


def main():
    probe = cli("reachable", timeout=30)
    if probe.returncode or json.loads(probe.stdout)["reachable"]:
        print("ABORT: the gaming PC's devvm listener is reachable. Put the PC to sleep and run this again.")
        return 2
    print("PASS asleep: listener unreachable before the wake")
    started = time.monotonic()
    woke = cli("wake")
    elapsed = time.monotonic() - started
    if woke.returncode:
        print(f"FAIL wake (exit {woke.returncode}) after {elapsed:.0f}s: {woke.stderr.strip()}")
        return 1
    health = json.loads(woke.stdout)
    if not health.get("ready"):
        print(f"FAIL wake: worker answered but reports not ready: {health}")
        return 1
    print(f"PASS wake: worker healthy after {elapsed:.0f}s ({health.get('vbox')})")
    value = uuid.uuid4().hex
    try:
        started = time.monotonic()
        lease = cli("provision", "--id", value, "--cpus", 1, "--ram-mib", 1024, "--disk-gib", 8, "--ttl-minutes", 15)
        if lease.returncode:
            print(f"FAIL provision after wake: {lease.stderr.strip()}")
            return 1
        print(f"PASS provision after wake in {time.monotonic() - started:.0f}s")
        run = cli("ssh", value, ". /etc/os-release && echo $VERSION_ID")
        if run.returncode or run.stdout.strip() != "13":
            print(f"FAIL guest command: {run.returncode} {run.stdout.strip()} {run.stderr.strip()}")
            return 1
        print("PASS guest command ran on Debian 13")
    finally:
        gone = cli("destroy", value)
        print("PASS destroy" if not gone.returncode else f"FAIL destroy: {gone.stderr.strip()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
