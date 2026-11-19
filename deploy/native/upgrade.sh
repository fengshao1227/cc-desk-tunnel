#!/usr/bin/env bash
# Upgrade (or roll back) a native install. Run as root on the server.
#
#   bash deploy/native/upgrade.sh [ref] [--now]     build <ref> (default main), test, switch, restart when idle
#   bash deploy/native/upgrade.sh --rollback [--now] switch back to the previous release
#   bash deploy/native/upgrade.sh --list             show releases
#
# A release is built beside the running one in releases/<commit>; nothing changes for running sessions until
# the switch. The restart waits until no session is running unless --now is given. Old releases are kept for
# rollback; the last five stay.
#
# Before this, bring the fork up to date on a development machine:
#   git fetch upstream --tags && git merge vX.Y.Z   # resolve, run tests, push to the fork
# and install the clients (GUI, ccdt) of that same upstream version: the server checks versions match.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
[ "$(id -u)" = 0 ] || die "run as root"

now=; ref=main; mode=build
for arg in "$@"; do
  case "$arg" in
    --now) now=--now ;;
    --rollback) mode=rollback ;;
    --list) mode=list ;;
    -*) die "unknown option $arg" ;;
    *) ref=$arg ;;
  esac
done
current=$(readlink -f "$APP/current" 2>/dev/null || true)

case $mode in
  list)
    for d in $(ls -1dt "$APP"/releases/*/ 2>/dev/null); do
      d=${d%/}; mark=' '; [ "$d" = "$current" ] && mark='*'
      printf '%s %s  %s  %s\n' "$mark" "$(basename "$d")" \
        "$(cd "$d" && as_user git log -1 --format='%ci %s' 2>/dev/null | cut -c1-70)" \
        "$(as_user node -p "require('$d/apps/desktop/package.json').version" 2>/dev/null)"
    done
    exit ;;
  rollback)
    previous=$(cat "$APP/previous" 2>/dev/null || true)
    [ -n "$previous" ] && [ -d "$previous" ] || die "no previous release recorded"
    log "rolling back to $(basename "$previous")"
    as_user ln -sfn "$previous" "$APP/current"; echo "$current" > "$APP/previous"
    restart_when_idle $now
    exit ;;
esac

install_node
ensure_openssh
sha=$(git ls-remote "$CCDT_REPO" "$ref" | head -1 | cut -c1-12); [ -n "$sha" ] || sha=$(printf %s "$ref" | cut -c1-12)
release=$APP/releases/$sha
[ "$release" != "$current" ] || { log "already running $sha"; exit 0; }
if [ ! -f "$release/apps/server/src/main.ts" ]; then
  log "source $ref ($sha)"
  fetch_source "$ref" "$release"
fi
install_dependencies "$release" "$current"
install_web "$release"
smoke_test "$release"

old=$(as_user node -p "require('$current/apps/desktop/package.json').version" 2>/dev/null || echo '?')
new=$(as_user node -p "require('$release/apps/desktop/package.json').version")
as_user ln -sfn "$release" "$APP/current"; echo "$current" > "$APP/previous"
log "switched $old -> $new ($sha)"
restart_when_idle $now

# Keep the five newest releases (and never the one running or the rollback target).
ls -1dt "$APP"/releases/*/ | tail -n +6 | while read -r d; do
  d=${d%/}; [ "$d" = "$release" ] || [ "$d" = "$current" ] || rm -rf "$d"
done
[ "$old" = "$new" ] || echo "Version changed ($old -> $new): install GUI and ccdt $new on every Mac (see README)."
