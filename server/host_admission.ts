// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Host admission (GLOBNOTES_ALLOWED_HOSTS): the one check, at the server's
 * entry point before any routing, that a request names this server. When
 * the operator lists the host names (or IP addresses) the deployment is
 * reached by, a request whose Host header is not one of them is answered
 * 421 Misdirected Request, on every route: web app, REST API, vault files
 * and MCP alike. That is what stops DNS rebinding: a hostile page that
 * makes its own name resolve to this server still sends its own name as
 * Host. Unset, every request is admitted (the behaviour without the
 * setting). Plain HTTP and local names work as before (Axiom 1): this
 * compares names, it needs no certificate.
 */

/** One accepted authority: a host and, optionally, the only port it may
 * come with. */
export interface AllowedHost {
  /** Lowercase; an IPv6 literal in brackets, e.g. "[::1]". */
  host: string;
  /** null = any port. */
  port: string | null;
}

export class AllowedHostsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowedHostsError";
  }
}

const NAME = /^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/;

/** An authority ("host", "host:port", "[v6]", "[v6]:port" or a bare IPv6
 * address), normalized; null when it is not one. */
export function parseAuthority(text: string): AllowedHost | null {
  let value = text.trim().toLowerCase();
  if (value === "") return null;
  let host: string;
  let port: string | null = null;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return null;
    host = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return null;
      port = rest.slice(1);
    }
  } else if ((value.match(/:/g) ?? []).length > 1) {
    host = `[${value}]`; // a bare IPv6 address has no port
  } else {
    const colon = value.indexOf(":");
    if (colon >= 0) {
      port = value.slice(colon + 1);
      value = value.slice(0, colon);
    }
    host = value.endsWith(".") ? value.slice(0, -1) : value;
  }
  if (!(IPV6.test(host) || NAME.test(host))) return null;
  if (port !== null) {
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      return null;
    }
    port = String(Number(port));
  }
  return { host, port };
}

/** GLOBNOTES_ALLOWED_HOSTS: comma-separated authorities; "" (unset) = no
 * admission check. Throws AllowedHostsError naming a bad entry. */
export function parseAllowedHosts(value: string): AllowedHost[] | null {
  const entries = value.split(",").map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return null;
  return entries.map((entry) => {
    const parsed = parseAuthority(entry);
    if (!parsed) {
      throw new AllowedHostsError(
        `'${entry}' is not a host name or IP address with an optional port`,
      );
    }
    return parsed;
  });
}

/** Whether a Host header value names one of the allowed authorities. */
export function hostAllowed(
  allowed: readonly AllowedHost[],
  host: string | null,
): boolean {
  const requested = host === null ? null : parseAuthority(host);
  if (!requested) return false;
  return allowed.some((entry) =>
    entry.host === requested.host &&
    (entry.port === null || entry.port === requested.port)
  );
}

/** The startup warning for an open deployment that answers any host name:
 * with no authentication, a hostile web page can use DNS rebinding to reach
 * this server through the visitor's browser. null when not applicable. */
export function rebindingWarning(
  openAccess: boolean,
  allowed: readonly AllowedHost[] | null,
): string | null {
  if (!openAccess || allowed !== null) return null;
  return "No authentication and GLOBNOTES_ALLOWED_HOSTS is unset: a web " +
    "page on another site can use DNS rebinding (making its own name " +
    "resolve to this server) to read and change notes through the browser " +
    "of anyone on this network. Set GLOBNOTES_ALLOWED_HOSTS to the names " +
    "this server is reached by, e.g. 'globnotes.home', so it answers no " +
    "other host.";
}

/** The admission check for one request: null to serve it, or the 421
 * answer. `allowed` null (the setting is unset) admits every request. */
export function admitHost(
  allowed: readonly AllowedHost[] | null,
  request: Request,
): Response | null {
  if (allowed === null) return null;
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (hostAllowed(allowed, host)) return null;
  return Response.json({
    detail: `Misdirected Request: this globnotes server does not answer ` +
      `for the host '${host}'. Use one of the names in its ` +
      "GLOBNOTES_ALLOWED_HOSTS setting.",
  }, { status: 421 });
}
