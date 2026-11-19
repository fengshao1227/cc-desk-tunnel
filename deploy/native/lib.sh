# Shared steps of install.sh and upgrade.sh: a native (no Docker at run time) server on Linux,
# portable to git 1.8 (no -C) and OpenSSL 1.0.2,
# including hosts as old as CentOS 7 (glibc 2.17, gcc 4.8, OpenSSH 7.4, OpenSSL 1.0.2).
# Sourced, not run. Every step is idempotent and fails loudly.

: "${CCDT_USER:=claude}"
: "${CCDT_REPO:=https://github.com/fengshao1227/cc-desk-tunnel.git}"
: "${UPSTREAM_REPO:=sun168567/cc-desk-tunnel}"
: "${NODE_VERSION:=v24.22.2}"          # the version upstream's image pins (scripts/install-linux.sh)
: "${CLAUDE_CODE_VERSION:=2.1.328}"    # official @anthropic-ai/claude-code; upstream pins 2.1.321
: "${OPENSSH_VERSION:=9.9p2}"          # only built when the host's ssh is older than 7.6
: "${BUILD_IMAGE:=quay.io/pypa/manylinux2014_x86_64}"   # gcc 10 on glibc 2.17, for native builds

CCDT_HOME=$(getent passwd "$CCDT_USER" | cut -d: -f6)
[ -n "$CCDT_HOME" ] || { echo "no user $CCDT_USER" >&2; exit 1; }
CCDT_UID=$(id -u "$CCDT_USER"); CCDT_GID=$(id -g "$CCDT_USER")
OPT=$CCDT_HOME/opt
APP=$CCDT_HOME/apps/cc-desk-tunnel
CONF=$CCDT_HOME/.config/cc-desk-tunnel
DATA=$CCDT_HOME/.local/share/cc-desk-tunnel

# Run from a directory every user can read: as_user keeps the caller's cwd, and node walks up from it looking for
# package.json, so a root shell left in /root makes `node -p` fail for the service user with EACCES.
cd /

log() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
as_user() { runuser -u "$CCDT_USER" -- env HOME="$CCDT_HOME" PATH="$OPT/node24/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
glibc_version() { ldd --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+$'; }
need_docker() { command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "$1 needs Docker (only for building; nothing runs in it)"; }

# Node 24: the official build needs glibc 2.28; older hosts take the unofficial glibc-217 build.
install_node() {
  local name base dir
  if version_ge "$(glibc_version)" 2.28; then
    name=node-$NODE_VERSION-linux-x64; base=https://nodejs.org/dist/$NODE_VERSION
  else
    name=node-$NODE_VERSION-linux-x64-glibc-217; base=https://unofficial-builds.nodejs.org/download/release/$NODE_VERSION
  fi
  dir=$OPT/$name
  if [ ! -x "$dir/bin/node" ]; then
    log "Node $NODE_VERSION ($name)"
    local tmp; tmp=$(mktemp -d); chmod 755 "$tmp"   # the service user unpacks from it
    curl -fsSL --max-time 300 -o "$tmp/$name.tar.xz" "$base/$name.tar.xz"
    curl -fsSL --max-time 60 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
    (cd "$tmp" && grep " $name.tar.xz\$" SHASUMS256.txt | sha256sum -c -) || die "Node checksum mismatch"
    install -d -o "$CCDT_UID" -g "$CCDT_GID" "$OPT"
    as_user tar -xJf "$tmp/$name.tar.xz" -C "$OPT"; rm -rf "$tmp"
  fi
  as_user ln -sfn "$name" "$OPT/node24"
}

# The official CLI, pinned. The service runs it through CLAUDE_PATH, and so can the user's own shell:
# one program, one login, one ~/.claude for the GUI, ccdt and plain `claude`.
install_claude_code() {
  local bin=$OPT/claude-code/bin/claude
  if [ -x "$bin" ] && [ "$(as_user "$bin" --version 2>/dev/null | cut -d' ' -f1)" = "$CLAUDE_CODE_VERSION" ]; then return; fi
  log "Claude Code $CLAUDE_CODE_VERSION"
  as_user npm install --global --no-audit --no-fund --prefix "$OPT/claude-code" "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION" >/dev/null
  as_user "$bin" --version
}

# An ssh client that knows RemoteCommand (7.6+): the device tunnel's config uses it.
# CentOS 7's 7.4 fails every device probe ("Bad configuration option: remotecommand", close code 4003).
ensure_openssh() {
  local have; have=$(ssh -V 2>&1 | grep -oE 'OpenSSH_[0-9]+\.[0-9]+' | cut -d_ -f2)
  if version_ge "$have" 7.6; then SSH_BIN_DIR=; return; fi
  SSH_BIN_DIR=$OPT/openssh-$OPENSSH_VERSION/bin
  if [ -x "$SSH_BIN_DIR/ssh" ]; then return; fi
  need_docker "OpenSSH $OPENSSH_VERSION (host has $have)"
  log "OpenSSH $OPENSSH_VERSION client, built without OpenSSL (the tunnel uses Ed25519 only)"
  local tmp; tmp=$(mktemp -d); chmod 755 "$tmp"
  local u=https://cdn.openbsd.org/pub/OpenBSD/OpenSSH
  curl -fsSL -o "$tmp/src.tar.gz" "$u/portable/openssh-$OPENSSH_VERSION.tar.gz"
  curl -fsSL -o "$tmp/src.tar.gz.asc" "$u/portable/openssh-$OPENSSH_VERSION.tar.gz.asc"
  curl -fsSL -o "$tmp/RELEASE_KEY.asc" "$u/RELEASE_KEY.asc"
  (export GNUPGHOME="$tmp/gnupg"; mkdir -m 700 "$GNUPGHOME"; gpg -q --import "$tmp/RELEASE_KEY.asc" 2>/dev/null
   gpg --verify "$tmp/src.tar.gz.asc" "$tmp/src.tar.gz" 2>&1 | grep -q 'Good signature') || die "OpenSSH signature check failed"
  docker run --rm --user "$CCDT_UID:$CCDT_GID" -e HOME=/tmp -v "$tmp:/b" "$BUILD_IMAGE" bash -c \
    "cd /tmp && tar -xzf /b/src.tar.gz && cd openssh-$OPENSSH_VERSION && ./configure --without-openssl --sysconfdir=/etc/ssh >/dev/null && make -j2 ssh scp sftp >/dev/null && cp ssh scp sftp /b/"
  install -d -o "$CCDT_UID" -g "$CCDT_GID" "$SSH_BIN_DIR"
  install -o "$CCDT_UID" -g "$CCDT_GID" -m 755 "$tmp"/ssh "$tmp"/scp "$tmp"/sftp "$SSH_BIN_DIR/"
  rm -rf "$tmp"
  "$SSH_BIN_DIR/ssh" -V
}

# Source of one release directory: the fork at a ref (branch, tag or commit).
fetch_source() {  # <ref> <dir>
  as_user git init -q "$2"
  (cd "$2" && as_user git fetch -q --depth 1 "$CCDT_REPO" "$1" && as_user git checkout -q FETCH_HEAD)
}

# Production dependencies of the server; node-pty is built for this host's glibc.
install_dependencies() {  # <dir> [<dir of a previous release to reuse node-pty from>]
  local dir=$1 prev=${2:-} want have
  log "server dependencies"
  (cd "$dir" && as_user npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
     --workspace=@cc-desk-tunnel/server --workspace=@cc-desk-tunnel/protocol >/dev/null)
  want=$(as_user node -p "require('$dir/node_modules/node-pty/package.json').version")
  if [ -n "$prev" ] && [ -f "$prev/node_modules/node-pty/build/Release/pty.node" ]; then
    have=$(as_user node -p "require('$prev/node_modules/node-pty/package.json').version")
    if [ "$have" = "$want" ]; then
      log "node-pty $want: reusing the build of $(basename "$prev")"
      as_user cp -a "$prev/node_modules/node-pty/build" "$dir/node_modules/node-pty/"
      return
    fi
  fi
  log "node-pty $want: building"
  local gyp=$OPT/node24/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js
  if command -v g++ >/dev/null && version_ge "$(g++ -dumpversion)" 10; then
    (cd "$dir/node_modules/node-pty" && as_user node "$gyp" rebuild --nodedir="$OPT/node24" >/dev/null)
  else
    need_docker "node-pty (host compiler too old for Node 24 headers)"
    local nodedir; nodedir=$(readlink -f "$OPT/node24")
    docker run --rm --user "$CCDT_UID:$CCDT_GID" -e HOME=/tmp -v "$dir:/app" -v "$nodedir:/node:ro" "$BUILD_IMAGE" bash -c \
      "export PATH=/node/bin:\$PATH PYTHON=/opt/python/cp311-cp311/bin/python3; cd /app/node_modules/node-pty && node /node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --nodedir=/node -j 2 >/dev/null"
  fi
  (cd "$dir" && as_user node -e "require('node-pty')") || die "node-pty does not load"
}

# The browser client (apps/server/web) is not in git: take it from the upstream release of the same version,
# or build it with Vite as upstream's Dockerfile does.
install_web() {  # <dir>
  local dir=$1 version tmp name
  [ -s "$dir/apps/server/web/index.html" ] && return
  version=$(as_user node -p "require('$dir/apps/desktop/package.json').version")
  tmp=$(mktemp -d); chmod 755 "$tmp"; name=cc-desk-tunnel-server-$version.tar.gz   # the service user copies from it
  if curl -fsSL --max-time 120 -o "$tmp/$name" "https://github.com/$UPSTREAM_REPO/releases/download/v$version/$name" \
     && curl -fsSL --max-time 60 -o "$tmp/SHA256SUMS" "https://github.com/$UPSTREAM_REPO/releases/download/v$version/SHA256SUMS" \
     && (cd "$tmp" && grep "  $name\$" SHA256SUMS | sha256sum -c - >/dev/null); then
    log "web client from upstream release $version"
    tar -xzf "$tmp/$name" -C "$tmp" apps/server/web
    as_user cp -a "$tmp/apps/server/web" "$dir/apps/server/"
  else
    log "web client: building with Vite (no upstream release $version)"
    (cd "$dir" && as_user env ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --include=dev --ignore-scripts --no-audit --no-fund \
       --workspace=@cc-desk-tunnel/desktop --workspace=@cc-desk-tunnel/protocol >/dev/null \
     && as_user node node_modules/vite/bin/vite.js build --config apps/desktop/vite.config.ts --outDir ../server/web --emptyOutDir >/dev/null)
  fi
  rm -rf "$tmp"
  [ -s "$dir/apps/server/web/index.html" ] || die "no web client"
}

# Start a release on a loopback port with a scratch data directory and wait for its ready line.
smoke_test() {  # <dir>
  local dir=$1 tmp port=18787 pid ok=
  tmp=$(mktemp -d); chown "$CCDT_UID:$CCDT_GID" "$tmp"
  sed -e "s|^PROXY_PORT=.*|PROXY_PORT='$port'|" -e "s|^PROXY_HOST=.*|PROXY_HOST='127.0.0.1'|" \
      -e "s|^PROXY_DATA_DIR=.*|PROXY_DATA_DIR='$tmp/state'|" "$CONF/service.env" > "$tmp/service.env"
  chown "$CCDT_UID:$CCDT_GID" "$tmp/service.env"; chmod 600 "$tmp/service.env"
  as_user node --env-file="$tmp/service.env" "$dir/apps/server/src/main.ts" >"$tmp/log" 2>&1 & pid=$!
  for _ in $(seq 1 30); do grep -q 'Proxy native service' "$tmp/log" && { ok=1; break; }; sleep 1; done
  # $pid is runuser, which does not pass the signal on: stop the node it started by its unique --env-file.
  pkill -TERM -f -- "--env-file=$tmp/service.env" 2>/dev/null || true   # set -e: no match / killed child are not errors
  for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  pkill -KILL -f -- "--env-file=$tmp/service.env" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  [ -n "$ok" ] || { tail -20 "$tmp/log" >&2; rm -rf "$tmp"; die "smoke test failed: $(basename "$dir") did not start"; }
  rm -rf "$tmp"; log "smoke test passed"
}

# Restart only when no Claude process of the service is running, unless forced.
restart_when_idle() {  # [--now] [max seconds]
  local now=${1:-} max=${2:-10800} pid waited=0
  [ "$now" = --now ] || while :; do
    pid=$(systemctl show cc-desk-tunnel -p MainPID | cut -d= -f2)
    [ "$pid" = 0 ] || [ -z "$(ps -o pid= --ppid "$pid")" ] && break
    [ "$waited" -ge "$max" ] && die "sessions still running after ${max}s; rerun with --now to cut them off"
    [ "$waited" = 0 ] && log "waiting for running sessions to end (Ctrl+C to stop; --now to skip)"
    sleep 15; waited=$((waited + 15))
  done
  systemctl restart cc-desk-tunnel
  sleep 4; systemctl is-active --quiet cc-desk-tunnel || die "service did not come back; see journalctl -u cc-desk-tunnel"
  log "service restarted"
}
