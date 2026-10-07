#!/bin/sh
# Install the post-it native messaging host into a flatpak browser's app dir.
set -eu

APP_ID=app.zen_browser.zen
EXT_ID=firefox-post-it@vrutkovs
ROOT=

usage() {
  echo "usage: $0 [--app-id <flatpak id>] --root <absolute notes dir>"
}

die() {
  echo "error: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app-id) [ $# -ge 2 ] || die "--app-id needs a value"; APP_ID=$2; shift 2 ;;
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
APP_DIR="$HOME/.var/app/$APP_ID"
HOST_DIR="$APP_DIR/postit"
NMH_DIR="$APP_DIR/.mozilla/native-messaging-hosts"
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
