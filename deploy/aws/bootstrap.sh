#!/usr/bin/env bash
# Dedicated Ubuntu 24.04 host only. Does not start Grimoire or create credentials.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo on the dedicated deployment host.' >&2; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Expected Ubuntu 24.04.' >&2; exit 1; }
apt-get update
apt-get install -y ca-certificates curl git python3 openssl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
arch=$(dpkg --print-architecture)
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n' "$arch" > /etc/apt/sources.list.d/grimoire-docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
echo 'Docker is ready. Continue with the private deployment configuration; nothing has been exposed.'
