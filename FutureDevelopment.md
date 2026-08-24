# Future Development

Ideas and deferred work. Each entry: what it is, why it's deferred, and the
intended approach.

## Deferred from v1

### View-mode line highlight

Clicking a rendered line in view mode should yield a shareable fragment and
highlight the line(s) in `ServerViewer`. The fragment grammar and its sole
writer already exist (`client/fragment.js`, landed with edit-mode URLs:
`#edit` / `#source:L<n>[-<m>]`); this feature plugs into the same delegated
writer instead of growing a second one. Since bare `#L` links never shipped
and now parse as unknown, the form is free — a `view` mode segment (e.g.
`#view:L<n>[-<m>]`) keeps the single grammar intact. Deferred: server-side
line identity in rendered HTML, click handling, highlight styling, and the
view-mode landing path for shared line links.

### Note transclusion (`![[Note]]`)

Embed one note's content inside another, Obsidian-style. Deferred: needs
cycle detection and recursive render guards. Intended approach: resolve the
target note, fetch its content via the notes API, and inline-render with a
depth cap. Until then, note embeds render as plain links.

### Unresolved wiki-link styling

Obsidian dims links to notes that don't exist yet. The renderer move
happened (the `globnotes-autolinks` server plugin owns wiki-links now);
what remains is emitting a distinguishing class on unresolved links — the
plugin knows (it resolves against `ctx.listTitles()`), it just needs to
add `class="unresolved"` and the client needs the style.

### Block references (`^id`) and block transclusion

Deep rabbit hole: block identity, anchors, and reference resolution.

### Backlinks pane / graph view

Needs a link index built from resolved wiki-links.

### Editor-side Obsidian features

Wiki-link autocomplete, live preview of Obsidian syntax in the editor.
ToastUI is gone (CodeMirror 6 source + Milkdown WYSIWYG); the path is
editor halves per plugin — `$remark` syntax + `$node` atom views mounting
the same HTML the server renderer produces.

### Mermaid theme awareness

Mermaid renders with its default theme; it should follow the app theme
(light/dark). Now owned by the `globnotes-mermaid` plugin (its editor/
client half can pass the theme at render time).

### CSRF Origin allowlist

ExcaliDash-style `FRONTEND_URL` exact-match checking of the Origin header
for API mutations. Not needed yet; revisit if globnotes gets exposed beyond
trusted networks.

### TOTP via setup wizard

The first-run wizard offers password or none; TOTP stays env-configured.

### Compat hats (`obsidian-hat-*`)

Ordinary plugins that abstain unless their ecosystem marker is present —
e.g. an Obsidian hat checks `<vault>/.obsidian/community-plugins.json` via
`ctx.readFile` and only then renders Obsidian-specific syntax. Hats are how
globnotes supports ecosystem-flavored content without the core ever hearing
the word "obsidian."

### UI revamp (Obsidian-class UI)

Long-term ambition: revamp the UI toward an Obsidian-class experience.

### `/api/teapot`

418 Easter egg — teapot is good for type mismatch.

### Real logo

Text wordmark for now.
