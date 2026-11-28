#!/usr/bin/env python3
"""Exercise the live remote lifecycle from the Chasebot controller."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


DEVVM = Path.home() / ".local" / "bin" / "devvm"
KEYS = Path.home() / ".local" / "share" / "devvm" / "leases"


def cli(*args, check=True):
    result = subprocess.run([str(DEVVM), *map(str, args)], capture_output=True, text=True, timeout=900)
    if check and result.returncode:
        raise RuntimeError(f"devvm {args[0]} exited {result.returncode}: {result.stderr.strip()}")
    return result


def json_cli(*args):
    return json.loads(cli(*args).stdout)


def destroy(value):
    print(json_cli("destroy", value), flush=True)
    assert json_cli("status", value)["phase"] == "absent"
    assert not (KEYS / value / "identity").exists()


def provision(value, cpus, ram, disk, ttl=20, *extra):
    lease = json_cli("provision", "--id", value, "--cpus", cpus, "--ram-mib", ram,
                     "--disk-gib", disk, "--ttl-minutes", ttl, *extra)
    print({key: item for key, item in lease.items() if key != "host_key"}, flush=True)
    return lease


def main():
    print(json_cli("wake"), flush=True)
    a, b, limit, expired = [uuid.uuid4().hex for _ in range(4)]
    try:
        with ThreadPoolExecutor(2) as pool:
            first = pool.submit(provision, a, 2, 2048, 8)
            second = pool.submit(provision, b, 1, 1536, 10)
            assert first.result()["port"] != second.result()["port"]
        for value, cpus, ram, disk in ((a, 2, 2048, 8), (b, 1, 1536, 10)):
            details = cli("ssh", value, ". /etc/os-release && echo \"$VERSION_ID\" "
                          "&& hostname && nproc && lsblk -bdno SIZE /dev/sda && df -B1 --output=size / "
                          "&& awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo")
            data = details.stdout.split()
            assert data[:4] == ["13", f"adev-{value}", str(cpus), str(disk * 1024**3)], data
            assert int(data[-2]) > (disk - 1) * 1024**3
            assert ram - 256 <= int(data[-1]) <= ram, data
            print(f"Debian 13 and requested vCPU, memory and disk verified for {value}", flush=True)
        cli("ssh", a, "touch ~/only-first")
        cli("ssh", b, "test ! -e ~/only-first")
        wrong_key = cli("ssh", "--identity", KEYS / b / "identity", a, "true", check=False)
        assert wrong_key.returncode == 255 and "Permission denied" in wrong_key.stderr, wrong_key.stderr
        print("Files and SSH credentials were isolated across concurrent guests.", flush=True)
        oversized = cli("provision", "--id", limit, "--cpus", 4, "--ram-mib", 1024,
                        "--disk-gib", 8, check=False)
        assert oversized.returncode != 0 and "Aggregate cpus limit reached" in oversized.stderr, oversized.stderr
        print("Aggregate vCPU limit denied an overcommit request.", flush=True)
    finally:
        for value in (a, b, limit):
            destroy(value)
    try:
        # An external key skips the cloud-init wait, which cannot finish inside a 1-minute lease.
        scratch = Path(tempfile.mkdtemp())
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(scratch / "k")], check=True)
        provision(expired, 1, 1024, 8, 1, "--public-key", scratch / "k.pub")
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            if json_cli("status", expired)["phase"] == "absent":
                print("Windows reaper removed the expired VM without a destroy request.", flush=True)
                json_cli("list")
                cli("prune")
                assert not (KEYS / expired / "identity").exists()
                return
            time.sleep(4)
        raise AssertionError("Expired lease was not removed by its deadline")
    finally:
        destroy(expired)


if __name__ == "__main__":
    main()
