// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import { DriverSecrets } from "../server/hub/drivers/secrets.ts";
import { driverRedactor } from "../server/hub/drivers/redact.ts";
import { pluginFixture } from "./helpers/plugin_fixture.ts";
import { encodeBase64 } from "@std/encoding/base64";

Deno.test("drivers: private mode-0600 keys, write-only status, instance isolation and secure removal", async () => {
  const fixture = await pluginFixture();
  let store: DriverSecrets | undefined;
  const key = "m5-private-key-+/with spaces";
  try {
    store = new DriverSecrets(fixture.statePath);
    assertEquals(Deno.statSync(store.filename).mode! & 0o777, 0o600);
    store.set("one", "token", key);
    store.set("two", "token", "other-key");
    const declarations = [{ key: "token", label: "Access token" }, {
      key: "password",
      label: "Password",
    }];
    const status = store.status("one", declarations);
    assertEquals(status.map(({ key, set }) => ({ key, set })), [{
      key: "token",
      set: true,
    }, { key: "password", set: false }]);
    assertEquals(JSON.stringify(status).includes(key), false);
    assertEquals(store.get("one", "token"), key);
    assertEquals(store.get("two", "token"), "other-key");
    assertEquals(store.get("three", "token"), null);
    store.close();
    store = new DriverSecrets(fixture.statePath);
    assertEquals(store.get("one", "token"), key);
    store.clear("one", "token");
    assertEquals(store.status("one", declarations)[0].set, false);
    store.set("one", "token", key);
    store.remove("one");
    assertEquals(store.get("one", "token"), null);
    assertEquals(store.get("two", "token"), "other-key");
    assertEquals(
      new TextDecoder().decode(Deno.readFileSync(store.filename)).includes(key),
      false,
    );
    assertEquals(
      [...Deno.readDirSync(fixture.statePath)].map((entry) => entry.name),
      ["driver-secrets.sqlite"],
    );
    assertEquals([...Deno.readDirSync(fixture.vault)], []);
  } finally {
    store?.close();
    await fixture.dispose();
  }
});

Deno.test("drivers: secret redactor handles raw URI and base64 without replacement recursion", () => {
  const key = "token +/=.?[]";
  const redact = driverRedactor([key, "secret"]);
  const forms = [
    key,
    encodeURIComponent(key),
    encodeBase64(new TextEncoder().encode(key)),
  ];
  assertEquals(redact(forms.join(" | ")), "[secret] | [secret] | [secret]");
  assertEquals(redact("ordinary failure"), "ordinary failure");
  assertEquals(driverRedactor([])("unchanged"), "unchanged");
});

Deno.test("drivers: secret storage refuses insecure or linked existing targets without changing them", async () => {
  const fixture = await pluginFixture();
  try {
    const target = `${fixture.statePath}/driver-secrets.sqlite`;
    Deno.writeTextFileSync(target, "keep these bytes");
    Deno.chmodSync(target, 0o644);
    assertThrows(() => new DriverSecrets(fixture.statePath));
    assertEquals(Deno.readTextFileSync(target), "keep these bytes");
    Deno.removeSync(target);
    const outside = `${fixture.root}/other`;
    Deno.writeTextFileSync(outside, "outside");
    Deno.symlinkSync(outside, target);
    assertThrows(() => new DriverSecrets(fixture.statePath));
    assertEquals(Deno.readTextFileSync(outside), "outside");
    assert(Deno.lstatSync(target).isSymlink);
  } finally {
    await fixture.dispose();
  }
});
