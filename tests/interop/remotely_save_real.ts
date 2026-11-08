// SPDX-License-Identifier: LGPL-3.0-only
// Deliberate targeted runner, not an optional/ignored deno test in the CI suite.
import { assert, assertEquals } from "@std/assert";
import { walkSync } from "@std/fs";
import { remotelySaveServerFixture } from "../helpers/remotely_save_fixture.ts";
import { done, pending, waitUntil } from "../helpers/wait.ts";
import { referenceCodecs, referenceStore } from "./remotely_save_reference.mjs";
import { referencePlanner } from "./remotely_save_planner.mjs";
import { nativeNameBoundaries } from "./remotely_save_boundaries.ts";
import { incrementalTraffic } from "./remotely_save_traffic.ts";

const s3Endpoint = Deno.env.get("RS_S3_ENDPOINT");
const davEndpoint = Deno.env.get("RS_DAV_ENDPOINT");
assert(s3Endpoint && davEndpoint, "Use the feature-owned interop wrapper");
const utf8 = new TextEncoder(), text = new TextDecoder();
const password = "real-service-only-passphrase";
const reports: unknown[] = [];
const selectedCase = Deno.args.find((arg) => arg.startsWith("--case="))?.slice(
  7,
);
let completed = 0;
await waitUntil(async () => {
  try {
    const s3 = referenceStore("s3", s3Endpoint, "");
    await s3.initialize();
    const dav = await fetch(`${davEndpoint}/anonymous/`, {
      method: "PROPFIND",
      headers: { depth: "0" },
      signal: AbortSignal.timeout(2000),
    });
    await dav.arrayBuffer();
    return dav.status === 207 ? done() : pending(dav.status);
  } catch (error) {
    return pending(String(error));
  }
}, { label: "real S3 and Apache DAV readiness" });
const codecFactory = await referenceCodecs();
const planReference = await referencePlanner();
if (!selectedCase) {
  for (const pathStyle of [true, false]) {
    const probe = referenceStore(
      "s3",
      s3Endpoint,
      `capabilities-${pathStyle}`,
      "anonymous",
      pathStyle,
    );
    for (const key of ["one", "two", "three"]) {
      await probe.put(key, utf8.encode("first"), {
        "x-amz-meta-mtime": "123",
        "x-amz-meta-ctime": "122",
      });
    }
    const rows = await probe.list();
    assertEquals(rows.length, 3);
    assert(
      probe.log.some((request) =>
        new URL(request.url).searchParams.has("continuation-token")
      ),
      "real ListObjectsV2 pagination was not exercised",
    );
    const first = await probe.get("one");
    assertEquals(first.headers.get("x-amz-meta-mtime"), "123");
    assertEquals(first.headers.get("x-amz-meta-ctime"), "122");
    assert(
      /^".+"$/.test(first.headers.get("etag")),
      "real S3 strong ETag missing",
    );
    assertEquals(
      (await probe.request("PUT", "one", utf8.encode("blocked"), {
        "if-none-match": "*",
      })).status,
      412,
    );
    assertEquals(
      (await probe.request("PUT", "one", utf8.encode("blocked"), {
        "if-match": '"not-current"',
      })).status,
      412,
    );
    assertEquals(text.decode((await probe.get("one")).bytes), "first");
    assertEquals(
      (await probe.request("PUT", "one", utf8.encode("second"), {
        "if-match": first.headers.get("etag"),
      })).status,
      200,
    );
    assertEquals(
      (await probe.request("DELETE", "one", undefined, {
        "if-match": first.headers.get("etag"),
      })).status,
      412,
    );
    assertEquals(text.decode((await probe.get("one")).bytes), "second");
    const current = await probe.get("one");
    assertEquals(
      (await probe.request("DELETE", "one", undefined, {
        "if-match": current.headers.get("etag"),
      })).status,
      204,
    );
    assertEquals((await probe.request("GET", "one")).status, 404);
    await Deno.writeTextFile(
      `/artifacts/s3-features-${pathStyle}.json`,
      JSON.stringify({ pathStyle, rows, requests: probe.log }, null, 2),
    );
  }
}
const legacy = JSON.parse(
  await Deno.readTextFile("tests/fixtures/remotely-save/vectors.json"),
).legacyMetadata;

