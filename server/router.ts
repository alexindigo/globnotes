// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Bare-minimum HTTP router for the globnotes host.
 *
 * Framework-free by design (see plans/plugin-system): path params,
 * greedy rest params, middleware chain, and a FastAPI-compatible error
 * shape (`{"detail": ...}`) so the existing client needs no changes.
 *
 * Pattern syntax:
 *   /_/api/notes/:title   — single-segment param
 *   /_/api/files/:path*   — greedy rest param (matches remaining segments)
 */

import { HttpError } from "./http_error.ts";

export interface RequestCtx {
  req: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  /** URL pathname with any configured path prefix already stripped. */
  path: string;
}

export type HandlerResult =
  | Response
  | string
  | number
  | boolean
  | object
  | null
  | undefined;
export type Handler = (
  ctx: RequestCtx,
) => HandlerResult | Promise<HandlerResult>;
export type Middleware = (
  ctx: RequestCtx,
  next: () => Promise<Response>,
) => HandlerResult | Promise<HandlerResult>;

type Segment =
  | { kind: "lit"; value: string }
  | { kind: "param"; name: string }
  | { kind: "rest"; name: string };

interface Route {
  method: string;
  pattern: string;
  segments: Segment[];
  /** Higher wins: literals > params > rest, then longer patterns. */
  specificity: number;
  handler: Handler;
}

function parsePattern(pattern: string): Segment[] {
  return pattern.split("/").filter(Boolean).map((raw) => {
    if (raw.startsWith(":")) {
      if (raw.endsWith("*")) {
        return { kind: "rest", name: raw.slice(1, -1) };
      }
      return { kind: "param", name: raw.slice(1) };
    }
    return { kind: "lit", value: raw };
  });
}

function specificityOf(segments: Segment[]): number {
  let score = 0;
  for (const seg of segments) {
    if (seg.kind === "lit") score += 4;
    else if (seg.kind === "param") score += 2;
    else score += 1;
  }
  return score * 1000 + segments.length;
}

/** Normalize any handler result to a Response, FastAPI-style:
 * Response passes through untouched; everything else is JSON-encoded. */
export function toResponse(result: HandlerResult): Response {
  if (result instanceof Response) return result;
  return new Response(JSON.stringify(result ?? null), {
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return new Response(JSON.stringify({ detail: err.detail }), {
      status: err.status,
      headers: { "content-type": "application/json" },
    });
  }
  console.error(err);
  return new Response(JSON.stringify({ detail: "Internal Server Error" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

export class Router {
  private routes: Route[] = [];
  private middleware: Middleware[] = [];
  private prefix: string;

  constructor(opts: { prefix?: string } = {}) {
    this.prefix = opts.prefix ?? "";
  }

  use(mw: Middleware): void {
    this.middleware.push(mw);
  }

  add(method: string, pattern: string, handler: Handler): void {
    const segments = parsePattern(pattern);
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      segments,
      specificity: specificityOf(segments),
      handler,
    });
    this.routes.sort((a, b) => b.specificity - a.specificity);
  }

  private match(
    method: string,
    path: string,
  ): { route: Route; params: Record<string, string> } | null {
    const pathSegs = path.split("/").filter(Boolean).map(decodeURIComponent);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, pathSegs);
      if (params === null) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      return { route, params };
    }
    if (pathMatched) {
      throw new HttpError(405, "Method Not Allowed");
    }
    return null;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let path = url.pathname;
    if (this.prefix) {
      if (!path.startsWith(this.prefix)) {
        return errorResponse(new HttpError(404, "Not Found"));
      }
      path = path.slice(this.prefix.length) || "/";
    }
    const ctx: RequestCtx = { req, params: {}, query: url.searchParams, path };
    try {
      const found = this.match(req.method.toUpperCase(), path);
      const dispatch = (): Promise<Response> => {
        if (!found) throw new HttpError(404, "Not Found");
        ctx.params = found.params;
        return Promise.resolve(found.route.handler(ctx)).then(toResponse);
      };
      let chain: () => Promise<Response> = dispatch;
      for (let i = this.middleware.length - 1; i >= 0; i--) {
        const mw = this.middleware[i];
        const next = chain;
        chain = () => Promise.resolve(mw(ctx, next)).then(toResponse);
      }
      return await chain();
    } catch (err) {
      return errorResponse(err);
    }
  }
}

function matchSegments(
  pattern: Segment[],
  pathSegs: string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  let i = 0;
  for (; i < pattern.length; i++) {
    const seg = pattern[i];
    if (seg.kind === "rest") {
      params[seg.name] = pathSegs.slice(i).join("/");
      return params;
    }
    if (i >= pathSegs.length) return null;
    if (seg.kind === "lit" && seg.value !== pathSegs[i]) return null;
    if (seg.kind === "param") params[seg.name] = pathSegs[i];
  }
  return i === pathSegs.length ? params : null;
}
