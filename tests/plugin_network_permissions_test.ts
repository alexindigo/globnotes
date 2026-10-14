// SPDX-License-Identifier: LGPL-3.0-only

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { readManifest, workerPermissions } from "../server/plugins/manifest.ts";
import { PluginContractError } from "../server/plugins/contracts.ts";
import {
  canonicalAuthority,
  canonicalScopes,
  intersectScopes,
  scopeCovers,
  type Source,
} from "../server/plugins/network_contracts.ts";
import {
  delegableScopes,
  effectiveScopes,
} from "../server/plugins/network_permissions.ts";
import {
  type NetworkOwner,
  PluginNetworkStore,
  requestedScopes,
} from "../server/plugins/network_store.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { PluginManager } from "../server/plugins/manager.ts";

Deno.test("plugin network: declarations without operator consent delegate neither kind", async () => {
  const fixture = await pluginFixture();
  try {
    const dir = await fixture.install("requested", {
      runtime: { server: "service.js" },
      capabilities: { network: ["127.0.0.1:8123"] },
    }, { "service.js": "export function activate() {}" });
    const permissions = workerPermissions(readManifest(dir), fixture.vault, {
      role: "service",
    });
    assert(typeof permissions === "object");
    assertEquals(permissions.net, false);
    assertEquals(permissions.import, false);
  } finally {
    await fixture.dispose();
  }
});

Deno.test("plugin network: scopes preserve port breadth, IDNA and IPv6 and reject URL authority escalation", () => {
  assertEquals(
    canonicalAuthority("BÜCHER.example:00443"),
    "xn--bcher-kva.example:443",
  );
  assertEquals(canonicalAuthority("[0:0:0:0:0:0:0:1]:80"), "[::1]:80");
  assertEquals(canonicalAuthority("LOCALHOST"), "localhost");
  assertEquals(canonicalAuthority("example.com:80"), "example.com:80");
  for (
    const invalid of [
      "https://example.com",
      "user@example.com",
      "example.com/path",
      "example.com ",
      "*.example.com",
      "*",
      "::1",
      "example.com:",
      "example.com:0",
      "example.com:65536",
      "example.com:abc",
      "example.com#fragment",
      "example.com?query",
      "example.com%2fpath",
    ]
  ) {
    assertThrows(() => canonicalAuthority(invalid), PluginContractError);
  }
  const any = canonicalScopes(["example.com"]),
    exact = canonicalScopes(["example.com:443"]);
  assertEquals(intersectScopes(any, exact), exact);
  assertEquals(intersectScopes(exact, any), exact);
  assertEquals(intersectScopes(canonicalScopes(true), exact), exact);
  assertEquals(intersectScopes(canonicalScopes(["example.com:80"]), exact), []);
  assertEquals(intersectScopes(canonicalScopes(["sub.example.com"]), any), []);
  assert(!scopeCovers(exact[0], any[0]));
  assertEquals(canonicalScopes(["EXAMPLE.com:443", "example.com:443"]), exact);
});

Deno.test("plugin network: parent query must prove the whole candidate independently without requesting permission", () => {
  const seen: Deno.PermissionDescriptor[] = [];
  const query = (descriptor: Deno.PermissionDescriptor) => {
    seen.push(descriptor);
    return {
      state: descriptor.name === "net" && descriptor.host === "example.com:443"
        ? "granted" as const
        : "prompt" as const,
      partial: false,
    };
  };
  const host = canonicalScopes(["example.com:443"]);
  assertEquals(
    effectiveScopes("network", true, canonicalScopes(true), host, query),
    host,
  );
  assertEquals(effectiveScopes("imports", true, host, host, query), []);
  assertEquals(
    effectiveScopes(
      "network",
      true,
      canonicalScopes(["example.com"]),
      canonicalScopes(["example.com"]),
      query,
    ),
    [],
  );
  assertEquals(
    effectiveScopes(
      "network",
      true,
      canonicalScopes(true),
      canonicalScopes(true),
      query,
    ),
    [],
  );
  assertEquals(
    delegableScopes(
      "network",
      host,
      () => ({ state: "granted", partial: true }),
    ),
    [],
  );
  assertEquals(
    delegableScopes("network", host, () => {
      throw new Error("unsupported descriptor");
    }),
    [],
  );
  const count = seen.length;
  assertEquals(effectiveScopes("network", false, host, host, query), []);
  assertEquals(seen.length, count);
});

