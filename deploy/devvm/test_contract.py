import base64
import struct
import unittest

from host import check_budget, validate_lease


def ssh_key():
    fields = [b"ssh-ed25519", b"k" * 32]
    data = b"".join(struct.pack(">I", len(field)) + field for field in fields)
    return "ssh-ed25519 " + base64.b64encode(data).decode()


def spec(**overrides):
    defaults = dict(id="a" * 32, cpus=2, ram_mib=2048, disk_gib=8,
                    ttl_minutes=30, public_key=ssh_key())
    return defaults | overrides


class ContractTests(unittest.TestCase):
    def test_valid_lease_and_key(self):
        self.assertEqual(validate_lease(spec())["cpus"], 2)

    def test_rejects_invalid_lease_inputs(self):
        for changes in (dict(id="../escape"), dict(cpus=True), dict(disk_gib=100),
                        dict(public_key=ssh_key() + "\nPermitRootLogin yes"), dict(ttl_minutes=0)):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_lease(spec(**changes))

    def test_budget_reserves_host_memory_and_disk(self):
        limits = dict(max_vms=3, total_cpus=6, total_ram_mib=8192, total_disk_gib=72,
                      min_free_ram_mib=8192, min_free_disk_gib=30)
        check_budget(spec(), [spec()], limits, 12_000, 100)
        for ram, disk in ((9_000, 100), (12_000, 45)):
            with self.assertRaises(ValueError):
                check_budget(spec(), [spec()], limits, ram, disk)
        with self.assertRaises(ValueError):
            check_budget(spec(cpus=4), [spec(cpus=4)], limits, 12_000, 100)


if __name__ == "__main__":
    unittest.main()
