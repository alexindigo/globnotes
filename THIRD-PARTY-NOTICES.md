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

- **[FastAPI](https://fastapi.tiangolo.com/)** — the API framework
- **[Whoosh](https://whoosh.readthedocs.io/)** — full-text search indexing
- **[uvicorn](https://www.uvicorn.org/)** — ASGI server
- **[python-jose](https://github.com/mpdavis/python-jose)** — JWT tokens
- **[pyotp](https://github.com/pyauth/pyotp)** & **[qrcode](https://github.com/lincolnloop/python-qrcode)** — TOTP authentication
- **[python-multipart](https://github.com/Kludex/python-multipart)** — file uploads
- **[aiofiles](https://github.com/Tinche/aiofiles)** — async file handling
- **[uv](https://github.com/astral-sh/uv)** — dependency management

### Frontend

- **[Vue.js](https://vuejs.org/)** with **[Vue Router](https://router.vuejs.org/)** and **[Pinia](https://pinia.vuejs.org/)** — the application framework
- **[Toast UI Editor](https://ui.toast.com/tui-editor)** — markdown editing and rendering
- **[PrimeVue](https://primevue.org/)** — UI primitives
- **[Tailwind CSS](https://tailwindcss.com/)** — styling
- **[Mermaid](https://mermaid.js.org/)** — diagram rendering
- **[KaTeX](https://katex.org/)** — math rendering
- **[Prism](https://prismjs.com/)** — code syntax highlighting
- **[Material Design Icons](https://pictogrammers.com/)** — icon set
- **[Mousetrap](https://craig.is/killing/mice)** — keyboard shortcuts
- **[axios](https://axios-http.com/)** — HTTP client
- **[Poppins](https://fonts.google.com/specimen/Poppins)** — typeface (Open Font License)

### Special Thanks

- The **Obsidian** community, whose vault conventions (wiki-links, callouts,
  embeds, per-vault attachments) globnotes adopts.
- The **Syncthing** and **git** communities — the sync-and-backup workflows
  globnotes is designed to fit into.

### License

Each dependency listed above is governed by its own respective license.
Please refer to their individual projects for licensing information.
