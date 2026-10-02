#!/usr/bin/env bash
# Dedicated Ubuntu 24.04 host only. Does not start Grimoire or create credentials.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo on the dedicated deployment host.' >&2; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Expected Ubuntu 24.04.' >&2; exit 1; }
[[ $# -le 1 ]] || { echo 'Usage: sudo bash deploy/aws/bootstrap.sh [small]' >&2; exit 1; }
profile=${1:-standard}
[[ $profile == standard || $profile == small ]] || { echo 'Expected standard (2 GB) or small (1 GB) profile.' >&2; exit 1; }
if [[ $profile == small ]]; then
  # A fixed private 2-GiB file is a pressure buffer, not a replacement for RAM.
  # Never resize, format or remove an existing unknown swap file/device.
  swap_file=/swapfile-grimoire
  swap_bytes=2147483648
  active_swap=$(swapon --show=NAME --noheadings --raw)
  if [[ -n $active_swap ]] && ! grep -Fxq "$swap_file" <<< "$active_swap"; then
    total_swap=$(awk '/^SwapTotal:/ {print $2 * 1024}' /proc/meminfo)
    awk -v total="$total_swap" -v wanted="$swap_bytes" 'BEGIN {exit !(total >= wanted)}' || {
      echo 'Existing swap is smaller than 2 GiB. Preserving it; have the operator review capacity before continuing.' >&2
      exit 1
    }
    echo 'Existing swap of at least 2 GiB preserved; no Grimoire swap file created.'
  else
    if [[ -e $swap_file || -L $swap_file ]]; then
      [[ -f $swap_file && ! -L $swap_file && $(stat -c %u "$swap_file") == 0 && $(stat -c %a "$swap_file") == 600 && $(stat -c %s "$swap_file") == "$swap_bytes" && $(blkid -p -s TYPE -o value "$swap_file") == swap ]] || {
        echo 'An unknown file occupies /swapfile-grimoire. Refusing to overwrite or reformat it.' >&2
        exit 1
      }
    else
      available=$(df --output=avail -B1 / | tail -n 1 | tr -d ' ')
      (( available >= 4294967296 )) || { echo 'At least 4 GiB free disk is required before allocating 2 GiB swap.' >&2; exit 1; }
      (umask 077; set -o noclobber; : > "$swap_file")
      dd if=/dev/zero of="$swap_file" bs=1M count=2048 conv=notrunc status=none
      mkswap "$swap_file" >/dev/null
    fi
    if ! grep -Fxq "$swap_file" <<< "$active_swap"; then swapon "$swap_file"; fi
    if ! awk -v target="$swap_file" '$1==target {found=1} END {exit !found}' /etc/fstab; then
      cp -p /etc/fstab "/etc/fstab.before-grimoire-$(date -u +%Y%m%dT%H%M%SZ)"
      printf '%s none swap sw 0 0\n' "$swap_file" >> /etc/fstab
    fi
    echo 'Verified fixed 2-GiB Grimoire swap file; existing unrelated swap was preserved.'
  fi
fi
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
