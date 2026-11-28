// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { HttpError, type PathfinderRequest } from "@pathfinder/pathfinder";
import accessPut from "../server/api/endpoints/_/api/access/put.ts";
import setupPost from "../server/api/endpoints/_/api/setup/post.ts";
import brandPost from "../server/api/endpoints/_/api/brand/post.ts";
import { AuthenticationError } from "../server/auth/sessions.ts";
import { AclRepository } from "../server/auth/acl.ts";
import { createUuid } from "../shared/uuid.ts";
import { state } from "../server/state.ts";
import { accountRouteFixture } from "./helpers/account_route_fixture.ts";
import { setupScenario } from "./helpers/fixture_scenarios.ts";
import { bounded } from "./helpers/worker_liveness.ts";
import { fixtureGate } from "./helpers/fixture_coordination.ts";
import { signIn } from "./helpers/session_delivery.ts";

function jsonRequest(
  path: string,
  method: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
) {
  const request = new Request(`http://fixture/_/api/${path}`, {
    method,
    signal,
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  return { _raw: request } as PathfinderRequest;
}

Deno.test("R05: invalid Everybody else values do not write or retire authority", async (t) => {
  for (
    const everybody of [
      ["none"],
      [["none"]],
      ["view"],
      {},
      null,
      1,
      true,
      undefined,
      "NONE",
      " none",
      "totp",
    ]
  ) {
    await t.step(
      JSON.stringify(everybody) ?? "missing",
      () =>
        accountRouteFixture(async ({ identity, lifecycle, alice }) => {
          const { access_token, principal } = await alice();
          const { revision, signature, grants } = await identity.acl.view();
          const before = identity.acl.capture(), epoch = lifecycle.epoch;
          const error = await assertRejects(
            () =>
              accessPut(jsonRequest("access", "PUT", {
                revision,
                signature,
                grants,
                everybody,
                updateId: createUuid(),
              }, access_token)),
            HttpError,
            "HTTP 422",
          );
          assertEquals(error.status, 422);
          assertEquals(identity.acl.capture(), before);
          assertEquals(lifecycle.epoch, epoch);
          assertStrictEquals(state.identity, identity);
          assertEquals(
            await identity.sessions.validateToken(access_token),
            principal,
          );
        }),
    );
  }
});

for (const application of [false, true]) {
  Deno.test(`R06: ${application ? "application" : "external"} ACL edit during signature preserves exact newer bytes`, () =>
    accountRouteFixture(
      async ({ config, identity, lifecycle, alice, scope }) => {
        const { access_token, principal } = await alice();
        const { revision, signature, grants } = await identity.acl.view();
        const save = identity.acl.capture();
        const file = `${config.statePath}/access.json`, epoch = lifecycle.epoch;
        const reached = fixtureGate(scope), release = fixtureGate(scope);
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        let held = false;
        crypto.subtle.digest = (algo, data) => {
          const result = digest(algo, data);
          if (held) return result;
          held = true;
          reached.resolve();
          return result.then(async (value) => {
            await release.promise;
            return value;
          });
        };
        const rejected = assertRejects(
          () =>
            accessPut(jsonRequest("access", "PUT", {
              revision,
              signature,
              grants,
              everybody: "none",
              updateId: createUuid(),
            }, access_token)),
          HttpError,
          "HTTP 409",
        );
        let newer: string;
        try {
          await bounded(reached.promise, "real ACL signature");
          const updateId = createUuid(), actorId = principal.accountId;
          if (application) {
            identity.acl.save({ everybody: "view", grants }, save, {
              updateId,
              actorId,
            });
          } else {
            Deno.writeTextFileSync(
              file,
              JSON.stringify(
                {
                  ...save.value,
                  everybody: "view",
                  revision: revision + 1,
                  updateId,
                  updateActorId: actorId,
                },
                null,
                4,
              ) + "\n",
            );
          }
          newer = Deno.readTextFileSync(file);
        } finally {
          release.resolve();
          crypto.subtle.digest = digest;
          assertEquals((await rejected).status, 409);
        }
        assertEquals(Deno.readTextFileSync(file), newer);
        assertEquals(
          identity.acl.capture().value.everybody,
          application ? "view" : "edit",
        );
        const reopened = new AclRepository(
          config.statePath,
          identity.acl.vaultId,
          { accounts: identity.accounts },
        );
        assertEquals(reopened.capture().value.everybody, "view");
        assertEquals(lifecycle.epoch, epoch);
        const view = await reopened.view();
        assertEquals(Object.hasOwn(view, "raw"), false);
      },
    ));
}

Deno.test("R06: held current-password proof cannot overwrite a newer password record", () =>
  accountRouteFixture(async ({ identity, alice, lifecycle, scope }) => {
    const { principal, access_token } = await alice(), epoch = lifecycle.epoch;
    const file = `${identity.accounts.root}/accounts.json`;
    const acl = identity.acl.capture();
    const reached = fixtureGate(scope), release = fixtureGate(scope);
    const derive = crypto.subtle.deriveBits.bind(crypto.subtle);
    let held = false;
    crypto.subtle.deriveBits = (...args) => {
      const result = derive(...args);
      if (held) return result;
      held = true;
      reached.resolve();
      return result.then(async (value) => {
        await release.promise;
        return value;
      });
    };
    const pending = identity.account.change(principal, {
      revision: principal.credentialRevision,
      updateId: createUuid(),
      currentPassword: "password",
      newPassword: "losing password",
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let newer;
    try {
      await bounded(reached.promise, "real current password derivation");
      const winner = await new Response(
        await identity.account.change(principal, {
          revision: principal.credentialRevision,
          updateId: createUuid(),
          currentPassword: "password",
          newPassword: "winning password",
        }),
      ).json();
      assertEquals(
        winner.account.credentialRevision,
        principal.credentialRevision + 1,
      );
      newer = Deno.readTextFileSync(file);
    } finally {
      release.resolve();
      crypto.subtle.deriveBits = derive;
      const result = await pending;
      assert(!result.ok);
    }
    assertEquals(Deno.readTextFileSync(file), newer);
    assertEquals(identity.acl.capture(), acl);
    assertStrictEquals(state.identity, identity);
    assertEquals(lifecycle.epoch, epoch);
    await assertRejects(
      () => identity.sessions.validateToken(access_token),
      AuthenticationError,
      "Invalid authentication credentials.",
    );
    assertEquals(
      (await signIn(identity.sessions, {
        username: "alice",
        password: "winning password",
      })).principal.accountId,
      principal.accountId,
    );
  }));

Deno.test("R06: first-account setup cannot publish after retirement during real password hashing", () =>
  accountRouteFixture(async ({ identity, lifecycle, scope }) => {
    const before = [
      identity.accounts.capture(),
      identity.signing.capture(),
      identity.acl.capture(),
    ];
    const epoch = lifecycle.epoch;
    const reached = fixtureGate(scope), release = fixtureGate(scope);
    const derive = crypto.subtle.deriveBits.bind(crypto.subtle);
    const abort = new AbortController();
    let held = false;
    crypto.subtle.deriveBits = (...args) => {
      const result = derive(...args);
      if (held) return result;
      held = true;
      reached.resolve();
      return result.then(async (value) => {
        await release.promise;
        return value;
      });
    };
    const reason = new DOMException("Setup request retired", "AbortError");
    const rejected = setupPost(jsonRequest(
      "setup",
      "POST",
      {
        username: "first-admin",
        password: "fixture setup password",
        everybody: "none",
        updateId: createUuid(),
      },
      undefined,
      abort.signal,
    ));
    try {
      await bounded(reached.promise, "real setup password derivation");
      abort.abort(reason);
    } finally {
      release.resolve();
      crypto.subtle.deriveBits = derive;
      const response = await rejected;
      assertEquals([response.status, await response.json()], [401, {
        detail: "Invalid authentication credentials.",
        code: "credentials_refused",
      }]);
    }
    assertEquals([
      identity.accounts.capture(),
      identity.signing.capture(),
      identity.acl.capture(),
    ], before);
    assertEquals(identity.bootstrap.status(), { setupRequired: true });
    assertEquals(lifecycle.epoch, epoch);
  }, { scenario: setupScenario() }));

Deno.test("R06: Branding snapshots TOML before multipart; newer config and old image survive", () =>
  accountRouteFixture(async ({ config, alice, scope }) => {
    const reached = fixtureGate(scope), release = fixtureGate(scope);
    const dir = `${config.statePath}/brand`, original = "original logo bytes";
    Deno.mkdirSync(dir);
    Deno.writeTextFileSync(`${dir}/logo.svg`, original);
    const form = new FormData();
    form.set("name", "stale brand proposal");
    form.set("logo", new File(["new image bytes"], "logo.svg"));
    const raw = new Request("http://fixture/_/api/brand", {
      method: "POST",
      body: form,
      headers: { authorization: `Bearer ${(await alice()).access_token}` },
    });
    const rejected = assertRejects(
      () =>
        brandPost({
          _raw: raw,
          body: {
            form: async () => {
              reached.resolve();
              await release.promise;
              return await raw.formData();
            },
          },
          query: new URL(raw.url).searchParams,
        } as unknown as PathfinderRequest),
      HttpError,
      "HTTP 409",
    );
    const file = `${config.statePath}/config.toml`;
    const bytes = '# newer edit\n[brand]\nname="newer application owner"\n';
    try {
      await bounded(reached.promise, "branding multipart admission");
      Deno.writeTextFileSync(file, bytes);
    } finally {
      release.resolve();
      assertEquals((await rejected).status, 409);
    }
    assertEquals(Deno.readTextFileSync(file), bytes);
    assertEquals(Deno.readTextFileSync(`${dir}/logo.svg`), original);
    assertEquals(config.brandName, "original");
  }, { brand: '[brand]\nname="original"\n' }));
