# MCP server

globnotes serves the [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) so AI agents (Claude Code, Codex CLI, Gemini CLI, opencode, Cursor, VS Code, Zed,
Claude Desktop and other MCP clients) can search your vault, read notes, browse folders and tags, and create, edit,
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
| 7 | Rate limit | `GLOBNOTES_MCP_RATE_LIMIT` tool calls per minute per client, default `600`; `0` turns it off. Over the limit, a request with tool calls gets `429 Too Many Requests` with `Retry-After` (seconds). The client is the logged-in account when authentication is on (all its tokens share one budget), otherwise the connection's address (forwarded headers are ignored). Other requests, such as `tools/list`, don't count |

It's built on the official TypeScript SDK (`@modelcontextprotocol/server`).

The server sends short instructions with the handshake (`initialize`, or `server/discover`
in 2026-07-28), for clients that pass them to their model: search or browse, then read,
then edit with `expected_last_modified`; follow `next_offset` for more; heading changes
rename notes; a read-only instance offers only the read tools.

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
prefix. They read the token from `GLOBNOTES_TOKEN` ([Getting a token](#getting-a-token)). In
`none` and `read_only` mode, leave out the `Authorization` header (or the token setting).

Each setup follows the client's official documentation, linked below. The command-line
clients were checked against a running globnotes server in a container, with the
configuration exactly as shown (only the server's address changed): each connected and
listed the seven tools. The editor apps were not run; their setup is taken from their
documentation only.

| # | Client | Version checked | Result |
|---|---|---|---|
| 1 | Claude Code | 2.1.318 | connected, 7 tools (protocol 2026-07-28) |
| 2 | Codex CLI | 0.166.0 | connected, 7 tools |
| 3 | Gemini CLI | 0.66.0 | connected, 7 tools (in a trusted folder) |
| 4 | opencode | 1.19.5 | connected, 7 tools |
| 5 | `mcp-remote` (Claude Desktop and other stdio clients) | 0.16.0 | connected, 7 tools, a note read |
| 6 | Cursor | - | from the official docs, not tested |
| 7 | VS Code | - | from the official docs, not tested |
| 8 | Zed | - | from the official docs, not tested |

When the token expires, clients that keep the token itself in their configuration (Claude
Code, Gemini CLI, Zed and the `mcp-remote` example) need it replaced there; the others read
`GLOBNOTES_TOKEN` again when they connect.

### Claude Code

[Claude Code MCP docs](https://code.claude.com/docs/en/mcp):

```sh
claude mcp add --transport http globnotes http://globnotes.home/_/mcp \
  --header "Authorization: Bearer $GLOBNOTES_TOKEN"
claude mcp list
```

`claude mcp list` shows `Connected`. Add `--scope user` to use the server in every project.

### Codex CLI

[Codex MCP docs](https://developers.openai.com/codex/mcp):

```sh
codex mcp add globnotes --url http://globnotes.home/_/mcp \
  --bearer-token-env-var GLOBNOTES_TOKEN
```

That writes this to `~/.codex/config.toml`, which you can also edit by hand:

```toml
[mcp_servers.globnotes]
url = "http://globnotes.home/_/mcp"
bearer_token_env_var = "GLOBNOTES_TOKEN"
```

Codex reads the token from `GLOBNOTES_TOKEN` when it starts, so set it in the environment
Codex runs in. `codex mcp list` shows the configuration; the connection is made when a
session starts.

### Gemini CLI

[Gemini CLI MCP docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md):

```sh
gemini mcp add --transport http --scope user \
  --header "Authorization: Bearer $GLOBNOTES_TOKEN" globnotes http://globnotes.home/_/mcp
gemini mcp list
```

Gemini CLI connects to MCP servers only in folders you trust; elsewhere `gemini mcp list`
shows the server as `Disabled`.

### opencode

[opencode MCP docs](https://opencode.ai/docs/mcp-servers/).

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

The header value comes from `env` because some clients don't escape spaces in `args`
([`mcp-remote` README](https://github.com/geelen/mcp-remote)). `npx` fetches `mcp-remote`
from the npm registry the first time.

### Cursor

From the [Cursor MCP docs](https://cursor.com/docs/mcp), not tested. In `~/.cursor/mcp.json`
(or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "globnotes": {
      "url": "http://globnotes.home/_/mcp",
      "headers": {
        "Authorization": "Bearer ${env:GLOBNOTES_TOKEN}"
      }
    }
  }
}
```

### VS Code

From the [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
not tested. In `.vscode/mcp.json` (or the user `mcp.json`, command **MCP: Open User
Configuration**); VS Code asks for the token the first time and stores it:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "globnotes-token",
      "description": "globnotes token",
      "password": true
    }
  ],
  "servers": {
    "globnotes": {
      "type": "http",
      "url": "http://globnotes.home/_/mcp",
      "headers": {
        "Authorization": "Bearer ${input:globnotes-token}"
      }
    }
  }
}
```

### Zed

From the [Zed MCP docs](https://zed.dev/docs/ai/mcp), not tested. In Zed's settings file:

```json
{
  "context_servers": {
    "globnotes": {
      "url": "http://globnotes.home/_/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Zed's docs say it starts an MCP OAuth sign-in for a remote server without an
`Authorization` header. globnotes has no OAuth.

### Cloud AI apps

Hosted AI apps such as ChatGPT, Claude on the web or Lovable connect to MCP servers from
their own cloud, not from your computer. They can't reach a globnotes server on your home
network (`globnotes.home` is a name only your network knows), so they can't be used with
it. Use one of the local clients above.

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
  endpoint through your browser. MCP clients that send no `Origin` (command-line agents,
  desktop apps) are unaffected.
- **DNS rebinding.** The `Origin` check alone does not stop DNS rebinding, where a hostile
  page makes its own name resolve to your globnotes server, so that its `Origin` and `Host`
  match. Set `GLOBNOTES_ALLOWED_HOSTS` to the names your server is reached by, e.g.
  `GLOBNOTES_ALLOWED_HOSTS=globnotes.home,192.168.1.20`: every route (the web app, the REST
  API, vault files and MCP) then answers any other `Host` with `421 Misdirected Request`,
  and a rebinding page, which sends its own name, gets nothing. Entries are host names or
  IP addresses, comma-separated; an entry without a port accepts any port, and one with a
  port (`nas.home:8080`, `[::1]:8080`) only that one. Entries and `Host` headers are compared
  the way a browser writes them: names ignore case and a trailing dot, and every spelling of
  an IP address is the same entry (`[0:0:0:0:0:0:0:1]` is `[::1]`). Unset, every host is answered. With
  `none` authentication and the setting unset, globnotes logs a warning at startup. A
  rebinding page never receives your login token, so `password` or `totp` authentication
  also protects the notes.
- **Tokens in configuration files.** Client configurations hold the token in plain text.
  Prefer environment variables where the client supports them, and treat the file like a
  password.
- **Turning it off.** `GLOBNOTES_MCP_ENABLED=false` removes the endpoint without affecting
  the web app or the REST API.
