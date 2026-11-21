#!/bin/sh
# Installs ccbot for the service user on the server: the program, a local `ccbot` command, and the forced
# command the bot's SSH key is held to. Run as that user, from this folder. Safe to repeat.
#   sh install.sh                    install or update
#   sh install.sh --key 'ssh-ed25519 AAAA… name'   also allow that key, for ccbot only
set -eu
here=$(cd "$(dirname "$0")" && pwd)
node=${CCBOT_NODE:-$HOME/opt/node24/bin/node}
share=$HOME/.local/share/ccbot
bin=$HOME/.local/bin
[ -x "$node" ] || { echo "Node 24 not found at $node (set CCBOT_NODE)" >&2; exit 1; }
mkdir -p "$share" "$bin"
cp "$here/ccbot.mjs" "$here/lib.mjs" "$share/"
printf '#!/bin/sh\nexec %s %s/ccbot.mjs "$@"\n' "$node" "$share" > "$bin/ccbot"
# The key may run nothing else: arguments arrive in SSH_ORIGINAL_COMMAND and ccbot checks each of them.
printf '#!/bin/sh\nexec %s %s/ccbot.mjs --from-ssh\n' "$node" "$share" > "$bin/ccbot-ssh"
chmod 755 "$bin/ccbot" "$bin/ccbot-ssh"
echo "installed: $bin/ccbot, $bin/ccbot-ssh"

if [ "${1:-}" = "--key" ]; then
  key=${2:?missing key}
  case $key in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-*) ;; *) echo "not a public key" >&2; exit 1 ;; esac
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"
  body=$(printf '%s' "$key" | awk '{print $2}')
  if grep -q "$body" "$HOME/.ssh/authorized_keys"; then
    echo "key already present"
  else
    printf 'restrict,command="%s/ccbot-ssh" %s\n' "$bin" "$key" >> "$HOME/.ssh/authorized_keys"
    echo "key added, limited to ccbot"
  fi
fi
