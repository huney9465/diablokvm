#!/usr/bin/env bash
# Installs Diablo on Debian or Ubuntu. Run as root from the extracted project folder:
#   sudo bash install.sh
set -Eeuo pipefail

APP_DIR=/opt/kvmpanel
DATA_DIR=/var/lib/kvmpanel

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this script as root (sudo bash install.sh)."
command -v apt-get >/dev/null || die "This installer supports Debian and Ubuntu (apt). On other systems follow the manual steps in README.md."
[[ -f package.json && -d src ]] || die "Run the script from the project folder that contains package.json."

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils genisoimage iproute2 openssl ca-certificates curl build-essential python3

need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [[ $major -ge 22 ]] && need_node=0
fi
if [[ $need_node -eq 1 ]]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

say "Copying the panel to $APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR"
cp -r package.json package-lock.json src views public install-node.sh kvmpanel-node.service "$APP_DIR"/   # the node installer files are served to new nodes by the panel
fresh_env=0
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp .env.example "$APP_DIR/.env"
  fresh_env=1
fi
chmod 600 "$APP_DIR/.env"

# Ask for the admin account only on a brand new install (an existing .env means the panel was
# installed before, so its admin account already exists and prompting again would be confusing).
# Skipped automatically when the script isn't run from an interactive terminal (e.g. CI, curl | bash).
admin_user="admin"; admin_email=""; admin_pass=""; enable_registration="n"
if [[ $fresh_env -eq 1 && -t 0 ]]; then
  say "Set up the admin account"
  read -rp "Admin username [admin]: " admin_user_in; admin_user=${admin_user_in:-admin}
  read -rp "Admin email (optional): " admin_email
  read -rsp "Admin password (leave blank for a random one, shown after setup): " admin_pass; echo
  read -rp "Enable self-registration for other users? [y/N]: " enable_registration
fi

set_env() { # set_env KEY VALUE — updates KEY=... in .env, adding it if missing
  local key=$1 val=$2 esc
  esc=$(printf '%s' "$val" | sed -e 's/[&|\]/\\&/g') # escape sed-special chars in the value
  if grep -q "^${key}=" "$APP_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${esc}|" "$APP_DIR/.env"
  else
    printf '%s=%s\n' "$key" "$val" >> "$APP_DIR/.env"
  fi
}
[[ $fresh_env -eq 1 ]] && { set_env ADMIN_USERNAME "$admin_user"; set_env ADMIN_EMAIL "$admin_email"; set_env ADMIN_PASSWORD "$admin_pass"; }

say "Installing Node dependencies"
# better-sqlite3 ships prebuilt binaries, so skip install scripts (npm would otherwise try to compile it).
(cd "$APP_DIR" && npm ci --omit=dev --ignore-scripts)
if ! (cd "$APP_DIR" && node -e "new (require('better-sqlite3'))(':memory:')" 2>/dev/null); then
  say "No prebuilt SQLite binary for this platform, compiling from source (takes a few minutes)"
  (cd "$APP_DIR" && npm rebuild better-sqlite3 --foreground-scripts)
fi

if [[ $fresh_env -eq 1 ]]; then
  say "Creating the admin account"
  reg_flag=0
  [[ $enable_registration =~ ^[Yy] ]] && reg_flag=1
  # Loading src/db.js seeds the admin account (and, on a fresh DB, creates it), reading
  # ADMIN_USERNAME/ADMIN_PASSWORD/ADMIN_EMAIL from .env (dotenv loads it automatically), and
  # prints the credentials to the terminal.
  (cd "$APP_DIR" && ENABLE_REG=$reg_flag node -e "
    const { saveSettings } = require('./src/db');
    if (process.env.ENABLE_REG === '1') saveSettings({ allow_registration: '1' });
  ")
fi

say "Creating the systemd service"
cp kvmpanel.service /etc/systemd/system/kvmpanel.service
systemctl daemon-reload
systemctl enable --now kvmpanel

sleep 2
say "Done"
if [[ -e /dev/kvm ]]; then echo "KVM acceleration: available"; else echo "WARNING: /dev/kvm is missing. VMs will run without hardware acceleration."; fi
echo "Open http://<this-server>:8080"
echo "To run VMs on more servers, add them under Administration > Nodes."
if [[ $fresh_env -eq 1 ]]; then
  echo "Admin sign-in: see the username/email/password printed above under 'Creating the admin account'."
else
  echo "This reused an existing .env, so the admin account was left untouched."
  echo "Locked out? Run:  cd $APP_DIR && npm run reset-admin"
fi
