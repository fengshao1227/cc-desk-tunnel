#!/usr/bin/env bash
# Native install of this fork's server: systemd service running as an ordinary user, sharing that user's
# Claude Code login and ~/.claude with plain `claude`. Run as root.
#
#   CCDT_HOST=203.0.113.10 bash deploy/native/install.sh [ref]
#
# ref: branch, tag or commit of the fork (default main). See deploy/native/README.md.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
[ "$(id -u)" = 0 ] || die "run as root"
: "${CCDT_HOST:?set CCDT_HOST to the address clients connect to (IPv4 or DNS name)}"
: "${CCDT_PORT:=8787}"
ref=${1:-main}

install_node
install_claude_code
ensure_openssh

sha=$(git ls-remote "$CCDT_REPO" "$ref" | head -1 | cut -c1-12); [ -n "$sha" ] || sha=$(printf %s "$ref" | cut -c1-12)
release=$APP/releases/$sha
if [ ! -f "$release/apps/server/src/main.ts" ]; then
  log "source $ref ($sha)"
  # Every level the service user writes into must be its own: install -d only owns the last component.
  install -d -o "$CCDT_UID" -g "$CCDT_GID" "$CCDT_HOME/apps" "$APP" "$APP/releases"
  fetch_source "$ref" "$release"
fi
install_dependencies "$release" "$(readlink -f "$APP/current" 2>/dev/null || true)"
install_web "$release"

# Configuration, created once; an existing one (token, certificate, settings) is kept.
install -d -m 700 -o "$CCDT_UID" -g "$CCDT_GID" "$CONF" "$CONF/tls" "$DATA" "$DATA/state"
if [ ! -f "$CONF/tls/control.crt" ]; then
  log "self-signed certificate (clients pin its SHA-256 fingerprint)"
  cfg=$(mktemp)
  # A config file instead of -addext, which OpenSSL 1.0.2 (CentOS 7) does not know.
  printf '[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=DNS:cc-desk-tunnel.local\nbasicConstraints=critical,CA:FALSE\n' > "$cfg"
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 -subj /CN=cc-desk-tunnel.local \
    -config "$cfg" -extensions v3 -keyout "$CONF/tls/control.key" -out "$CONF/tls/control.crt" 2>/dev/null
  rm -f "$cfg"; chown "$CCDT_UID:$CCDT_GID" "$CONF/tls/"*; chmod 600 "$CONF/tls/"*
fi
if [ ! -f "$CONF/service.env" ]; then
  log "service.env"
  umask 077
  sed -e "s|@TOKEN@|$(openssl rand -hex 32)|" -e "s|@PORT@|$CCDT_PORT|" -e "s|@HOME@|$CCDT_HOME|g" \
      -e "s|@CLAUDE@|$OPT/claude-code/bin/claude|" "$here/service.env.example" > "$CONF/service.env"
  chown "$CCDT_UID:$CCDT_GID" "$CONF/service.env"
fi
[ -f "$CONF/device-prompt.md" ] || install -m 600 -o "$CCDT_UID" -g "$CCDT_GID" "$here/device-prompt.example.md" "$CONF/device-prompt.md"
[ -f "$CONF/projects.conf" ] || install -m 600 -o "$CCDT_UID" -g "$CCDT_GID" /dev/null "$CONF/projects.conf"

smoke_test "$release"
as_user ln -sfn "$release" "$APP/current"

log "systemd unit"
path="$OPT/node24/bin:$OPT/claude-code/bin:$CCDT_HOME/.local/bin:$CCDT_HOME/bin:/usr/local/bin:/usr/bin:/bin"
[ -z "$SSH_BIN_DIR" ] || path="$SSH_BIN_DIR:$path"
sed -e "s|@USER@|$CCDT_USER|g" -e "s|@HOME@|$CCDT_HOME|g" -e "s|@PATH@|$path|" \
    "$here/cc-desk-tunnel.service.in" > /etc/systemd/system/cc-desk-tunnel.service
systemctl daemon-reload
systemctl enable cc-desk-tunnel >/dev/null 2>&1
restart_when_idle --now

fp=$(openssl x509 -in "$CONF/tls/control.crt" -noout -fingerprint -sha256 | cut -d= -f2)
cat <<EOF

Client settings
  Address      wss://$CCDT_HOST:$CCDT_PORT/ws
  Fingerprint  $fp
  Credential   PROXY_TOKEN in $CONF/service.env (equals control of this server and of connected computers)
Open TCP $CCDT_PORT in the firewall / security group. Then log in to Claude once as $CCDT_USER:
  runuser -u $CCDT_USER -- bash -lc '$OPT/claude-code/bin/claude'   (then /login)
EOF
