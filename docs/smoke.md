# Manual smoke checklist

Run through this after building a new image or before a release. Assumes a
fixture vault:

```bash
mkdir -p /tmp/globnotes-fixture/dad/recipes /tmp/globnotes-fixture/dad/assets
printf '# Soup\n\n![[broth.jpg]]\n\nSee [[quicknote]] and [rel](quicknote.md)\n' \
  > /tmp/globnotes-fixture/dad/recipes/soup.md
printf 'fake-jpg' > /tmp/globnotes-fixture/dad/assets/broth.jpg
printf '# Quick\n\n==highlighted== #taggy\n' > /tmp/globnotes-fixture/dad/quicknote.md
```

## First-run wizard (no auth env vars)

- [ ] Start container without `GLOBNOTES_AUTH_TYPE` → UI shows the setup wizard; API calls return 503.
- [ ] "Create password" → login prompt appears; logging in works.
- [ ] Restart container → no wizard; login still works.
- [ ] (Fresh dir) "Disable auth" → straight into the app; startup log warns about no auth.

## Notes

- [ ] `dad/recipes/soup` and `dad/quicknote` appear in the note list with full paths.
- [ ] Search for `dad` finds both notes (path-segment search).
- [ ] Deep link / hard refresh on `/note/dad/recipes/soup` loads the note.
- [ ] Create note `x/y/z` → directories created on disk.
- [ ] Rename `x/y/z` → `a/b` → file moved; `x/` pruned from disk.
- [ ] Delete `a/b` → file gone; `a/` pruned.
- [ ] Titles with `..`, `//`, leading `.` are rejected with a clean error.

## Rendering

- [ ] `[[quicknote]]` in soup is a working link; `![[broth.jpg]]` shows the image.
- [ ] `[rel](quicknote.md)` link works.
- [ ] `==highlighted==` renders as a highlight; `#taggy` links to search.
- [ ] A `> [!note]` callout renders styled, without the `[!note]` marker.
- [ ] A mermaid block renders a diagram; `$x^2$` renders as math.
- [ ] Frontmatter renders as a properties block.

## Files

- [ ] Paste an image into a nested note → file lands beside the note; link is relative; image renders.
- [ ] `/files/dad/recipes/soup.md` returns raw markdown.
- [ ] `/files/.globnotes/...` returns 404.
- [ ] An `.html` file in the tree downloads instead of rendering.