async function storeFixture() {
  const fixture = await pluginFixture();
  let identity = {
    key: "a".repeat(64),
    codeFingerprint: "b".repeat(64),
    settingsRevision: 0,
  };
  const owner: NetworkOwner = {
    id: "requested",
    source: () => Promise.resolve(identity),
    staticRequests: () => ({
      network: canonicalScopes(["example.com"]),
      imports: [],
    }),
  };
  const store = new PluginNetworkStore(fixture.statePath, {
    commit: (effect) => effect(),
  });
  const controls = async (
    source: Source,
    values: {
      allowNetwork: boolean;
      approvedNetwork: unknown;
      approvedImports?: unknown;
    },
  ) => {
    const before = await store.read(owner.id);
    return store.controls(owner, source, {
      revision: before.record.revision,
      signature: before.signature,
      requestSourceKey: source.key,
      requestSourceRevision: source.revision,
      ...values,
      approvedImports: values.approvedImports ?? [],
    });
  };
  return {
    fixture,
    owner,
    store,
    controls,
    changeSource() {
      identity = {
        key: "c".repeat(64),
        codeFingerprint: identity.codeFingerprint,
        settingsRevision: 1,
      };
    },
  };
}

Deno.test("plugin network: host-owned controls retain approval and CAS through restart, off and request changes", async () => {
  const b = await storeFixture();
  try {
    const initial = await b.store.synchronize(b.owner);
    assertEquals(initial.record.allowNetwork, false);
    assertEquals(initial.record.approvedNetwork, []);
    const exact = canonicalScopes(["example.com:443"]);
    await b.controls(initial.source, {
      allowNetwork: true,
      approvedNetwork: exact,
    });
    const restarted = new PluginNetworkStore(b.fixture.statePath, {
      commit: (effect) => effect(),
    });
    const remembered = await restarted.synchronize(b.owner);
    assertEquals(remembered.record.approvedNetwork, exact);
    await assertRejects(
      () =>
        b.store.controls(b.owner, initial.source, {
          revision: initial.record.revision,
          signature: initial.signature,
          requestSourceKey: initial.source.key,
          requestSourceRevision: initial.source.revision,
          allowNetwork: false,
          approvedNetwork: [],
          approvedImports: [],
        }),
      PluginContractError,
      "changed",
    );
    await b.controls(initial.source, {
      allowNetwork: false,
      approvedNetwork: exact,
    });
    assertEquals(
      (await b.store.read(b.owner.id)).record.approvedNetwork,
      exact,
    );
    await assertRejects(
      () =>
        b.controls(initial.source, {
          allowNetwork: true,
          approvedNetwork: canonicalScopes(["other.example:443"]),
        }),
      PluginContractError,
      "not covered",
    );
    await b.controls(initial.source, {
      allowNetwork: true,
      approvedNetwork: [],
    });
    await b.store.declare(b.owner, "service", initial.source, () => true, {
      network: ["example.com:443"],
    });
    const deleted = await b.store.read(b.owner.id);
    assertEquals(deleted.record.approvedNetwork, []);
    assertEquals(
      requestedScopes(b.owner.staticRequests(), deleted.record).network,
      canonicalScopes(["example.com", "example.com:443"]),
    );
    const bytes = Deno.readTextFileSync(
      `${b.fixture.statePath}/plugin-network/requested.json`,
    );
    await b.store.declare(b.owner, "service", initial.source, () => true, {
      network: ["EXAMPLE.COM:443"],
    });
    assertEquals(
      Deno.readTextFileSync(
        `${b.fixture.statePath}/plugin-network/requested.json`,
      ),
      bytes,
    );
  } finally {
    await b.fixture.dispose();
  }
});

Deno.test("plugin network: request writers cannot promote controls; complete contributor snapshots deduplicate and reject divergence", async () => {
  const b = await storeFixture();
  try {
    const { source } = await b.store.synchronize(b.owner);
    await b.store.declare(b.owner, "service", source, () => true, {
      network: ["service.example:443"],
    });
    await b.store.declare(b.owner, "render", source, () => true, {
      imports: ["code.example:443"],
    });
    const before = await b.store.read(b.owner.id);
    assertEquals(before.record.approvedNetwork, []);
    assertEquals(before.record.allowNetwork, false);
    assertEquals(requestedScopes(b.owner.staticRequests(), before.record), {
      network: canonicalScopes(["example.com", "service.example:443"]),
      imports: canonicalScopes(["code.example:443"]),
    });
    await assertRejects(
      () =>
        b.store.declare(b.owner, "service", source, () => true, {
          network: ["other.example:443"],
        }),
      PluginContractError,
      "divergent",
    );
    await assertRejects(
      () =>
        b.store.declare(b.owner, "service", source, () => true, {
          allowNetwork: true,
          approvedNetwork: true,
        }),
      PluginContractError,
      "requests only",
    );
    await assertRejects(
      () =>
        b.store.declare(b.owner, "service", source, () => false, {
          network: ["service.example:443"],
        }),
      PluginContractError,
      "obsolete",
    );
    const first = await b.store.requestAccess(b.owner, source, () => true, {
      kind: "network",
      hosts: "runtime.example:443",
      reason: "Read service status",
    });
    const same = await b.store.requestAccess(b.owner, source, () => true, {
      kind: "network",
      hosts: ["RUNTIME.EXAMPLE:443"],
      reason: "Repeated explanation",
    });
    assertEquals(first.value, same.value);
    assertEquals(same.snapshot.record.requests.length, 1);
    assertEquals(same.snapshot.record.requests[0].state, "pending");
    assertEquals(same.snapshot.record.approvedNetwork, []);
    b.changeSource();
    const fresh = await b.store.synchronize(b.owner);
    assertEquals(fresh.source.revision, source.revision + 1);
    assertEquals(fresh.record.contributors, {});
    assertEquals(fresh.record.requests[0].state, "obsolete");
    await assertRejects(
      () =>
        b.store.declare(b.owner, "service", source, () => true, {
          network: ["late.example"],
        }),
      PluginContractError,
      "obsolete",
    );
    await b.store.declare(b.owner, "service", fresh.source, () => true, {
      network: ["fresh.example"],
    });
  } finally {
    await b.fixture.dispose();
  }
});

