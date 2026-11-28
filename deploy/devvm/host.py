"""Windows Terraform/VirtualBox lease worker and restricted OpenSSH entry point."""

import argparse
import base64
import ctypes
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import struct
import subprocess
import sys
import time
import uuid


HERE = Path(__file__).resolve().parent
GIB = 1024 ** 3
ID = re.compile(r"[0-9a-f]{32}")
PORTS = range(22400, 22416)
# Development may use the whole PC. Only a small floor is kept for Windows (default: 2 logical CPUs, 4 GiB RAM,
# 30 GiB disk). Every value can be overridden in host.json under "limits" / "ranges" / "vm"; see README.
RESERVE = dict(cpus=2, ram_mib=4096, disk_gib=30)
RANGES = dict(cpus=(1, 32), ram_mib=(1024, 65536), disk_gib=(8, 512), ttl_minutes=(1, 480))
VM_DEFAULTS = dict(cpu_cap=100, priority="low")


def default_limits(logical_cpus, total_ram_mib, reserve=RESERVE):
    """The pool may take everything except the reserve; host checks still apply at admission time."""
    return dict(max_vms=len(PORTS), total_cpus=max(1, logical_cpus - reserve["cpus"]),
                total_ram_mib=max(1024, total_ram_mib - reserve["ram_mib"]), total_disk_gib=2048,
                min_free_ram_mib=reserve["ram_mib"], min_free_disk_gib=reserve["disk_gib"])


def total_memory_mib():
    numbers = (ctypes.c_uint32 * 16)()
    numbers[0] = ctypes.sizeof(numbers)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(numbers)):
        raise ctypes.WinError()
    return struct.unpack_from("<Q", numbers, 8)[0] // (1024 * 1024)


def lease_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError("Invalid lease ID")
    return value


def validate_lease(spec, ranges=RANGES):
    cleaned = {"id": lease_id(spec.get("id"))}
    for field, (minimum, maximum) in ranges.items():
        value = spec.get(field)
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError(f"{field} must be an integer in [{minimum}, {maximum}]")
        cleaned[field] = value
    key = spec.get("public_key")
    if not isinstance(key, str) or not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/=]{68}(?: [!-~ ]{1,128})?", key):
        raise ValueError("Provide a single OpenSSH Ed25519 public key")
    algorithm, encoded, *_ = key.split(" ")
    if not re.fullmatch(rb"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20.{32}",
                        base64.b64decode(encoded, validate=True), re.DOTALL):
        raise ValueError("Invalid Ed25519 key encoding")
    cleaned["public_key"] = f"{algorithm} {encoded}"
    return cleaned


def check_budget(new, current, limits, free_ram_mib, free_disk_gib):
    if len(current) >= limits["max_vms"]:
        raise ValueError("Concurrent VM limit reached")
    for field, limit in (("cpus", "total_cpus"), ("ram_mib", "total_ram_mib"), ("disk_gib", "total_disk_gib")):
        if new[field] + sum(item[field] for item in current) > limits[limit]:
            raise ValueError(f"Aggregate {field} limit reached")
    if free_ram_mib - new["ram_mib"] < limits["min_free_ram_mib"]:
        raise ValueError("Host RAM reserve would be breached")
    if free_disk_gib - new["disk_gib"] - sum(item["disk_gib"] for item in current) < limits["min_free_disk_gib"]:
        raise ValueError("Host disk reserve would be breached")


def free_memory_mib():
    numbers = (ctypes.c_uint32 * 16)()
    numbers[0] = ctypes.sizeof(numbers)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(numbers)):
        raise ctypes.WinError()
    return struct.unpack_from("<Q", numbers, 16)[0] // (1024 * 1024)


