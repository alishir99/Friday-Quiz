#!/usr/bin/env bash
# Friday Quiz - one-shot VM setup for Ubuntu.
#
#   curl -fsSL https://raw.githubusercontent.com/alishir99/Friday-Quiz/main/deploy/setup.sh | sudo bash
#
# Installs Node, git and Caddy, creates the service user, fetches the app and
# starts it on 127.0.0.1:8080. Safe to run again - it updates instead of
# duplicating. Secrets are never in here; it writes an empty .env for you to
# fill in afterwards.
set -euo pipefail

REPO="https://github.com/alishir99/Friday-Quiz.git"
APP=/opt/friday-quiz

[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo."; exit 1; }

echo "==> Installing Node, git and Caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg \
  debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
apt-get install -y -qq nodejs git

# Caddy is not in Ubuntu's repositories, so add its own.
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "==> Service user and code"
# No --create-home: it would fill the directory and git clone would refuse it.
id -u quiz >/dev/null 2>&1 || \
  useradd --system --home-dir "$APP" --shell /usr/sbin/nologin quiz

if [ -d "$APP/.git" ]; then
  git -C "$APP" pull --ff-only
else
  git clone -q "$REPO" "$APP"
fi
mkdir -p "$APP/data"
chown -R quiz:quiz "$APP"

echo "==> Secrets"
if [ -f "$APP/.env" ]; then
  echo "    .env already exists, leaving it alone"
else
  printf 'DEEPSEEK_API_KEY=\nQUIZ_INVITE_CODE=\n' > "$APP/.env"
  chown quiz:quiz "$APP/.env"
  chmod 600 "$APP/.env"
  echo "    wrote an empty $APP/.env - fill it in next"
fi

echo "==> Starting the service"
cp "$APP/deploy/friday-quiz.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now friday-quiz
sleep 2

echo
if curl -fsS --max-time 5 localhost:8080/api/state >/dev/null 2>&1; then
  echo "  The quiz is running on 127.0.0.1:8080"
else
  echo "  Not responding yet - check: journalctl -u friday-quiz -n 30"
fi

cat <<EOF

Next:
  1. sudo nano $APP/.env       set DEEPSEEK_API_KEY and QUIZ_INVITE_CODE
  2. sudo systemctl restart friday-quiz
  3. point a domain at this machine, then set up Caddy for HTTPS

EOF