for (const backend of ["s3", "webdav"]) {
  for (const mode of ["none", "openssl-base64", "rclone-base64"]) {
    for (
      const variant of backend === "s3"
        ? ["path", "virtual"]
        : ["anonymous", "basic", "digest"]
    ) {
      const label = `${backend}-${mode}-${variant}`;
      if (selectedCase && selectedCase !== label) continue;
      console.log(`REAL ${label}`);
      const endpoint = backend === "s3" ? s3Endpoint : davEndpoint;
      const prefix = backend === "s3"
        ? `${label} space + root`
        : `${variant}/${label}`;
      const reference = referenceStore(
        backend,
        endpoint,
        prefix,
        variant,
        variant !== "virtual",
      );
      await reference.initialize();
      const codec = await codecFactory(mode, password);
      const names = new Map<string, string>();
      const initial = new Map<string, Uint8Array>([
        ["folder/Imported.md", utf8.encode("remote first\n")],
        ["Survivor.md", utf8.encode("unchanged survivor\n")],
        ["empty.md", new Uint8Array()],
        ["a b.md", utf8.encode("spaced name\n")],
        ["a+b.md", utf8.encode("literal plus name\n")],
        ["assets/Unicode-\u00e9.bin", Uint8Array.from([0, 255, 1, 254])],
      ]);
      for (const [path, bytes] of initial) {
        const native = await codec.name(path, mode === "openssl-base64");
        names.set(path, native);
        await reference.put(
          native,
          await codec.encode(bytes),
          backend === "s3"
            ? { "x-amz-meta-mtime": "1", "x-amz-meta-ctime": "1" }
            : {},
        );
      }
      const metadataName = await codec.name(
        "_remotely-save-metadata-on-remote.json",
      );
      await reference.put(metadataName, utf8.encode(legacy));
      const binaryMetadataName = await codec.name(
        "_remotely-save-metadata-on-remote.bin",
      );
      await reference.put(
        binaryMetadataName,
        Uint8Array.from([0, 255, 123, 12]),
      );
      const markerName = await codec.name(
        "preserved/",
        mode === "openssl-base64",
      );
      if (backend === "s3" || mode === "openssl-base64") {
        await reference.put(markerName, new Uint8Array());
      }
      const protectedObjects = new Map<string, Uint8Array>();
      for (const row of await reference.list()) {
        if (
          row.key === metadataName || row.key === binaryMetadataName ||
          row.key === markerName
        ) {
          protectedObjects.set(row.key, (await reference.get(row.key)).bytes);
        }
      }
      const rsSnapshot = async () => {
        const entities = [];
        for (const row of await reference.list()) {
          const key = await codec.decodeName(row.key);
          if (key.endsWith("/") || protectedObjects.has(row.key)) continue;
          const headers = (await reference.get(row.key)).headers;
          const clientTime = Number(headers.get("x-amz-meta-mtime"));
          entities.push({
            key,
            keyEnc: row.key,
            sizeEnc: row.size,
            mtimeSvr: row.modified,
            ...(clientTime > 0
              ? {
                mtimeCli: clientTime >= 1e12 ? clientTime : clientTime * 1000,
              }
              : {}),
          });
        }
        return entities;
      };
      const previousRemote = await rsSnapshot();
      // The other client's local clock is five minutes behind the server. Its
      // prevSync stores the actual remote clock as well as that local clock.
      const otherLocal = previousRemote.map((entity) => ({
        ...entity,
        mtimeCli: entity.mtimeSvr - 300000,
      }));
      const previousSync = otherLocal.map((entity) => ({ ...entity }));
      const settings = backend === "s3"
        ? {
          backend,
          encryption: mode,
          s3Endpoint: endpoint,
          s3Bucket: "bucket",
          s3Prefix: prefix,
          s3PathStyle: variant !== "virtual",
        }
        : {
          backend,
          encryption: mode,
          webdavUrl: `${endpoint}/${variant}/`,
          webdavBaseDir: label,
          webdavAuth: variant,
          webdavUsername: "interop",
        };
      const authority = new URL(endpoint).host;
      const virtualAuthority = new URL(s3Endpoint).host.replace(/^/, "bucket.");
      const f = await remotelySaveServerFixture([authority, virtualAuthority]);
      let diagnosticId: string | undefined;
      try {
        const id = await f.add(settings, {
          s3_access_key: "interop-access",
          s3_secret_key: "interop-secret",
          webdav_password: "interop-password",
          encryption_password: password,
        });
        diagnosticId = id;
        const active = await f.one(id);
        assertEquals(active.status, "active", JSON.stringify(active));
        const compare = async (round: string) => {
          const decoded = new Map<string, Uint8Array>();
          const observations = [];
          for (const row of await reference.list()) {
            if (protectedObjects.has(row.key)) {
              assertEquals(
                (await reference.get(row.key)).bytes,
                protectedObjects.get(row.key),
              );
              continue;
            }
            const path = await codec.decodeName(row.key);
            if (path.endsWith("/")) continue;
            assert(!decoded.has(path), "duplicate decoded real-service path");
            const actual = await reference.get(row.key);
            decoded.set(path, await codec.decode(actual.bytes));
            observations.push({ ...row, path, headers: [...actual.headers] });
          }
          const disk = new Map(
            [...walkSync(f.vault, { includeDirs: false })].map((entry) => [
              entry.path.slice(f.vault.length + 1),
              Deno.readFileSync(entry.path),
            ]),
          );
          assertEquals(decoded, disk, `${label} complete tree ${round}`);
          assertEquals(
            (await f.call("notes/folder/Imported")).content,
            text.decode(disk.get("folder/Imported.md")),
          );
          reports.push({ label, round, observations, files: [...disk.keys()] });
          await Deno.writeTextFile(
            `/artifacts/${label}-rounds.json`,
            JSON.stringify(reports, null, 2),
          );
          return decoded;
        };
        await compare("import");
        await f.call("notes/folder/Imported", "PATCH", {
          baseContent: "remote first\n",
          newContent: "local second\n",
        });
        await f.call("notes", "POST", {
          path: "Created",
          content: "created here",
        });
        await f.call(
          `notes/empty?base_version=${(await f.call("notes/empty")).version}`,
          "DELETE",
        );
        await f.sync(id);
        const afterExportTree = await compare("create-equal-size-edit-delete");
        const afterUpload = await rsSnapshot();
        const rsDecisions = await planReference(
          otherLocal,
          previousSync,
          afterUpload,
          backend,
        );
        assertEquals(
          rsDecisions["folder/Imported.md"].decision,
          "remote_is_modified_then_pull",
        );
        assertEquals(
          rsDecisions["empty.md"].decision,
          "remote_is_deleted_thus_also_delete_local",
        );
        assertEquals(
          rsDecisions["Created.md"].decision,
          "remote_is_created_then_pull",
        );
        assertEquals(rsDecisions["Survivor.md"].decision, "equal");
        // Consume the planner's actual decisions at another client's plaintext
        // tree, rather than stopping at a driver-only codec round trip.
        const otherClientTree = new Map(initial);
        for (
          const [key, value] of Object.entries(rsDecisions) as [
            string,
            { decision: string },
          ][]
        ) {
          if (value.decision.endsWith("_then_pull")) {
            otherClientTree.set(key, afterExportTree.get(key)!);
          } else if (
            value.decision === "remote_is_deleted_thus_also_delete_local"
          ) otherClientTree.delete(key);
          else assertEquals(value.decision, "equal");
        }
        assertEquals(
          otherClientTree,
          afterExportTree,
          "upstream v3 decisions did not converge the other client's complete tree",
        );
        if (backend === "s3") {
          assertEquals(
            (await reference.get(names.get("folder/Imported.md"))).headers.get(
              "x-amz-meta-ctime",
            ),
            "1",
            "creation metadata changed on replacement",
          );
        }
        reports.push({
          label,
          round: "v3-source-decisions-skewed-local-clock",
          rsDecisions,
          previousSync,
          afterUpload,
        });
        const importedBefore = afterUpload.find((entity) =>
          entity.key === "folder/Imported.md"
        );
        const pulledLocal = afterUpload.map((entity) => ({
          ...entity,
          mtimeCli: entity.mtimeSvr - 300000,
        }));
        // Issue another equal-size replacement immediately, with no test-side sleep.
        await f.call("notes/folder/Imported", "PATCH", {
          baseContent: "local second\n",
          newContent: "third change\n",
        });
        const settlementObservations: unknown[] = [];
        await waitUntil(async () => {
          const instance = await f.sync(id);
          const actual = await codec.decode(
            (await reference.get(names.get("folder/Imported.md"))).bytes,
          );
          const states = f.metadata("SELECT state FROM peer_files");
          settlementObservations.push({ status: instance.status, states });
          if (text.decode(actual) === "third change\n") return done();
          assert(
            states.some((row) =>
              row.state === "pending" || row.state === "uncertain"
            ),
            "rapid export did not settle or retain a retry obligation",
          );
          return pending({ status: instance.status, states });
        }, { label: "rapid export settles after native validator conflicts" });
        const rapid = await rsSnapshot();
        const importedAfter = rapid.find((entity) =>
          entity.key === "folder/Imported.md"
        );
        assert(
          importedBefore && importedAfter,
          "rapid-edit observations missing",
        );
        assertEquals(importedAfter.sizeEnc, importedBefore.sizeEnc);
        assert(
          importedAfter.mtimeSvr > importedBefore.mtimeSvr,
          "rapid equal-size upload lacks a later server tick",
        );
        for (const accurate of [true, false]) {
          const decision = await planReference(
            pulledLocal,
            pulledLocal,
            accurate ? rapid : rapid.map((entity) => ({
              ...entity,
              mtimeCli: entity.mtimeSvr,
            })),
            backend,
          );
          assertEquals(
            decision["folder/Imported.md"].decision,
            "remote_is_modified_then_pull",
          );
          reports.push({
            label,
            round: "rapid-equal-size-v3-detection",
            accurate,
            decision,
            importedBefore,
            importedAfter,
            settlementObservations,
          });
        }
        await compare("rapid-equal-size");
        assertEquals(
          text.decode(
            await codec.decode(
              (await reference.get(names.get("folder/Imported.md"))).bytes,
            ),
          ),
          "third change\n",
        );
        // Return edit and collision each pass through the real production Worker/hub.
        await reference.put(
          names.get("folder/Imported.md"),
          await codec.encode(utf8.encode("return edit from other client\n")),
        );
        const returnObservations: unknown[] = [];
        await waitUntil(async () => {
          const state = await f.sync(id);
          returnObservations.push({
            status: state.status,
            reason: state.reason,
            error: state.error,
          });
          if (
            Deno.readTextFileSync(`${f.vault}/folder/Imported.md`) ===
              "return edit from other client\n"
          ) return done();
          assert(
            state.status === "active" || state.status === "failed",
            "return edit cannot recover from this instance state",
          );
          return pending({
            status: state.status,
            reason: state.reason,
            error: state.error,
          });
        }, {
          label:
            "remote return edit reaches the vault after a complete observation",
        });
        assertEquals(
          Deno.readTextFileSync(`${f.vault}/folder/Imported.md`),
          "return edit from other client\n",
        );
        assertEquals(
          (await f.call("conflicts")).total,
          0,
          "ordinary exports/metadata transitions created a conflict",
        );
        reports.push({ label, round: "return-edit", returnObservations });
        await f.configure(id, { enabled: false });
        await f.call("notes/folder/Imported", "PATCH", {
          baseContent: "return edit from other client\n",
          newContent: "hub collision\n",
        });
        await reference.put(
          names.get("folder/Imported.md"),
          await codec.encode(utf8.encode("remote collision\n")),
        );
        await f.configure(id, { enabled: true });
        await f.sync(id);
        assertEquals((await f.call("conflicts")).total, 1);
        await compare("collision");
        const sequence = f.metadata("SELECT MAX(seq) AS seq FROM changes");
        const mutationCount = () => {
          const log = Deno.readTextFileSync(
            `/artifacts/services/${
              backend === "s3" ? "s3" : "dav"
            }/requests.log`,
          );
          return log.split("\n").filter((line) =>
            backend === "s3"
              ? /PutObjectHandler bucket=|DeleteObjectHandler bucket /.test(
                line,
              )
              : / (PUT|DELETE) /.test(line)
          ).length;
        };
        const count = mutationCount();
        assert(count > 0, "real service mutation witness is empty");
        if (backend === "webdav") {
          // Apache briefly emits weak ETags for newly written files, then strong
          // ETags for the same bytes. Adoption may update revisions, never files.
          await waitUntil(
            async () =>
              (await reference.list()).some((row) => row.etag?.startsWith("W/"))
                ? pending("Apache validator is still weak")
                : done(),
            { label: "Apache post-write validators settle" },
          );
          await f.sync(id);
          assertEquals(
            mutationCount(),
            count,
            "validator adoption caused a write",
          );
          assertEquals(
            f.metadata("SELECT MAX(seq) AS seq FROM changes"),
            sequence,
          );
        }
        const before = f.metadata("SELECT * FROM peer_files");
        await f.restart();
        for (let cycle = 0; cycle < 5; cycle++) {
          assertEquals((await f.sync(id)).status, "active");
        }
        assertEquals(mutationCount(), count, "real service received an echo");
        assertEquals(f.metadata("SELECT * FROM peer_files"), before);
        assertEquals(
          f.metadata("SELECT MAX(seq) AS seq FROM changes"),
          sequence,
        );
        await compare("restart-five-cycle-no-echo");
        await Deno.writeTextFile(
          `/artifacts/${label}.json`,
          JSON.stringify(
            { reports, referenceRequests: reference.log },
            null,
            2,
          ),
        );
        completed++;
      } catch (error) {
        const instance = diagnosticId
          ? await f.one(diagnosticId).catch((cause) => ({
            captureError: String(cause),
          }))
          : null;
        await Deno.writeTextFile(
          `/artifacts/${label}-failure.json`,
          JSON.stringify(
            {
              error: String(error),
              instance,
              mappings: f.metadata("SELECT * FROM peer_files"),
              logs: f.logs(),
            },
            null,
            2,
          ),
        ).catch((cause) =>
          console.error("Failure evidence write failed:", String(cause))
        );
        throw error;
      } finally {
        await f.close();
      }
    }
  }
}
if (!selectedCase) {
  await nativeNameBoundaries(davEndpoint);
  await incrementalTraffic(s3Endpoint, davEndpoint);
}
await Deno.writeTextFile(
  "/artifacts/matrix.json",
  JSON.stringify(reports, null, 2),
);
console.log(
  `Real-service matrix completed: ${completed} backend/codec/auth/address cases`,
);
assert(
  completed === (selectedCase ? 1 : 15),
  "matrix selection did not complete",
);