def atomic_json(path, data):
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(data) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def create_seed(path, lease, ssh_keygen):
    import pycdlib

    key_path = path.with_name("guest_host_key")
    try:
        subprocess.run([ssh_keygen, "-q", "-t", "ed25519", "-N", "", "-f", str(key_path)],
                       capture_output=True, check=True, timeout=15)
        pub = key_path.with_suffix(".pub").read_text(encoding="ascii").strip()
        settings = {
            "ssh_pwauth": False,
            "disable_root": True,
            "ssh_deletekeys": True,
            "ssh_keys": {"ed25519_private": key_path.read_text(encoding="ascii"), "ed25519_public": pub},
            "users": [
                {"name": "dev", "shell": "/bin/bash", "lock_passwd": True,
                 "sudo": "ALL=(ALL) NOPASSWD:ALL", "ssh_authorized_keys": [lease["public_key"]]},
                {"name": "devgate", "shell": "/bin/bash", "lock_passwd": True},
            ],
            "write_files": [
                {"path": "/etc/ssh/sshd_config.d/01-devvm.conf", "permissions": "0644",
                 "content": "PasswordAuthentication no\nKbdInteractiveAuthentication no\n"
                            "PermitRootLogin no\nAllowUsers dev\nAllowAgentForwarding no\n"
                            "AllowTcpForwarding no\nX11Forwarding no\n"},
            ],
            "growpart": {"mode": "auto", "devices": ["/"], "ignore_growroot_disabled": False},
            "resize_rootfs": True,
            "runcmd": [["systemctl", "restart", "ssh"]],
        }
        files = {
            "user-data": ("#cloud-config\n" + json.dumps(settings) + "\n").encode(),
            "meta-data": json.dumps({"instance-id": lease["id"], "local-hostname": lease["name"]}).encode(),
        }
        iso = pycdlib.PyCdlib()
        iso.new(interchange_level=3, joliet=3, rock_ridge="1.09", vol_ident="CIDATA")
        try:
            for label, contents in files.items():
                iso.add_fp(io.BytesIO(contents), len(contents), f"/{label.replace('-', '_').upper()};1",
                           rr_name=label, joliet_path=f"/{label}")
            iso.write(str(path))
        finally:
            iso.close()
        return " ".join(pub.split()[:2])
    finally:
        key_path.unlink(missing_ok=True)
        key_path.with_suffix(".pub").unlink(missing_ok=True)


