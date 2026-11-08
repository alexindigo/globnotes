// SPDX-License-Identifier: LGPL-3.0-only
import { readConfiguration } from "./config.js";
import { createCodec } from "./crypto.js";
import { createHttp } from "./http.js";
import { createMapping } from "./mapping.js";
import { createS3 } from "./s3.js";
import { createWebdav } from "./webdav.js";

export function activate(ctx) {
  let provider;
  const http = createHttp(ctx.driver.StorageError);
  const storage = ctx.driver.storage({
    conditions: { create: false, update: false, delete: false },
    async identity() {
      const configuration = await readConfiguration(ctx);
      const codec = await createCodec(
        configuration.encryption,
        configuration.password,
        () =>
          http.error(
            "unauthorized",
            "Remote encryption mode or key does not match",
          ),
      );
      const backend = configuration.backend === "s3"
        ? createS3(configuration, http)
        : createWebdav(configuration, http);
      provider = createMapping(configuration, backend, codec, http, ctx);
      return provider.identity();
    },
    list: (cursor) => provider.list(cursor),
    get: (key) => provider.get(key),
    put: (key, bytes, condition) => provider.put(key, bytes, condition),
    delete: (key, condition) => provider.delete(key, condition),
    scope: () => provider.scope(),
    exclude: (path) => provider.exclude(path),
    name: (path) => provider.name(path),
  }, { name: "Remotely Save" });
  const close = () => {
    provider?.close();
    provider = undefined;
  };
  ctx.register(close);
  ctx.driver.serve({
    ...storage,
    close() {
      storage.close();
      close();
    },
  });
}
