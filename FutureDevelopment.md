# Future Development

Ideas and deferred work. Each entry: what it is, why it's deferred, and the
intended approach.

## Deferred from v1

### Note transclusion (`![[Note]]`)

Embed one note's content inside another, Obsidian-style. Deferred: needs
cycle detection and recursive render guards. Intended approach: resolve the
target note, fetch its content via the notes API, and inline-render with a
depth cap. Until then, note embeds render as plain links.

### Unresolved wiki-link styling

Obsidian dims links to notes that don't exist yet. Deferred: the autolinks
API can't attach CSS classes to generated links; wiki-links need to move
from `extendedAutolinks` to a custom text-node renderer (which can also
unify them with embed handling).

### Block references (`^id`) and block transclusion

Deep rabbit hole: block identity, anchors, and reference resolution.

### Backlinks pane / graph view

Needs a link index built from resolved wiki-links.

### Editor-side Obsidian features

Wiki-link autocomplete, live preview of Obsidian syntax in the editor. The
editor is stock ToastUI for now; serious editing is expected to happen in
Obsidian.

### Inline-code awareness in preprocessing

The fence-aware preprocessing (embeds, comments) also transforms inside
inline code spans. Rare in practice; fix by tracking inline code spans per
line.

### Mermaid theme awareness

Mermaid renders with its default theme; it should follow the app theme
(light/dark).

### CSRF Origin allowlist

ExcaliDash-style `FRONTEND_URL` exact-match checking of the Origin header
for API mutations. Not needed yet; revisit if globnotes gets exposed beyond
trusted networks.

### TOTP via setup wizard

The first-run wizard offers password or none; TOTP stays env-configured.

### UI revamp (Obsidian-class UI)

Long-term ambition: revamp the UI toward an Obsidian-class experience.

### `/api/teapot`

418 Easter egg — teapot is good for type mismatch.

### Real logo

Text wordmark for now.
