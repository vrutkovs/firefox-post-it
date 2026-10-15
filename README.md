# firefox-post-it

Sticky notes on web pages for Firefox / Zen, stored as Markdown files under a root dir (e.g. an Obsidian vault). Clone of [WebStickies](https://addons.mozilla.org/en-US/firefox/addon/webstickies/).

A note made on `https://github.com/openshift/mco/blob/main/docs/x` is saved as
`<root>/github.com/openshift/mco/blob/main/docs/x/<YYYY-MM-DDTHH-MM-SS>.md`.
A query string becomes a hash segment (`watch?v=abc` → `watch/q-3f9a1c/`), unless the note is created with "Ignore query string".

```md
---
url: "https://github.com/..."
color: "yellow"
tags: []
created: "2026-10-07T10:23:45"
updated: "2026-10-07T10:30:00"
---
body markdown
```

Supported Markdown: `**bold**`, `*italic*`, `` `code` ``, fenced code, lists (one nested level), `- [ ]` tasks, `[links](https://…)` and bare `https://` URLs. Anything else shows as plain text.

## Install (Zen flatpak)

1. Let Zen see the notes dir and native host manifests:
   ```sh
   flatpak override --user app.zen_browser.zen \
     --persist=.mozilla \
     --filesystem=~/Documents/obsidian/vadim/3-Resources/Highlights
   ```
   `--persist=.mozilla` is needed: Zen reads `~/.mozilla/native-messaging-hosts`, not `~/.zen` ([zen-browser/desktop#10622](https://github.com/zen-browser/desktop/issues/10622)).
2. Install the host:
   ```sh
   make install-zen ROOT=~/Documents/obsidian/vadim/3-Resources/Highlights
   ```
   `ROOT` must be absolute (the shell expands `~`). Set `APP_ID=` for another flatpak browser.
3. In `about:config`, check that `widget.use-xdg-desktop-portal.native-messaging` and `widget.use-xdg-desktop-portal.native-messaging-proxy` are `0`.
4. Fully restart Zen.
5. Load the extension: `about:debugging` → This Zen → Load Temporary Add-on → `manifest.json`. Temporary add-ons are removed on restart. For a permanent install, set `xpinstall.signatures.required=false` (if Zen honors it) or sign as an unlisted add-on on AMO.
6. Options → "Test connection" must show the root.

## Install (plain Firefox)

Needs `python3` on `PATH`. Linux and macOS only (Windows needs a registry entry and a `.bat` wrapper; not supported).

1. Install the host:
   ```sh
   make install-firefox ROOT=~/Documents/notes
   ```
   | OS | Host + `config.json` | Host manifest |
   |---|---|---|
   | Linux | `~/.local/share/postit/` | `~/.mozilla/native-messaging-hosts/postit.json` |
   | macOS | `~/Library/Application Support/postit/` | `~/Library/Application Support/Mozilla/NativeMessagingHosts/postit.json` |
2. Restart Firefox.
3. Load the extension, one of:
   - **Temporary** (removed on restart): `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `manifest.json`. Or `make run` to start a fresh Firefox profile with it loaded.
   - **Permanent, signed** (any Firefox): create AMO API keys at <https://addons.mozilla.org/developers/addon/api/key/>, then
     ```sh
     AMO_API_KEY=user:123:456 AMO_API_SECRET=... make sign
     ```
     Install `web-ext-artifacts/*.xpi` via `about:addons` → gear → Install Add-on From File. Unlisted add-ons are not public. Bump `version` in `manifest.json` before each re-sign.
   - **Permanent, unsigned**: only Developer Edition, Nightly or ESR. Set `xpinstall.signatures.required=false`, run `make build`, install the zip from file. Release Firefox ignores this pref.
4. Options → "Test connection" must show the root.

Other packagings:
- **Flatpak Firefox**: follow the Zen steps with `APP_ID=org.mozilla.firefox` and the override on `org.mozilla.firefox` (no `--persist` needed).
- **Snap Firefox**: the host runs outside the snap through xdg-desktop-portal, so use `make install-firefox`. Keep the `widget.use-xdg-desktop-portal.native-messaging*` prefs at their defaults.

Troubleshooting: the browser console (Ctrl+Shift+J) shows host start errors. Check the host by hand:
```sh
python3 -c 'import sys,struct,json; d=json.dumps({"op":"ping"}).encode(); sys.stdout.buffer.write(struct.pack("=I",len(d))+d)' \
  | ~/.local/share/postit/postit_host.py | tail -c +5
```

## Todoist links (optional)

Set `TODOIST_NOTES` when installing the host to scan Markdown files under that directory, including subdirectories:

```sh
make install-zen ROOT=~/Documents/obsidian/vadim/3-Resources/Highlights \
  TODOIST_NOTES=~/Documents/obsidian/vadim/1-Projects/Todoist
```

For plain Firefox, use `make install-firefox` with the same arguments. For a flatpak browser, also grant access to the Todoist directory with `flatpak override --user app.zen_browser.zen --filesystem=~/Documents/obsidian/vadim/1-Projects/Todoist` and restart the browser. Reinstall the host to change the directory. If `TODOIST_NOTES` is unset, the integration is disabled.

When a Todoist note's frontmatter `title` contains the current page URL and its `todoist_url` is an HTTP(S) URL, a ☑ link appears beside the color palette in each sticky note's header. Click it to open the task in Todoist. The integration reads Todoist notes but does not change them.

## Usage

| Shortcut | Action |
|---|---|
| Alt+Shift+N | New note |
| Alt+Shift+M | Minimize / restore all |
| Alt+Shift+O | Popup |
| Alt+Shift+L | Options |

Change shortcuts in `about:addons` → gear → Manage Extension Shortcuts if they clash with Zen or desktop bindings.

- Right-click a page → **New note**. New notes open at the mouse pointer.
- Click the note body to edit; Esc or click outside to finish. Saves after 500 ms.
- Drag by the header; resize from the bottom-right corner. Position and size are kept in browser storage, not in the file.
- Edits made in Obsidian show when you switch back to the tab. If the file changed while you were editing, the note reloads from disk and shows a notice.

## Development

```sh
make test    # python + node tests
make lint    # web-ext lint + shellcheck
make build   # unsigned zip
make         # list targets
```

## License

Copyright 2026 Vadim Rutkovsky. Licensed under the [Apache License 2.0](LICENSE).
