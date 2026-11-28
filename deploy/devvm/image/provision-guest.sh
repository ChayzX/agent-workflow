#!/bin/bash
# Bakes the development toolchains and both agent CLIs into the Debian 13 base image. Runs as root inside an
# image-builder VM (`devvm image-build`), whose only egress is the Chasebot proxy. It installs NO credentials:
# provider logins are copied into each lease at provision time by the orchestrator, never into an image.
# Usage (inside the guest): sudo PROXY=http://<chasebot>:3128 bash provision-guest.sh
set -euo pipefail
: "${PROXY:?set PROXY to the egress proxy URL}"
export DEBIAN_FRONTEND=noninteractive http_proxy=$PROXY https_proxy=$PROXY HTTP_PROXY=$PROXY HTTPS_PROXY=$PROXY

# Every later VM uses the proxy for apt, npm, pip and anything that honours the standard variables.
cat > /etc/apt/apt.conf.d/80orch-proxy <<APT
Acquire::http::Proxy "$PROXY";
Acquire::https::Proxy "$PROXY";
APT
cat > /etc/profile.d/orch-proxy.sh <<ENV
export http_proxy=$PROXY https_proxy=$PROXY HTTP_PROXY=$PROXY HTTPS_PROXY=$PROXY NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1
ENV
printf 'http_proxy=%s\nhttps_proxy=%s\nHTTP_PROXY=%s\nHTTPS_PROXY=%s\nNO_PROXY=localhost,127.0.0.1\n' "$PROXY" "$PROXY" "$PROXY" "$PROXY" >> /etc/environment

apt-get update -q
apt-get install -y -q --no-install-recommends \
  git curl ca-certificates build-essential pkg-config python3 python3-pip python3-venv pipx \
  nodejs npm jq ripgrep unzip xz-utils zip openssh-client procps
npm config --global set proxy "$PROXY"
npm config --global set https-proxy "$PROXY"
mkdir -p /etc/pip && printf '[global]\nproxy = %s\n' "$PROXY" > /etc/pip.conf
# Node >= 22 for the CLIs if the distribution's is older.
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  npm install -g n && n 22
fi
npm install -g @anthropic-ai/claude-code @openai/codex
claude --version && codex --version

# Generic image: no machine identity, logs or keys carried into clones.
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm /home/*/.npm /tmp/* /var/tmp/*
cloud-init clean --logs --seed
rm -f /etc/ssh/ssh_host_* /etc/machine-id && touch /etc/machine-id
echo "image prepared"
