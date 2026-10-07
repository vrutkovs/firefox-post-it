#!/bin/sh
# Install the post-it native messaging host for a flatpak browser (default)
# or, with --native, for a non-sandboxed Firefox (Linux/macOS).
set -eu

APP_ID=app.zen_browser.zen
EXT_ID=firefox-post-it@vrutkovs
ROOT=
NATIVE=

usage() {
  echo "usage: $0 [--app-id <flatpak id> | --native] --root <absolute notes dir>"
}

die() {
  echo "error: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app-id) [ $# -ge 2 ] || die "--app-id needs a value"; APP_ID=$2; shift 2 ;;
    --native) NATIVE=1; shift ;;
    --root) [ $# -ge 2 ] || die "--root needs a value"; ROOT=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[ -n "$ROOT" ] || { usage >&2; exit 2; }
case "$ROOT" in
  /*) ;;
  *) die "--root must be an absolute path" ;;
esac
case "$APP_ID" in
  */*|.*|'') die "invalid --app-id" ;;
esac
[ -d "$ROOT" ] || echo "warning: $ROOT does not exist yet" >&2

HERE=$(cd "$(dirname "$0")" && pwd)
if [ -z "$NATIVE" ]; then
  # ~/.var/app/<id> is mounted at the same path inside the sandbox
  APP_DIR="$HOME/.var/app/$APP_ID"
  HOST_DIR="$APP_DIR/postit"
  NMH_DIR="$APP_DIR/.mozilla/native-messaging-hosts"
elif [ "$(uname -s)" = Darwin ]; then
  HOST_DIR="$HOME/Library/Application Support/postit"
  NMH_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
else
  HOST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/postit"
  NMH_DIR="$HOME/.mozilla/native-messaging-hosts"
fi
HOST_PATH="$HOST_DIR/postit_host.py"

mkdir -p "$HOST_DIR" "$NMH_DIR"
install -m 755 "$HERE/postit_host.py" "$HOST_PATH"

# python handles JSON escaping of arbitrary paths
python3 - "$ROOT" "$HOST_PATH" "$EXT_ID" "$HERE/postit.json.in" "$HOST_DIR/config.json" "$NMH_DIR/postit.json" <<'EOF'
import json, sys
root, host_path, ext_id, template, config_out, manifest_out = sys.argv[1:]
with open(config_out, "w") as f:
    json.dump({"root": root}, f, indent=2)
    f.write("\n")
with open(template) as f:
    manifest = json.load(f)
manifest["path"] = host_path
manifest["allowed_extensions"] = [ext_id]
with open(manifest_out, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
EOF

echo "host:     $HOST_PATH"
echo "config:   $HOST_DIR/config.json (root: $ROOT)"
echo "manifest: $NMH_DIR/postit.json"
echo "Fully restart the browser to pick up the host."
