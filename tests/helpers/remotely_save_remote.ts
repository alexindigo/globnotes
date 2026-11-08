// SPDX-License-Identifier: LGPL-3.0-only
// Deterministic protocol peer, not a replacement for the real-service matrix.
export function remotelySaveRemote(
  backend: "s3" | "webdav",
  { s3Prefix = "prefix" }: { s3Prefix?: string } = {},
) {
  const objects = new Map<
    string,
    {
      bytes: Uint8Array;
      etag: string;
      modified: number;
      created?: string;
      mtime?: string;
    }
  >();
  const folders = new Set<string>([""]);
  const requests: {
    method: string;
    key: string;
    headers: Headers;
    bytes: Uint8Array;
  }[] = [];
  let counter = 0, tick = Math.floor(Date.now() / 1000) * 1000;
  let weak: boolean | "missing" = false;
  let tickStep = 1000;
  let encoding: "url" | "raw" = "url";
  let fault:
    | ((request: Request, key: string) => Response | undefined)
    | undefined;
  const escaped = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
      ">",
      "&gt;",
    ).replaceAll('"', "&quot;");
  const etag = (value: string) =>
    weak === "missing" ? "" : weak ? "W/" + value : value;
  const set = (key: string, bytes: Uint8Array | string) => {
    objects.set(key, {
      bytes: typeof bytes === "string"
        ? new TextEncoder().encode(bytes)
        : bytes.slice(),
      etag: `"revision-${++counter}"`,
      modified: tick - 1000,
    });
    const pieces = key.split("/");
    for (let i = 1; i < pieces.length; i++) {
      folders.add(pieces.slice(0, i).join("/") + "/");
    }
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      tick += tickStep;
      const url = new URL(request.url),
        root = backend === "s3"
          ? "/bucket/" + s3Prefix.split("/").map(encodeURIComponent).join("/") +
            "/"
          : "/dav/base/";
      const key = url.pathname.startsWith(root)
        ? decodeURIComponent(url.pathname.slice(root.length))
        : "";
      const bytes = new Uint8Array(await request.arrayBuffer());
      requests.push({
        method: request.method,
        key,
        headers: new Headers(request.headers),
        bytes,
      });
      const extra = fault?.(request, key);
      if (extra) return extra;
      const headers = new Headers({ date: new Date(tick).toUTCString() });
      const xml = (body: string) =>
        new Response(body, {
          status: backend === "webdav" ? 207 : 200,
          headers,
        });
      if (backend === "s3" && url.searchParams.has("list-type")) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const start = Number(url.searchParams.get("continuation-token") ?? 0);
        const rows = [...objects].sort(([a], [b]) => a.localeCompare(b));
        const page = rows.slice(start, start + 2);
        return xml(
          `<s:ListBucketResult xmlns:s="urn:s3">${
            encoding === "url" ? "<s:EncodingType>url</s:EncodingType>" : ""
          }<s:IsTruncated>${start + 2 < rows.length}</s:IsTruncated>${
            page.map(([key, object]) =>
              `<s:Contents><s:Key>${
                encoding === "url"
                  ? encodeURIComponent(prefix + key).replaceAll("%20", "+")
                  : escaped(prefix + key)
              }</s:Key><s:Size>${object.bytes.length}</s:Size><s:ETag>${
                escaped(object.etag)
              }</s:ETag><s:LastModified>${
                new Date(object.modified).toISOString()
              }</s:LastModified></s:Contents>`
            ).join("")
          }${
            start + 2 < rows.length
              ? `<s:NextContinuationToken>${
                start + 2
              }</s:NextContinuationToken>`
              : ""
          }</s:ListBucketResult>`,
        );
      }
      if (backend === "webdav" && request.method === "PROPFIND") {
        if (!folders.has(key)) {
          return new Response(null, {
            status: 404,
            headers,
          });
        }
        const rows: { key: string; folder: boolean }[] = [{
          key,
          folder: true,
        }];
        for (const folder of folders) {
          if (
            folder !== key && folder.startsWith(key) &&
            !folder.slice(key.length).replace(/\/$/, "").includes("/")
          ) rows.push({ key: folder, folder: true });
        }
        for (const name of objects.keys()) {
          if (
            name.startsWith(key) && !name.slice(key.length).includes("/")
          ) rows.push({ key: name, folder: false });
        }
        return xml(`<d:multistatus xmlns:d="DAV:">${
          rows.map((row) => {
            const object = objects.get(row.key);
            return `<d:response><d:href>${
              root + row.key.split("/").map(encodeURIComponent).join("/")
            }</d:href><d:propstat><d:prop><d:resourcetype>${
              row.folder ? "<d:collection/>" : ""
            }</d:resourcetype>${
              object
                ? `<d:getcontentlength>${object.bytes.length}</d:getcontentlength><d:getetag>${
                  escaped(etag(object.etag))
                }</d:getetag><d:getlastmodified>${
                  new Date(object.modified).toUTCString()
                }</d:getlastmodified>`
                : ""
            }</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
          }).join("")
        }</d:multistatus>`);
      }
      if (request.method === "MKCOL") {
        const exists = folders.has(key);
        folders.add(key);
        return new Response(null, { status: exists ? 405 : 201, headers });
      }
      const object = objects.get(key);
      if (["GET", "HEAD"].includes(request.method)) {
        if (!object) return new Response(null, { status: 404, headers });
        if (etag(object.etag)) headers.set("etag", etag(object.etag));
        headers.set("last-modified", new Date(object.modified).toUTCString());
        headers.set("content-length", String(object.bytes.length));
        if (object.created) headers.set("x-amz-meta-ctime", object.created);
        if (object.mtime) headers.set("x-amz-meta-mtime", object.mtime);
        return new Response(
          request.method === "HEAD" ? null : object.bytes.slice(),
          { headers },
        );
      }
      if (
        request.headers.get("if-match") &&
          request.headers.get("if-match") !== object?.etag ||
        request.headers.get("if-none-match") === "*" && object
      ) return new Response(null, { status: 412, headers });
      if (request.method === "PUT") {
        set(key, bytes);
        const stored = objects.get(key)!;
        stored.modified = tick;
        stored.created = request.headers.get("x-amz-meta-ctime") ?? undefined;
        stored.mtime = request.headers.get("x-amz-meta-mtime") ?? undefined;
        if (etag(stored.etag)) headers.set("etag", etag(stored.etag));
        return new Response(null, { status: 201, headers });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204, headers });
      }
      return new Response(null, { status: 405, headers });
    },
  );
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    objects,
    folders,
    requests,
    set,
    fault(value: typeof fault) {
      fault = value;
    },
    weak(value: boolean | "missing") {
      weak = value;
    },
    clock(value: number, step = 1000) {
      tick = value;
      tickStep = step;
    },
    encoding(value: "url" | "raw") {
      encoding = value;
    },
    async close() {
      await server.shutdown();
    },
  };
}