Deno.test("plugin network: corrupt, unsupported and manually modified ledgers retain exact bytes", async () => {
  const b = await storeFixture();
  try {
    const { source } = await b.store.synchronize(b.owner);
    await b.controls(source, { allowNetwork: false, approvedNetwork: [] });
    const file = `${b.fixture.statePath}/plugin-network/requested.json`;
    for (
      const bytes of [
        "{broken",
        '{"schemaVersion":99}',
        '{"schemaVersion":1,"revision":0}',
      ]
    ) {
      Deno.writeTextFileSync(file, bytes);
      await assertRejects(() => b.store.read(b.owner.id), PluginContractError);
      await assertRejects(
        () =>
          b.controls(source, {
            allowNetwork: true,
            approvedNetwork: canonicalScopes(["example.com:443"]),
          }),
        PluginContractError,
      );
      assertEquals(Deno.readTextFileSync(file), bytes);
    }
    Deno.writeTextFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        allowNetwork: false,
        approvedNetwork: [],
        approvedImports: [],
        source,
        contributors: {},
        requests: [],
      }),
    );
    const before = await b.store.read(b.owner.id);
    Deno.writeTextFileSync(file, Deno.readTextFileSync(file) + "\n");
    await assertRejects(
      () =>
        b.store.controls(b.owner, source, {
          revision: before.record.revision,
          signature: before.signature,
          requestSourceKey: source.key,
          requestSourceRevision: source.revision,
          allowNetwork: true,
          approvedNetwork: canonicalScopes(["example.com:443"]),
          approvedImports: [],
        }),
      PluginContractError,
      "changed",
    );
  } finally {
    await b.fixture.dispose();
  }
});

Deno.test("plugin network: source revisions persist monotonically before any grant or runtime publication", async () => {
  const b = await storeFixture();
  try {
    const first = await b.store.synchronize(b.owner);
    const restarted = new PluginNetworkStore(b.fixture.statePath, {
      commit: (effect) => effect(),
    });
    assertEquals((await restarted.synchronize(b.owner)).source, first.source);
    b.changeSource();
    const changed = await restarted.synchronize(b.owner);
    assert(changed.source.revision > first.source.revision);
    assertEquals(changed.record.allowNetwork, false);
    assertEquals(changed.record.approvedNetwork, []);
    assertEquals(changed.record.requests, []);
    const again = new PluginNetworkStore(b.fixture.statePath, {
      commit: (effect) => effect(),
    });
    assertEquals((await again.synchronize(b.owner)).source, changed.source);
  } finally {
    await b.fixture.dispose();
  }
});

Deno.test("plugin network: unapproved declared receiver observes no raw Worker fetch", async () => {
  const fixture = await pluginFixture();
  let traffic = 0;
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      traffic++;
      return new Response("unapproved traffic");
    },
  );
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const authority = `127.0.0.1:${receiver.addr.port}`;
    const dir = await fixture.install("requested", {
      runtime: { server: "service.js" },
      capabilities: { network: [authority] },
    }, { "service.js": "export function activate() {}" });
    const body =
      `try { postMessage({ value: await (await fetch('http://${authority}/unapproved')).text() }); }
      catch (error) { postMessage({ denied: error.name }); }`;
    worker = new Worker(
      `data:application/javascript,${encodeURIComponent(body)}`,
      {
        type: "module",
        deno: {
          permissions: workerPermissions(readManifest(dir), fixture.vault, {
            role: "service",
          }),
        },
      },
    );
    const observed = await new Promise<{ value?: string; denied?: string }>(
      (resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("unapproved receiver probe deadline")),
          3000,
        );
        worker!.onmessage = ({ data }) => resolve(data);
        worker!.onerror = (event) => {
          event.preventDefault();
          reject(new Error(event.message));
        };
      },
    );
    console.log(
      JSON.stringify({ unapprovedReceiver: { authority, traffic, observed } }),
    );
    assertEquals(traffic, 0);
    assertEquals(observed.denied, "NotCapable");
  } finally {
    clearTimeout(timer);
    worker?.terminate();
    await receiver.shutdown();
    await fixture.dispose();
  }
});

