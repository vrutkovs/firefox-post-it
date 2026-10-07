# firefox-post-it — plan

Clone of [WebStickies](https://addons.mozilla.org/en-US/firefox/addon/webstickies/). Notes are stored as Markdown files under a root dir, e.g. an Obsidian vault.

## Stack
- MV3 extension (Firefox/Zen, gecko id set in `browser_specific_settings`).
- Python 3 native messaging host, stdlib only. It runs **inside the Zen flatpak sandbox**, using the runtime's `python3`.
- Files are the source of truth. `browser.storage` holds only settings and UI state.

## Layout
```
manifest.json              MV3; perms: nativeMessaging, storage, tabs, <all_urls>; commands
background.js              router content ↔ host (runtime.sendNativeMessage per op); SPA nav
content/sticky.js          Shadow DOM notes: drag, resize, color, minimize, edit, debounced save
content/render.js          Markdown parser + DOM builder (no innerHTML)
content/sticky.css
popup/popup.{html,js}      new note, minimize all
options/options.{html,js}  shows root (read-only, from host), default color/size, "test connection"
native/postit_host.py      length-prefixed JSON protocol
native/postit.json.in      host manifest template
native/install.sh          installs host, manifest, config into the flatpak app dir
native/test_postit_host.py unittest
test/render.test.js        node --test for the parser
README.md
```

## Host protocol
Each op is one `sendNativeMessage` call: stateless, so no request IDs are needed. The extension never sends `root`; the host reads it from its own config.

| op | args | result |
|---|---|---|
| `ping` | — | version, root, root exists/writable |
| `load` | `url` | notes in the URL's dir, each with `mtime` |
| `save` | `url, note, mtime?` | `id`, new `mtime`, or `{"error":"conflict"}` if file changed on disk |
| `delete` | `url, id` | removes file, prunes empty dirs up to (not incl.) root |

Host rules:
- Read and write with `sys.stdin.buffer` / `sys.stdout.buffer` and `struct '=I'` framing.
- Each op runs inside try/except. Errors return `{"error": ...}`. Logging goes to stderr only; never print to stdout.
- Every reply stays under 1 MB (Firefox limit). Cap `load` and return an error when it is exceeded.

## Security
- Root comes only from the host config file (`config.json` next to the host). The host checks it is absolute and an existing dir.
- `id` must match `^[A-Za-z0-9_-]+$`. Only `.md` files are touched.
- Containment check: `os.path.commonpath([realpath(root), realpath(target)]) == realpath(root)`.
- Prune never removes root or anything above it.
- Note bodies go through the hand-built renderer (see Rendering). Never `innerHTML`.
- Host manifest `allowed_extensions` contains only this extension's gecko id.
- Sandbox: Zen can write only to the Highlights dir; the flatpak override grants exactly that.

## Path rule
`https://github.com/openshift/mco/blob/main/docs/x` → `<root>/github.com/openshift/mco/blob/main/docs/x/<id>.md`

- Only `http`/`https` URLs are accepted. Others are rejected.
- The trailing `/` is stripped. An empty path → `index`.
- Fragment is dropped.
- Query is kept by default as a short hash segment: `watch?v=abc` → `watch/q-3f9a1c/`. Query params are sorted before hashing. A per-note `ignore_query` flag skips this.
- Percent-decode first, then sanitize each segment:
  - drop `.` / `..` segments
  - replace `<>:"\|?*` and control chars with `_`
  - strip trailing dots and spaces
- A segment longer than 100 bytes is truncated and gets a `-<hash8>` suffix. Path depth is capped.
- `<id>` = `YYYY-MM-DDTHH-MM-SS`. The host creates the file with `open(path, 'x')`. If the file exists, it tries `<id>-2`, `<id>-3`, and so on.
- `makedirs` + write is retried on `FileNotFoundError`, in case a concurrent prune removed the dir.

## Note file
Frontmatter values are written with `json.dumps` and read with `json.loads`. JSON is valid YAML, so Obsidian parses it. No PyYAML needed.

```md
---
url: "https://github.com/..."
color: "yellow"
tags: ["a", "b"]
created: "2026-10-07T10:23:45"
updated: "2026-10-07T10:30:00"
---
body markdown
```

- Position and size (`x, y, w, h, minimized`) live in `browser.storage.local`, keyed by note id. This avoids rewriting the file on every drag.
- Writes are atomic: write a temp file in the same dir, then `os.replace`.

## Rendering
`content/render.js` has two parts:
- `parse(md) → blocks`: a pure function, tested with `node --test`.
- `build(blocks) → DOM`: uses only `createElement`, `textContent` and `setAttribute`.

Supported syntax:

| Syntax | Result |
|---|---|
| `**x**`, `__x__` | bold |
| `*x*`, `_x_` | italic |
| `` `x` `` | inline code |
| ```` ``` ```` fenced block | `<pre><code>`; nothing inside is parsed |
| `- x`, `* x`, `1. x` | lists, one level of nesting by indent |
| `- [ ] x`, `- [x] x` | checkbox (Obsidian task syntax) |
| `[text](url)`, bare `https://…` | link |

- Links: only `http:` / `https:` are allowed. Any other scheme (`javascript:`, `data:`) renders as plain text. Links open with `target=_blank` and `rel=noopener noreferrer`.
- Checkbox: clicking it toggles `[ ]` ↔ `[x]` on its source line (`parse` records the line number), then saves with `mtime`.
- Anything not supported shows as literal text.
- Editing: clicking the body (but not a link or checkbox) switches to a `<textarea>` with the raw Markdown. On blur or Esc it switches back to rendered view.

## Behavior
- Page load: the content script sends `load` and renders the notes.
- Body edit: saved after a 500 ms debounce. The save includes the last known `mtime`. On `conflict`, reload the note from disk and show a notice.
- Tab activated: flush pending saves, then reload notes. Skip the note being edited.
- SPA navigation: the background listens to `tabs.onUpdated` (`changeInfo.url`) and tells the content script to clear and load again. A note's URL is read from `location.href` when the note is created.
- Shortcuts: Alt+Shift+N new note, M minimize all, O popup, L options. Check for conflicts with existing Zen/OS bindings.

## Install (Zen flatpak)
The user sets up the override by hand (not done by `install.sh`):
```sh
flatpak override --user app.zen_browser.zen \
  --persist=.mozilla \
  --filesystem=~/Documents/obsidian/vadim/3-Resources/Highlights
```
- `--persist=.mozilla`: Zen reads `~/.mozilla/native-messaging-hosts`, not `~/.zen` (zen-browser/desktop#10622).

`native/install.sh [--app-id app.zen_browser.zen] --root <dir>` installs:
- `~/.var/app/<id>/postit/postit_host.py` (chmod +x, shebang `#!/usr/bin/env python3` → runtime python inside the sandbox)
- `~/.var/app/<id>/postit/config.json` → `{"root": "<dir>"}`
- `~/.var/app/<id>/.mozilla/native-messaging-hosts/postit.json`, with `path` set to the host's absolute path. `~/.var/app/<id>` is mounted at the same path inside the sandbox.
- It refuses to run if `--root` is not absolute.

Then:
- Check in `about:config` that `widget.use-xdg-desktop-portal.native-messaging` and `widget.use-xdg-desktop-portal.native-messaging-proxy` are `0`, so Zen starts the host itself.
- Fully restart Zen after the override.
- A temporary add-on via `about:debugging` is lost on restart. For a permanent install, set `xpinstall.signatures.required=false` if Zen honors it, otherwise sign it as an unlisted AMO add-on.

## Out of scope
- Sync: the vault handles it.
- Folders: URL dirs cover that.
- Listing or searching all notes: use Obsidian.
- Regex URL matching: a note shows only on its exact URL.
- Markdown beyond the Rendering table (headings, tables, images, HTML).

## Tests
`python -m unittest`:
- Path sanitizing: encoded `..`, non-http scheme, segments too long, trailing dot/space, `index` normalization, query hash.
- Root containment: reject a root that only shares a prefix (`/Highlights2` vs `/Highlights`). Prune stops at root.
- ID collision: second create in the same second → `-2`.
- Frontmatter round-trip with `:`, `#`, `,`, newlines and quotes in values.
- mtime conflict rejection.
- Reply size cap (>1 MB input).
- Missing or invalid `config.json` → error reply, no write.
- Framing: valid message works. A stray stdout write is caught by the test.

`node --test`:
- Each syntax in the Rendering table.
- `javascript:` / `data:` links → text.
- `<script>` and HTML tags → literal text.
- Checkbox line numbers are correct, including inside nested lists and after a fenced block.
- Markers inside code are not parsed (`` `**x**` `` stays literal).

## Manual verify
1. Apply the override, run `install.sh`, restart Zen, load the extension temporarily. The options page "test connection" shows the root.
2. Create a note. The file appears under root at the expected path.
3. Edit the note in Obsidian, then switch back to the tab. The edit shows.
4. Edit the body in Obsidian, then drag the note in the browser. The body edit is kept.
5. Tick a checkbox in the browser. The file shows `- [x]`.
6. On GitHub, navigate within the site (SPA). Notes switch to the new page.
7. Two YouTube videos show separate notes.