class Host:
    def __init__(self, config_path):
        self.config_path = config_path.resolve()
        self.config = load_json(self.config_path)
        self.root = Path(self.config["root"])
        self.leases = self.root / "leases"
        self.spool = self.root / "spool"
        self.packs = self.root / "machines"
        self.environment = os.environ | {"VBOX_USER_HOME": str(self.root / "registry"),
                                         "TF_IN_AUTOMATION": "1", "CHECKPOINT_DISABLE": "1",
                                         "DEVVM_HOST": str(Path(__file__).resolve()),
                                         "DEVVM_PYTHON": sys.executable, "DEVVM_CONFIG": str(self.config_path)}

    def ranges(self):
        return RANGES | {key: tuple(value) for key, value in self.config.get("ranges", {}).items()}

    def limits(self):
        reserve = RESERVE | self.config.get("reserve", {})
        return default_limits(os.cpu_count() or 4, total_memory_mib(), reserve) | self.config.get("limits", {})

    def initialize(self):
        for path in (self.leases, self.spool, self.packs, self.root / "registry"):
            path.mkdir(parents=True, exist_ok=True)

    def directory(self, value):
        return self.leases / lease_id(value)

    def read_lease(self, value):
        return load_json(self.directory(value) / "lease.json")

    def records(self):
        return [load_json(path) for path in self.leases.glob("*/lease.json") if ID.fullmatch(path.parent.name)]

    def write_lease(self, lease):
        folder = self.directory(lease["id"])
        folder.mkdir(exist_ok=True)
        atomic_json(folder / "lease.json", lease)

    def call(self, args, timeout, cwd=None):
        result = subprocess.run(args, cwd=cwd, env=self.environment, capture_output=True,
                                encoding="utf-8", errors="replace", timeout=timeout,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise RuntimeError(f"{Path(args[0]).name} {args[1]} exited {result.returncode}: "
                               f"{(result.stderr + result.stdout).strip()[-3500:]}")
        return result.stdout

    def vbox(self, *args, timeout=40):
        return self.call([self.config["vbox"], *args], timeout)

    def terraform(self, value, action):
        folder = self.directory(value)
        shutil.copyfile(HERE / "main.tf", folder / "main.tf")
        command = self.config["terraform"]
        self.call([command, "init", "-input=false", "-no-color"], 45, folder)
        self.call([command, action, "-input=false", "-no-color", "-auto-approve",
                   f"-var=lease_id={value}"], 240, folder)

    def vm_state(self, lease):
        guid = str(uuid.UUID(hex=lease["id"]))
        if "{" + guid + "}" not in self.vbox("list", "vms").lower():
            return "absent"
        info = self.vbox("showvminfo", guid, "--machinereadable")
        match = re.search(r'^VMState="([^"]+)"', info, re.MULTILINE)
        if not match:
            raise RuntimeError("Missing VMState in VBoxManage output")
        return match[1]

    def machine_folder(self, lease):
        return self.packs / ("adev-" + lease_id(lease["id"]))

    def start_headless(self, guid, lease, folder):
        try:
            self.vbox("startvm", guid, "--type", "headless", timeout=55)
        except RuntimeError as initial:
            if "VERR_NEM_INIT_FAILED" not in str(initial):
                raise
            frontend = Path(self.config["vbox"]).with_name("VBoxHeadless.exe")
            transcript = folder / "headless-start.log"
            # Launch in the worker's own Windows token if the COM-spawned frontend fails.
            with transcript.open("wb") as output:
                vm = subprocess.Popen([str(frontend), "--startvm", guid, "--vrde", "off"],
                                      env=self.environment, stdin=subprocess.DEVNULL,
                                      stdout=output, stderr=subprocess.STDOUT,
                                      creationflags=subprocess.DETACHED_PROCESS | subprocess.BELOW_NORMAL_PRIORITY_CLASS)
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                if self.vm_state(lease) == "running":
                    return
                if vm.poll() is not None:
                    break
                time.sleep(0.75)
            if vm.poll() is None:
                vm.terminate()
                vm.wait(timeout=10)
            diagnostics = []
            for path in (transcript, folder / "Logs" / "VBox.log", folder / "Logs" / "VBoxHardening.log"):
                if path.is_file():
                    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
                    diagnostics.extend(line for line in lines if re.search("WinHv|vid.dll|VERR_|LoadLibrary", line))
            raise RuntimeError(f"{initial}; direct frontend: {' | '.join(diagnostics[-12:])[-2000:]}") from initial

    def materialize(self, value):
        lease = self.read_lease(value)
        if lease["phase"] != "creating":
            raise ValueError("Lease is not being created")
        guid = str(uuid.UUID(hex=value))
        folder = self.machine_folder(lease)
        disk, seed = folder / "dev.vdi", folder / "seed.iso"
        self.vbox("createvm", "--name", lease["name"], "--uuid", guid, "--ostype", "Debian_64",
                  "--basefolder", str(self.packs), "--register")
        if not folder.is_dir():
            raise RuntimeError("VirtualBox created an unexpected machine directory")
        lease["host_key"] = create_seed(seed, lease, self.config["ssh_keygen"])
        self.write_lease(lease)
        self.vbox("clonemedium", "disk", self.image(), str(disk), "--format", "VDI", timeout=240)
        self.vbox("modifymedium", "disk", str(disk), "--resize", str(lease["disk_gib"] * 1024))
        vm_options = VM_DEFAULTS | self.config.get("vm", {})
        self.vbox("modifyvm", guid, "--cpus", str(lease["cpus"]), "--memory", str(lease["ram_mib"]),
                  "--cpu-execution-cap", str(vm_options["cpu_cap"]), "--vm-process-priority", vm_options["priority"], "--accelerate-3d", "off",
                  "--audio-enabled", "off", "--usb-ohci", "off", "--usb-ehci", "off", "--usb-xhci", "off",
                  "--clipboard-mode", "disabled", "--drag-and-drop", "disabled", "--nested-hw-virt", "off",
                  "--ioapic", "on", "--rtc-use-utc", "on", "--firmware", "efi64",
                  "--boot1", "disk", "--boot2", "none", "--boot3", "none", "--boot4", "none",
                  "--nic1", "nat", "--nat-localhostreachable1", "off",
                  # No DNS through the host: guests resolve nothing themselves (all egress goes through the proxy).
                  "--natdnshostresolver1", "off", "--natdnsproxy1", "off",
                  "--nat-pf1", f'ssh,tcp,127.0.0.1,{lease["port"]},,22')
        self.vbox("storagectl", guid, "--name", "SATA", "--add", "sata", "--controller", "IntelAhci")
        for port, kind, medium in (("0", "hdd", disk), ("1", "dvddrive", seed)):
            self.vbox("storageattach", guid, "--storagectl", "SATA", "--port", port, "--device", "0",
                      "--type", kind, "--medium", str(medium))
        self.start_headless(guid, lease, folder)
        if self.vm_state(lease) != "running":
            raise RuntimeError("VirtualBox VM did not reach running state")

    def dematerialize(self, value):
        lease = self.read_lease(value)
        guid = str(uuid.UUID(hex=value))
        folder = self.machine_folder(lease)
        state = self.vm_state(lease)
        if state in {"running", "paused", "stuck"}:
            self.vbox("controlvm", guid, "poweroff")
        if state != "absent":
            self.vbox("unregistervm", guid, "--delete")
        for kind, medium in (("disk", folder / "dev.vdi"), ("dvd", folder / "seed.iso")):
            registered = re.findall(r"^Location:\s+(.+)$", self.vbox("list", "hdds" if kind == "disk" else "dvds"),
                                    re.MULTILINE)
            if str(medium).casefold() in {name.strip().casefold() for name in registered}:
                options = ["--delete"] if kind == "disk" else []
                self.vbox("closemedium", kind, str(medium), *options)
        if self.vm_state(lease) != "absent":
            raise RuntimeError("VirtualBox still reports the lease after cleanup")
        if folder.exists() and folder.resolve().parent == self.packs.resolve():
            shutil.rmtree(folder)

    def destroy(self, value):
        folder = self.directory(value)
        if not (folder / "lease.json").is_file():
            return {"id": value, "destroyed": True}
        lease = self.read_lease(value)
        lease["phase"] = "deleting"
        self.write_lease(lease)
        if (folder / "terraform.tfstate").is_file():
            self.terraform(value, "destroy")
        # Terraform skips the destroy provisioner for tainted or absent state.
        self.dematerialize(value)
        shutil.rmtree(folder)
        return {"id": value, "destroyed": True}

    def image(self):
        """The base disk: the latest captured image (images/current.json) if any, else the installed one."""
        pointer = self.root / "images" / "current.json"
        if pointer.is_file():
            candidate = Path(load_json(pointer)["image"])
            if candidate.is_file() and candidate.resolve().parent == (self.root / "images").resolve():
                return str(candidate)
        return self.config["image"]

    def capture(self, value):
        """Turn a prepared builder lease's disk into the new base image (no secrets: builders never get credentials)."""
        lease = self.read_lease(value)
        if lease.get("purpose") != "image" or lease["phase"] != "running":
            raise ValueError("Only a running image-builder lease can be captured")
        guid = str(uuid.UUID(hex=value))
        if self.vm_state(lease) in {"running", "paused", "stuck"}:
            self.vbox("controlvm", guid, "acpipowerbutton")
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline and self.vm_state(lease) not in {"poweroff", "aborted"}:
                time.sleep(2)
            if self.vm_state(lease) not in {"poweroff", "aborted"}:
                self.vbox("controlvm", guid, "poweroff")
        images = self.root / "images"
        images.mkdir(exist_ok=True)
        name = images / f"debian13-dev-{time.strftime('%Y%m%d-%H%M%S')}.vdi"
        self.vbox("clonemedium", "disk", str(self.machine_folder(lease) / "dev.vdi"), str(name), "--format", "VDI", timeout=600)
        self.vbox("closemedium", "disk", str(name))
        previous = self.image()
        atomic_json(images / "current.json", {"image": str(name), "previous": previous, "captured_at": int(time.time())})
        # Keep the newest three captured images for rollback.
        for old in sorted(images.glob("debian13-dev-*.vdi"))[:-3]:
            if str(old) != previous:
                old.unlink(missing_ok=True)
        return {"image": str(name), "previous": previous}

    def renew(self, value, ttl_minutes):
        """Extend a running lease's lifetime to now + ttl_minutes (at most 480 minutes from now)."""
        low, high = self.ranges()["ttl_minutes"]
        if type(ttl_minutes) is not int or not low <= ttl_minutes <= high:
            raise ValueError(f"ttl_minutes must be an integer in [{low}, {high}]")
        folder = self.directory(value)
        if not (folder / "lease.json").is_file():
            raise ValueError("Lease is absent")
        lease = self.read_lease(value)
        if lease["phase"] != "running" or lease["expires_at"] <= time.time():
            raise ValueError("Lease is not running or has expired")
        lease["expires_at"] = int(time.time()) + ttl_minutes * 60
        self.write_lease(lease)
        return self.describe(lease)

    def provision(self, request):
        lease = validate_lease(request, self.ranges())
        if request.get("purpose") == "image":
            lease["purpose"] = "image"
        value = lease["id"]
        if (self.directory(value) / "lease.json").is_file():
            prior = self.read_lease(value)
            if prior["phase"] == "running" and all(prior.get(key) == val for key, val in lease.items()):
                return self.describe(prior)
            raise ValueError("Lease ID is already reserved with a different or incomplete request")
        if (self.root / "paused").exists():
            raise ValueError("Gaming pause is enabled")
        active = self.records()
        check_budget(lease, active, self.limits(), free_memory_mib(),
                     shutil.disk_usage(self.root).free // GIB)
        used_ports = {item["port"] for item in active}
        for port in PORTS:
            if port not in used_ports and can_bind(port):
                break
        else:
            raise ValueError("No SSH port is available")
        now = int(time.time())
        lease.update(port=port, name=f"adev-{value}", phase="creating", created_at=now,
                     expires_at=now + lease["ttl_minutes"] * 60)
        self.write_lease(lease)
        try:
            self.terraform(value, "apply")
            lease = self.read_lease(value)
            lease["phase"] = "running"
            self.write_lease(lease)
        except Exception:
            try:
                self.destroy(value)
            except Exception as cleanup:
                print(f"Cleanup pending for {value}: {cleanup}", file=sys.stderr, flush=True)
            raise
        return self.describe(lease)

    def describe(self, lease):
        keys = ("id", "name", "phase", "port", "host_key", "cpus", "ram_mib", "disk_gib", "expires_at")
        return {key: lease.get(key) for key in keys} | {"vm_state": self.vm_state(lease)}

    def handle(self, request):
        operation = request.get("op")
        if operation == "provision":
            return self.provision(request)
        if operation == "destroy":
            return self.destroy(lease_id(request.get("id")))
        if operation == "capture":
            return self.capture(lease_id(request.get("id")))
        if operation == "renew":
            return self.renew(lease_id(request.get("id")), request.get("ttl_minutes"))
        if operation == "status":
            value = lease_id(request.get("id"))
            if not (self.directory(value) / "lease.json").exists():
                return {"id": value, "phase": "absent", "vm_state": "absent"}
            return self.describe(self.read_lease(value))
        if operation == "list":
            return {"paused": (self.root / "paused").exists(), "limits": self.limits(),
                    "leases": [self.describe(lease) for lease in self.records()]}
        if operation == "ping":
            self.vbox("list", "vms")
            return {"ready": Path(self.config["image"]).is_file(), "vbox": self.vbox("--version").strip()}
        if operation in {"pause", "resume"}:
            flag = self.root / "paused"
            if operation == "pause":
                flag.touch()
            else:
                flag.unlink(missing_ok=True)
            return {"paused": flag.exists(), "leases": len(self.records())}
        raise ValueError("Unsupported operation")

    def reap(self):
        now = time.time()
        for lease in self.records():
            if lease["phase"] != "running" or lease["expires_at"] <= now:
                try:
                    self.destroy(lease["id"])
                except Exception as exc:
                    print(f"Reaper will retry {lease['id']}: {exc}", file=sys.stderr, flush=True)
        for path in self.spool.glob("*.result"):
            if path.stat().st_mtime < now - 900:
                path.unlink(missing_ok=True)

    def serve(self):
        import msvcrt

        self.initialize()
        with (self.root / "worker.lock").open("a+b") as lock:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            next_reap = 0
            while True:
                requests = sorted(self.spool.glob("*.request"), key=lambda item: item.stat().st_mtime)
                active = bool(requests) or bool(self.records())
                if not ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | int(active)):
                    raise ctypes.WinError()
                if time.monotonic() >= next_reap:
                    self.reap()
                    next_reap = time.monotonic() + 10
                for path in requests:
                    response = path.with_suffix(".result")
                    if not response.exists():
                        try:
                            if time.time() - path.stat().st_mtime > 500:
                                raise ValueError("The queued request expired")
                            data = {"ok": True, "value": self.handle(load_json(path))}
                        except Exception as exc:
                            data = {"ok": False, "error": str(exc)}
                        atomic_json(response, data)
                    path.unlink(missing_ok=True)
                time.sleep(0.5)

    def request(self, payload):
        request = self.spool / f"{uuid.uuid4().hex}.request"
        result = request.with_suffix(".result")
        atomic_json(request, payload)
        deadline = time.monotonic() + 480
        while time.monotonic() < deadline:
            if result.is_file():
                response = load_json(result)
                result.unlink(missing_ok=True)
                return response
            time.sleep(0.25)
        raise TimeoutError("Windows worker did not respond; inspect the lease before retrying")


def can_bind(port):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def entry():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=HERE / "host.json")
    parser.add_argument("mode", choices=["serve", "ssh", "request", "materialize", "dematerialize"])
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    host = Host(args.config)
    if args.mode in {"materialize", "dematerialize"}:
        getattr(host, args.mode)(lease_id(args.value))
    elif args.mode == "serve":
        host.serve()
    else:
        if args.mode == "ssh" and os.environ.get("SSH_ORIGINAL_COMMAND") != "devvm":
            raise ValueError("Only the devvm protocol is accepted")
        raw = sys.stdin.buffer.readline(8193)
        if len(raw) > 8192 or not raw:
            raise ValueError("Expected one JSON request of at most 8192 bytes")
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("Expected a JSON object")
        print(json.dumps(host.request(payload)), flush=True)


if __name__ == "__main__":
    wheel = HERE / "pycdlib-1.16.0-py2.py3-none-any.whl"
    sys.path.insert(0, str(wheel))
    try:
        entry()
    except Exception as error:
        print(f"devvm: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
