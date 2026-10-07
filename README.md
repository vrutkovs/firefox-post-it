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
   native/install.sh --root ~/Documents/obsidian/vadim/3-Resources/Highlights
   ```
   `--root` must be absolute (the shell expands `~`). Use `--app-id` for another flatpak browser.
3. In `about:config`, check that `widget.use-xdg-desktop-portal.native-messaging` and `widget.use-xdg-desktop-portal.native-messaging-proxy` are `0`.
4. Fully restart Zen.
5. Load the extension: `about:debugging` → This Zen → Load Temporary Add-on → `manifest.json`. Temporary add-ons are removed on restart. For a permanent install, set `xpinstall.signatures.required=false` (if Zen honors it) or sign as an unlisted add-on on AMO.
6. Options → "Test connection" must show the root.

## Usage

| Shortcut | Action |
|---|---|
| Alt+Shift+N | New note |
| Alt+Shift+M | Minimize / restore all |
| Alt+Shift+O | Popup |
| Alt+Shift+L | Options |

Change shortcuts in `about:addons` → gear → Manage Extension Shortcuts if they clash with Zen or desktop bindings.

- Click the note body to edit; Esc or click outside to finish. Saves after 500 ms.
- Drag by the header; resize from the bottom-right corner. Position and size are kept in browser storage, not in the file.
- Edits made in Obsidian show when you switch back to the tab. If the file changed while you were editing, the note reloads from disk and shows a notice.

## Development

```sh
python3 -m unittest discover -s native
node --test test/*.test.js
npx web-ext lint --ignore-files 'native/**' 'test/**' plan.md
```
