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
| 2 | Transport | Streamable HTTP, stateless: every JSON-RPC message is one `POST`, answered with JSON. No sessions, no server-sent event streams |
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
      "headers": {
        "Authorization": "Bearer {env:GLOBNOTES_TOKEN}"
      }
    }
  }
}
```

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

Every tool returns structured content (described by its output schema) plus a short text
rendering. Failures are tool results the agent can read, saying what went wrong and what
to do next, e.g. "Note 'x' not found. Use globnotes_search_notes or globnotes_list_folder
to find the right path".

| # | Tool | Input | Output | Annotations |
|---|---|---|---|---|
| 1 | `globnotes_search_notes` | `query`; `folder`; `include_subfolders` (default `true`); `sort` (`score`, `path`, `lastModified`; default `score`); `order` (`asc`, `desc`; default `desc`); `limit` (1–100, default 20); `offset` (default 0) | `{total, count, offset, has_more, next_offset?, results: [{path, title, last_modified, score?, snippet, matched_tags}]}` | read-only, idempotent |
| 2 | `globnotes_get_note` | `path` | `{path, title, content, last_modified}` | read-only, idempotent |
| 3 | `globnotes_list_folder` | `path` (default: the vault root) | `{path, folders: [{name, path}], notes: [{path, title}]}` | read-only, idempotent |
| 4 | `globnotes_list_tags` | — | `{tags}` | read-only, idempotent |
| 5 | `globnotes_create_note` | `path`, `content` | the note, as 2 | not destructive |
| 6 | `globnotes_update_note` | `path`; `content`; `new_path`; `expected_last_modified`; `file_refs` (`none`, `move`, `relink`; default `none`) | the note, plus `moved_files: [{old_path, new_path}]` | destructive |
| 7 | `globnotes_delete_note` | `path`, `expected_last_modified` | `{deleted}` | destructive |

No tool reaches anything outside the vault (`openWorldHint: false`).

Notes:
- **Paths** are relative to the vault root, without `.md`, with `/` between folders:
  `Recipes/Lentil dal`. They follow the same rules as in the web app.
- **Times** (`last_modified`) are ISO 8601 in UTC, e.g. `2026-11-02T14:05:09.120Z`.
- **Search syntax** is the web app's: words (all must match), `"exact phrase"`, `#tag`,
  `prefix*`, and `*` alone for every note. `*` with `sort: "lastModified"` lists the
  latest notes.
- **Snippets** are plain text with the matches marked `«like this»`. They are empty when
  only the path or a tag matched. A snippet is a window of words, so one very long word can
  make it long; when a single result alone would exceed 25,000 characters, its snippet is
  shortened and ends in ` ... [snippet truncated]`.
- **Pagination.** A result page has `count` results. When `has_more` is `true`, call again
  with `offset: next_offset`. `total` counts the matches found while filling the page (at
  most `offset + count + 1`); it is not the number of all matching notes. A page holds fewer
  than `limit` results when they would exceed 25,000 characters; `next_offset` then
  continues after the last one returned.
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
(`origin: "api"`), and the search index is updated as for any other save.

## The stale-write guard

`globnotes_update_note` and `globnotes_delete_note` take an optional
`expected_last_modified`: the `last_modified` the agent read with `globnotes_get_note` (or
from a search result). If the note has changed since (for example, someone saved it in the
browser in the meantime), the tool writes nothing and asks the agent to re-read the note.
Agents should always pass it.

The check is best effort. globnotes compares the time just before the write, and v2 has
no merge of concurrent edits, so a save that lands between the check and the write can
still be overwritten. A note changed within the same millisecond also isn't detected.

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
