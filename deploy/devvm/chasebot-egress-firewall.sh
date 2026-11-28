#!/bin/sh
# Chasebot side of the agent-VM egress path: only the gaming PC may use the egress proxy port.
# Run as root on Chasebot:  sh chasebot-egress-firewall.sh <gaming-pc-ip> [proxy-port]
# Creates (or replaces) the nftables table "orch_egress". Persist it with your distribution's nftables service.
set -eu
pc=${1:?usage: chasebot-egress-firewall.sh <gaming-pc-ip> [proxy-port]}
port=${2:-3128}
echo "$pc" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || { echo "not an IPv4 address: $pc" >&2; exit 2; }
nft delete table inet orch_egress 2>/dev/null || true
nft -f - <<NFT
table inet orch_egress {
  chain input {
    type filter hook input priority -10; policy accept;
    tcp dport $port ip saddr != $pc drop
    tcp dport $port meta nfproto ipv6 drop
  }
}
NFT
nft list table inet orch_egress
