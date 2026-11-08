// SPDX-License-Identifier: LGPL-3.0-only
// Runs only in the dev container. Synthetic credentials for a private test network.
import { createHash } from "node:crypto";
const root = "/artifacts/services";
for (
  const path of [
    "tmp",
    "s3/logs",
    "dav/run",
    "dav/anonymous",
    "dav/basic",
    "dav/digest",
  ]
) await Deno.mkdir(`${root}/${path}`, { recursive: true });
await Deno.copyFile(
  "tests/interop/webdav/httpd.conf",
  `${root}/httpd.conf`,
);
await Deno.writeTextFile(
  `${root}/s3.json`,
  JSON.stringify({
    identities: [{
      name: "interop",
      credentials: [{
        accessKey: "interop-access",
        secretKey: "interop-secret",
      }],
      actions: ["Admin", "Read", "Write", "List", "Tagging"],
    }],
  }),
);
await Deno.writeTextFile(
  `${root}/basic.passwd`,
  `interop:{SHA}${
    createHash("sha1").update("interop-password").digest("base64")
  }\n`,
);
await Deno.writeTextFile(
  `${root}/digest.passwd`,
  `interop:interop:${
    createHash("md5").update("interop:interop:interop-password").digest("hex")
  }\n`,
);
console.log("Prepared disk-backed real-service fixtures");
