#!/usr/bin/env python3
"""Operator-run egress acceptance test, run on Chasebot after Set-EgressFirewall.ps1 and the egress proxy are set up.

    python3 deploy/devvm/egress_acceptance.py --proxy http://<chasebot-ip>:3128 --chasebot <chasebot-ip> \
        --gateway <router-ip> --pc <gaming-pc-ip> [--deny-host <pantry-bot-host> ...] [--deny-ip <ip> ...]

From inside a fresh guest it proves the one allowed path works and that every other destination is refused:
the internet directly, DNS, the router, the gaming PC itself, Chasebot's other ports, internal IPs through the proxy,
non-allowlisted names through the proxy, and every Pantry Bot host/IP you pass. Prints PASS/FAIL per check.
"""

import argparse
from pathlib import Path
import shlex
import subprocess
import sys
import uuid

DEVVM = Path.home() / ".local" / "bin" / "devvm"


def guest(lease, command, timeout=120):
    return subprocess.run([str(DEVVM), "ssh", lease, command], capture_output=True, text=True, timeout=timeout)


def tcp(host, port):
    return f"timeout 6 bash -c {shlex.quote(f'exec 3<>/dev/tcp/{host}/{port}')}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--proxy", required=True)
    parser.add_argument("--chasebot", required=True)
    parser.add_argument("--gateway", required=True)
    parser.add_argument("--pc", required=True)
    parser.add_argument("--allowed-url", default="https://registry.npmjs.org/")
    parser.add_argument("--deny-host", action="append", default=[])
    parser.add_argument("--deny-ip", action="append", default=[])
    parser.add_argument("--proxy-port", type=int, default=3128)
    args = parser.parse_args()
    lease = uuid.uuid4().hex
    failures = 0

    def check(name, command, expect_ok):
        nonlocal failures
        r = guest(lease, command)
        ok = (r.returncode == 0) == expect_ok
        failures += not ok
        print(f"{'PASS' if ok else 'FAIL'} {name} ({'allowed' if expect_ok else 'refused'} expected; exit {r.returncode})")
        if not ok:
            print("    " + (r.stdout + r.stderr).strip().replace("\n", "\n    ")[-800:])

    def via_proxy(url):
        return f"curl -sS -m 15 -o /dev/null -f -x {shlex.quote(args.proxy)} {shlex.quote(url)}"

    try:
        made = subprocess.run([str(DEVVM), "provision", "--id", lease, "--cpus", "1", "--ram-mib", "1024",
                               "--disk-gib", "8", "--ttl-minutes", "30"], capture_output=True, text=True, timeout=900)
        if made.returncode:
            print(f"ABORT: could not provision a guest: {made.stderr.strip()}")
            return 2
        check("allowlisted HTTPS through the proxy", via_proxy(args.allowed_url), True)
        check("non-allowlisted host through the proxy", via_proxy("https://example.com/"), False)
        check("IP literal through the proxy", via_proxy("https://1.1.1.1/"), False)
        check("internal address through the proxy", via_proxy(f"http://{args.gateway}/"), False)
        check("direct internet TCP 443", tcp("1.1.1.1", 443), False)
        check("direct internet TCP 80", tcp("93.184.215.14", 80), False)
        check("DNS resolution in the guest", "getent hosts deb.debian.org", False)
        check("direct DNS TCP 53", tcp("8.8.8.8", 53), False)
        for port in (53, 80, 443):
            check(f"router {port}", tcp(args.gateway, port), False)
        for port in (22, 135, 445, 2224, 3389):
            check(f"gaming PC {port}", tcp(args.pc, port), False)
        for port in (22, 80, 443, 7420):
            check(f"Chasebot port {port}", tcp(args.chasebot, port), False)
        check("Chasebot proxy port (the only open path)", tcp(args.chasebot, args.proxy_port), True)
        for host in args.deny_host:
            check(f"Pantry Bot host {host} through the proxy", via_proxy(f"https://{host}/"), False)
            check(f"Pantry Bot host {host} directly", tcp(host, 443), False)
        for ip in args.deny_ip:
            for port in (22, 80, 443):
                check(f"Pantry Bot address {ip}:{port}", tcp(ip, port), False)
    finally:
        subprocess.run([str(DEVVM), "destroy", lease], capture_output=True, text=True, timeout=600)
    print("ALL PASS" if not failures else f"{failures} check(s) FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