Deno.test("plugin network: worker-free browser metadata ignores suppression and exposes static import requests", async () => {
  const fixture = await pluginFixture();
  let traffic = 0;
  const receiver = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      traffic++;
      return new Response("export const value='must remain unconsumed'");
    },
  );
  const authority = `127.0.0.1:${receiver.addr.port}`;
  const manager = new PluginManager(
    fixture.vault,
    () => Promise.resolve(null),
    0,
    fixture.statePath,
    {
      internalRoot: `${fixture.root}/internal`,
      persistence: { commit: (effect) => effect() },
    },
  );
  try {
    for (const id of ["custom-editor", "disabled-editor"]) {
      await fixture.install(id, {
        client: { entry: "custom-editor.js" },
        runsInBrowser: false,
        browserComponents: [],
      }, {
        "custom-editor.js":
          "throw Error('catalog must not execute editor code');",
      });
    }
    await fixture.install("custom-runtime", {
      runtime: { client: "custom-app.js" },
      runsInBrowser: false,
    }, {
      "custom-app.js": "throw Error('catalog must not execute browser code');",
    });
    await fixture.install("mixed", {
      runtime: { server: "service.js", client: "custom-app.js" },
      client: { entry: "custom-editor.js" },
      runsInBrowser: false,
      browserComponents: [],
    }, {
      "main.js": "export function getSelectors() { return []; }",
      "service.js": "export function activate() {}",
      "custom-app.js": "throw Error('catalog must not execute browser code');",
      "custom-editor.js":
        "throw Error('catalog must not execute editor code');",
    });
    await fixture.install("rendered-resources", {
      runsInBrowser: true,
      browserComponents: ["runtime"],
      capabilities: { network: false, imports: [authority] },
    }, {
      "main.js":
        `import {value} from 'http://${authority}/module.js'; export function getSelectors(){return []}`,
      "styles.css": "body { color: inherit; }",
    });
    await Deno.writeTextFile(
      `${fixture.statePath}/plugins.json`,
      JSON.stringify({ disabled: ["disabled-editor"] }),
    );
    const catalog = await manager.catalog();
    for (
      const [id, components] of [
        ["custom-editor", ["editor"]],
        ["disabled-editor", ["editor"]],
        ["custom-runtime", ["runtime"]],
        ["mixed", ["editor", "runtime"]],
        ["rendered-resources", []],
      ] as const
    ) {
      const plugin = catalog.plugins.find((plugin) => plugin.id === id);
      assert(plugin && plugin.permissions);
      assertEquals(plugin.runsInBrowser, components.length > 0);
      assertEquals(plugin.browserComponents, [...components]);
      assertEquals(plugin.permissions.runsInBrowser, components.length > 0);
      assertEquals(plugin.permissions.browserComponents, [...components]);
      assertEquals(plugin.permissions.allowNetwork, false);
      assertEquals(plugin.permissions.effectiveNetwork, []);
      assertEquals(plugin.permissions.effectiveImports, []);
      assertEquals(plugin.pages, []);
    }
    assertEquals(
      catalog.plugins.find((plugin) => plugin.id === "disabled-editor")?.status,
      "disabled",
    );
    const render = catalog.plugins.find((plugin) =>
      plugin.id === "rendered-resources"
    )!;
    assertEquals(render.permissions!.requestedImports, [{
      type: "host",
      authority,
    }]);
    assert(
      render.permissions!.rows.some((row) =>
        row.kind === "imports" && row.sources.includes("static") &&
        row.blockedReasons.includes("unapproved")
      ),
    );
    assertEquals(manager.hosts.size, 0);
    assertEquals(traffic, 0);
    console.log(JSON.stringify({
      workerFreeCatalog: catalog.plugins.map((
        { id, enabled, runsInBrowser, browserComponents, permissions },
      ) => ({
        id,
        enabled,
        runsInBrowser,
        browserComponents,
        allowNetwork: permissions?.allowNetwork,
      })),
      staticImportAuthority: authority,
      traffic,
    }));
  } finally {
    manager.stop();
    await receiver.shutdown();
    await fixture.dispose();
  }
});
