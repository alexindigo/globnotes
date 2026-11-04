# MCP server

globnotes serves the [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) so AI agents (Claude Code, Claude Desktop, opencode and other MCP clients)
can search your vault, read notes, browse folders and tags, and create, edit,
rename and delete notes. The MCP endpoint is part of the globnotes server, not a
separate process. It uses the same authentication, write path and plugin guards
as the web app and the REST API, and grants nothing that the same token doesn't
already grant there.

## The endpoint

| # | Item | Value |
|---|---|---|
| 1 | URL | `<origin><prefix>/_/mcp`, e.g. `http://globnotes.home/_/mcp`, or `http://nas.home/mom/_/mcp` with `GLOBNOTES_PATH_PREFIX=/mom` |
| 2 | Transport | Streamable HTTP, stateless: every JSON-RPC message is one `POST`, answered with one JSON body. No sessions and no server-sent event streams. The server sends no change notifications, so `subscriptions/listen` answers `404` (method not found) |
| 3 | Protocol revisions | 2026-07-28 and the 2025 revisions (`initialize` handshake), from the same endpoint |
| 4 | `GET`, `DELETE` | `405 Method Not Allowed`, `Allow: POST` |
| 5 | Switch | `GLOBNOTES_MCP_ENABLED=false` turns it off; the URL then answers `404`. On by default |
| 6 | Plain HTTP | Works over plain HTTP on a local domain (no HTTPS needed, see [Security](#security)) |

It's built on the official TypeScript SDK (`@modelcontextprotocol/server`).

## Getting a token

The MCP endpoint accepts the same credentials as the REST API.

| # | `GLOBNOTES_AUTH_TYPE` | What MCP clients send |
|---|---|---|
| 1 | `none` | Nothing. Anyone who can reach the server can read and write |
| 2 | `read_only` | Nothing. Only the read tools are offered ([Read-only mode](#read-only-mode)) |
| 3 | `password`, `totp` | `Authorization: Bearer <token>`, with a token from `POST /_/api/token` |

Get a token with your login. In `totp` mode, append the current authenticator code to the
password, as on the login page:

```sh
curl -s -X POST http://globnotes.home/_/api/token \
  -H 'Content-Type: application/json' \
  -d '{"username": "me", "password": "my password"}'
# {"access_token":"eyJ…","token_type":"bearer"}
```

Keep the `access_token` value, e.g. in `GLOBNOTES_TOKEN`.

**Token lifetime.** The token is the web app's session token. It expires with the session,
after `GLOBNOTES_SESSION_EXPIRY_DAYS` (30 days by default), and it stops working earlier when
the password or 2FA settings change. An expired token makes every MCP request fail with
`401`; get a new one and update the client's configuration. globnotes has no separate API
tokens or MCP OAuth.

## Client configuration

The examples use `http://globnotes.home/_/mcp`; replace it with your server's address and
prefix. In `none` and `read_only` mode, leave out the `Authorization` header.

### Claude Code

```sh
claude mcp add --transport http globnotes http://globnotes.home/_/mcp \
  --header "Authorization: Bearer $GLOBNOTES_TOKEN"
```

### opencode

In `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "globnotes": {
      "type": "remote",
      "url": "http://globnotes.home/_/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:GLOBNOTES_TOKEN}"
      }
    }
  }
}
```

`"oauth": false` stops opencode from starting an OAuth sign-in when the token has expired
(globnotes has no OAuth); it reports the failed connection instead.

### Claude Desktop and other stdio-only clients

Clients that only launch local (stdio) servers can reach the endpoint through a standard
stdio↔HTTP bridge such as [`mcp-remote`](https://github.com/geelen/mcp-remote). Its
`--allow-http` flag permits a plain-HTTP server on your network. For Claude Desktop, in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "globnotes": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://globnotes.home/_/mcp",
        "--transport",
        "http-only",
        "--allow-http",
        "--header",
        "Authorization:${GLOBNOTES_AUTH}"
      ],
      "env": {
        "GLOBNOTES_AUTH": "Bearer <token>"
      }
    }
  }
}
```

The header value comes from `env` because some clients don't escape spaces in `args`.

## Tools

Every tool returns structured content (described by its output schema) and one text block:
a one-line summary, then the whole structured result as JSON on the second line. A client
that reads only text (or passes only text to its model) gets the same fields as one that
reads the structured content. Failures are tool results the agent can read, saying what went wrong and what
to do next, e.g. "Note 'x' not found. Use globnotes_search_notes or globnotes_list_folder
to find the right path". A failure on the server's side (a folder where a note should be,
a file globnotes may not read, any unexpected error) gets a short fixed message; its
details, which can include paths on the server, go only to the server log.

| # | Tool | Input | Output | Annotations |
|---|---|---|---|---|
| 1 | `globnotes_search_notes` | `query`; `folder`; `include_subfolders` (default `true`); `sort` (`score`, `path`, `lastModified`; default `score`); `order` (`asc`, `desc`; default `desc`); `limit` (1–100, default 20); `offset` (default 0) | `{total, count, offset, has_more, next_offset?, results: [{path, title, last_modified, score?, snippet, matched_tags, truncated?, omitted_tags?}]}` | read-only, idempotent |
| 2 | `globnotes_get_note` | `path`; `offset` (characters, default 0); `length` (characters, optional) | `{path, title, content, last_modified, offset, total_length, has_more, next_offset?, truncated?}` | read-only, idempotent |
| 3 | `globnotes_list_folder` | `path` (default: the vault root); `limit` (1–500, default 100); `offset` (default 0) | `{path, total, count, offset, has_more, next_offset?, folders: [{name, path}], notes: [{path, title, truncated?}]}`: subfolders first, then notes | read-only, idempotent |
| 4 | `globnotes_list_tags` | `limit` (1–2000, default 500); `offset` (default 0) | `{total, count, offset, has_more, next_offset?, tags, truncated?}` | read-only, idempotent |
| 5 | `globnotes_create_note` | `path`, `content` | `{path, title, content, last_modified}` | not destructive |
| 6 | `globnotes_update_note` | `path`; `content`; `new_path`; `expected_last_modified`; `file_refs` (`none`, `move`, `relink`; default `none`) | the note, plus `moved_files: [{old_path, new_path}]` | destructive |
| 7 | `globnotes_delete_note` | `path`, `expected_last_modified` | `{deleted}` | destructive |

No tool reaches anything outside the vault (`openWorldHint: false`).

Notes:
- **Paths** are relative to the vault root, without `.md`, with `/` between folders:
  `Recipes/Lentil dal`. They follow the same rules as in the web app.
- **Times** (`last_modified`) are ISO 8601 in UTC, e.g. `2026-11-02T14:05:09.120Z`.
- **Search syntax** is the web app's: words (all must match), `"exact phrase"`, `#tag`,
  `prefix*`, and `*` alone for every note. `*` with `sort: "lastModified"` lists the
  latest notes. A query with an unpaired `"` is refused with a tool error that says so.
- **Snippets** are plain text with the matches marked `«like this»`. A match only in the
  path shows the marked path. The snippet is empty when no content or path text matched: a
  tag-only match, or `query: "*"`.
- **Pagination.** Search, folder listings and the tag list come in pages. A page has
  `count` entries. When `has_more` is `true`, call again with `offset: next_offset`.
  `total` is exact: the size of the whole list (a folder, the tags, or every result of the
  search). The index and storage cut each page, so a page far into a long list costs about
  as much as the first. A page holds fewer than `limit` entries when the response would
  exceed 25,000 characters, counting the text block and the structured content together;
  `next_offset` then continues after the last one returned.
- **Shortened results.** A snippet is a window of words, and titles and tags have no length
  limit, so a single result can be over 25,000 characters on its own (one very long word, a
  huge heading, or many tags). Such a result is still returned, shortened by one rule:
  `snippet`, `title` and each tag in `matched_tags` are cut to one common maximum length,
  the largest that fits, so the longest field is shortened first and short ones stay
  whole. If that would take the fields below 100 characters (only many tags can cause
  that), trailing tags are left out instead and counted in `omitted_tags`. Every shortened
  text ends in ` ... [truncated]`, and the result's `truncated` field lists the shortened
  fields (it is absent otherwise). `path` is never shortened, so `globnotes_get_note` with
  it always reads the whole note (in parts, if it is large). The same applies to the listings: a note whose title
  alone is over the limit is listed with its title shortened (`truncated: ["title"]`), and
  a tag alone over the limit is returned shortened, on a page of its own with
  `truncated: true`.
- **Large notes come in parts.** `globnotes_get_note` returns a whole note when it fits in
  one response (25,000 characters, counted as above). A larger note comes in parts: the
  first call returns the beginning with `has_more: true`, and its summary line says the
  content is partial. Call again with `offset: next_offset` until `has_more` is `false`.
  `offset` and `length` read a chosen range; `length` is a maximum, and a part is never
  larger than the response limit. Characters are Unicode code points, so a part never
  splits one, and the parts join back into the note. `total_length` is the whole note's
  length. A display title too long to leave half of the response for content is shortened
  and marked (`truncated: ["title"]`); the content never is.
- **Replacing a note.** `globnotes_update_note` always replaces the whole note with the
  `content` it gets; it never takes a part. Read every part of a large note before
  replacing it.
- **Renames by heading.** As in the web app, a content update that changes the note's
  first `# Heading` renames the note to match, unless the note has a front-matter
  `title`. The result's `path` is the note's final path.
- **`file_refs`** only matters when a note moves: `move` moves the attachments the note
  links with relative paths, `relink` rewrites those links to keep pointing at them, and
  `none` leaves both alone.

## Read-only mode

MCP sends every call as `POST`, so globnotes doesn't use the HTTP method to decide what is
a write. With `GLOBNOTES_AUTH_TYPE=read_only`:

- `tools/list` lists only the four read tools;
- a client that calls a write tool anyway gets the tool error "This globnotes instance is
  read-only: notes can be searched and read, but not created, changed or deleted.", and
  nothing is written.

## Writes and plugins

Every write tool goes through the same guarded write path as the web app's saves. Plugin
`pre-create`, `pre-save`, `pre-rename` and `pre-delete` guards run and can cancel the
operation. The agent then reads the plugin's reason, e.g. "The plugin 'guard' cancelled
this save: no blocked content Nothing was written." Plugins see MCP writes as API writes
(`origin: "api"`), the vault hub records them as `globnotes` writes ([hub](hub.md)), and the
search index is updated before the tool answers.

Search and tag listing read the index, which follows the hub's change log. A note changed
by an outside program appears in search results once the hub has noticed the change: its
filesystem watcher reacts after a 300 ms pause in changes, and a periodic full scan (every
`GLOBNOTES_HUB_SCAN_INTERVAL` seconds, default 60) catches anything the watcher misses.
`globnotes_get_note` and `globnotes_list_folder` read the vault folder directly (the
folder listing takes display titles from the index).

## The stale-write guard

`globnotes_update_note` and `globnotes_delete_note` take an optional
`expected_last_modified`: the `last_modified` the agent read with `globnotes_get_note` (or
from a search result). If the note has changed since (for example, someone saved it in the
browser in the meantime), the tool writes nothing and asks the agent to re-read the note.
Agents should always pass it.

The check is best effort. globnotes compares the note on disk just before the write and
has no merge of concurrent edits yet, so a save that lands between the check and the write
can still be overwritten. A note changed within the same millisecond also isn't detected.
The vault hub's versions aren't used for this check yet; base-aware saves (planned as M2)
will strengthen it.

## Security

- **Same access as the token.** An MCP client can do exactly what the REST API allows with
  the same credentials. In `none` mode, that means anyone on the network, including any
  agent, can read and change every note ([Home network deployment](../README.md#home-network-deployment)).
- **Plain HTTP exposes the token.** Over plain HTTP, the bearer token travels unencrypted,
  as the web app's login does. Anyone who can watch the network traffic can copy it and use
  it until it expires. Use plain HTTP only on networks you trust, or put globnotes behind
  HTTPS.
- **Browser pages.** A request whose `Origin` header doesn't match its `Host` is refused
  with `403`. That stops ordinary cross-site requests: a page on another site can't use the
  endpoint through your browser. It does **not** stop DNS rebinding, where a hostile page
  makes its own name resolve to your globnotes server, so that its `Origin` and `Host`
  match. The REST API has the same limit. A rebinding page never receives your login token,
  so on a LAN, use `password` or `totp` authentication rather than `none`. MCP clients that
  send no `Origin` (command-line agents, desktop apps) are unaffected.
- **Tokens in configuration files.** Client configurations hold the token in plain text.
  Prefer environment variables where the client supports them, and treat the file like a
  password.
- **Turning it off.** `GLOBNOTES_MCP_ENABLED=false` removes the endpoint without affecting
  the web app or the REST API.
