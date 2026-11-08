# Third-Party Notices

## flatnotes (Original)

Copyright (c) 2021 Adam Dullage

globnotes incorporates code from flatnotes, which was originally released
under the MIT License.

The MIT License text is reproduced below:

---

MIT License

Copyright (c) 2021 Adam Dullage

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## Credits

globnotes stands on the work of many open-source projects and contributors.
This file credits the upstream [flatnotes](https://github.com/dullage/flatnotes)
project, the community that shaped this fork's design, and the dependencies
that power it.

### Upstream Project

- **[flatnotes](https://github.com/dullage/flatnotes)** by **Adam Dullage** —
  the excellent foundation globnotes is built on: the database-less
  architecture, the clean UI, the search and tagging engine, and the
  storage/attachment base-class split that made the title-as-path seam small
  and clean. flatnotes is licensed under the MIT License; its license text is preserved in
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

### The Subdirectory Discussion

globnotes exists because of a years-long community conversation about
subdirectory support in flatnotes. These contributions directly shaped the
design:

- **[Gedulis12](https://github.com/Gedulis12)** — author of
  [flatnotes PR #70](https://github.com/dullage/flatnotes/pull/70), the first
  subdirectory implementation, which mapped the problem space.
- **[danielmcmillan](https://github.com/danielmcmillan)** — the technical
  caveats list in PR #70 (path validation, traversal risk, orphaned empty
  directories, attachment paths) that became globnotes' security checklist.
- **[jorgeEF](https://github.com/jorgeEF)** — author of
  [flatnotes issue #301](https://github.com/dullage/flatnotes/issues/301),
  which reframed the request around app-independent markdown.
- **[ctmbl](https://github.com/ctmbl)** — the performance analysis and
  bring-your-own-storage discussion in issue #301.
- Everyone who weighed in with use cases and encouragement across both
  threads — Obsidian vaults, git-managed notes, Syncthing setups, and family
  wikis are the reason this fork exists.

### Backend

- **[Deno](https://deno.com/)** — the runtime (server, tests, and the
  permission-narrowed plugin Workers)
- **[SQLite FTS5](https://sqlite.org/fts5.html)** via Node's built-in
  `node:sqlite` — full-text search indexing (porter stemming, BM25)
- **[node-diff3](https://github.com/bhousel/node-diff3)** (MIT) — request-local
  three-way line merging for base-aware saves
- **[markdown-it](https://github.com/markdown-it/markdown-it)** — the
  markdown parser behind the render pipeline and plugin selectors
- **[Prism](https://prismjs.com/)** — code syntax highlighting
- **[jose](https://github.com/panva/jose)** — JWT tokens
- **[otplib](https://github.com/otplib/otplib)** & **[qrcode](https://github.com/soldair/node-qrcode)** — TOTP authentication
- **[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)**
  (`@modelcontextprotocol/server` and `@modelcontextprotocol/core`; the tests also
  use `@modelcontextprotocol/client`), Copyright (c) 2024-2025 Model Context
  Protocol a Series of LF Projects, LLC — the MCP endpoint
  ([docs/mcp.md](docs/mcp.md)). Licensed under the Apache License 2.0 (the
  packages' `license` field); per the packages' `LICENSE` file, contributions not
  yet relicensed remain under the MIT License and documentation is CC-BY-4.0
- **[Zod](https://zod.dev/)**, Copyright (c) 2025 Colin McDonnell — the MCP
  tools' input and output schemas. MIT License

### Remotely Save driver dependencies

The Remotely Save driver uses `@fyears/rclone-crypt` 0.0.7, Copyright (c)
2023 fyears, and `fast-xml-parser` 5.12.0, Copyright (c) 2017 Amit Kumar Gupta.
Both are MIT licensed. The XML parser's MIT-licensed runtime dependencies by
Amit Gupta are `@nodable/entities` 3.1.0, `fast-xml-builder` 1.3.1,
`is-unsafe` 2.0.3, `path-expression-matcher` 1.6.2, `strnum` 2.5.1 and
`xml-naming` 0.3.0. Published license declarations and supplied LICENSE files
are retained; exact transitive versions and integrity hashes are in `deno.lock`.
The OpenSSL codec is independently implemented. No Remotely Save source code
is included in the production plugin; pinned upstream sources are downloaded
only into test scratch for reference-vector generation.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Frontend

- **[Vue.js](https://vuejs.org/)** with **[Vue Router](https://router.vuejs.org/)** and **[Pinia](https://pinia.vuejs.org/)** — the application framework
- **[CodeMirror 6](https://codemirror.net/)** — source-mode markdown editing
- **[Milkdown](https://milkdown.dev/)** — WYSIWYG markdown editing
- **[PrimeVue](https://primevue.org/)** — UI primitives
- **[Tailwind CSS](https://tailwindcss.com/)** — styling
- **[Mermaid](https://mermaid.js.org/)** — diagram rendering
- **[KaTeX](https://katex.org/)** — math rendering
- **[Material Design Icons](https://pictogrammers.com/)** — icon set
- **[Mousetrap](https://craig.is/killing/mice)** — keyboard shortcuts
- **[axios](https://axios-http.com/)** — HTTP client
- **[Poppins](https://fonts.google.com/specimen/Poppins)** — typeface (Open Font License)

### Special Thanks

- The **Obsidian** community, whose vault conventions (wiki-links, callouts,
  embeds, per-vault attachments) globnotes adopts.

### License

Each dependency listed above is governed by its own respective license.
Please refer to their individual projects for licensing information.
