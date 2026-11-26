// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { HttpError } from "@pathfinder/pathfinder";
import { AuthType } from "../server/config.ts";
import { brandBlock } from "../server/brand.ts";
import { AccountRepository } from "../server/auth/accounts.ts";
import {
  InstanceSessions,
  SessionRepository,
} from "../server/auth/sessions.ts";
import {
  createIdentityComposition,
  identityServiceEligibility,
} from "../server/auth/composition.ts";
import { PluginLifecycle } from "../server/plugins/lifecycle.ts";
import { createIdentityProjections } from "../server/auth/projection.ts";
import { readAuthorityState } from "../server/auth/authority_context.ts";
import { OperationError } from "../server/plugins/errors.ts";
import { OwnershipError } from "../shared/ownership.js";
import { withIdentityComposition } from "./helpers/identity_scope.ts";
import { resetFixturePassword } from "./helpers/account_preparation.ts";
import { identityFixture, VAULT_A } from "./helpers/identity.ts";
import { fixturePage } from "./helpers/plugin_fixture.ts";

const NEXT_UPDATE = "00000000-0000-4000-8000-000000000016";
type Scope = Parameters<Parameters<typeof withIdentityComposition>[0]>[0];
const json = async (response: Promise<Response>) =>
  await (await response).json();
const guestRequest = () => new Request("http://globnotes.test/_/api/status");

function expectedStatus(f: Scope, capabilities: {
  canRead: boolean;
  canEdit: boolean;
  canManageVault: boolean;
}) {
  const principal = f.token.principal;
  return {
    version: "fixture",
    revision: "fixture-revision",
    setupRequired: false,
    principal: {
      kind: "account",
      id: f.alice.id,
      login: "alice",
      totpEnabled: false,
      passwordChangeRequired: false,
      expiresAt: principal.expiresAt,
    },
    accountId: f.alice.id,
    sessionGeneration:
      `${principal.credentialRevision}:${principal.signingRevision}:${principal.expiresAt}`,
    vaultId: capabilities.canRead ? VAULT_A : null,
    authorityRevision: capabilities.canRead
      ? `${f.acl.revision}:${f.operations.lifecycle.epoch}`
      : null,
    capabilities: {
      ...capabilities,
      canManageOwnAccount: true,
      canCreateVault: true,
    },
  };
}

Deno.test("identity projections: View config and catalog are allowlisted reader values", () =>
  withIdentityComposition(async (f) => {
    f.policy("view");
    const config = f.operations.config;
    const response = await f.composition.responses.config(f.request());
    const text = await response.text();
    assertEquals(JSON.parse(text), {
      ...expectedStatus(f, {
        canRead: true,
        canEdit: false,
        canManageVault: false,
      }),
      storageDurability: config.storageDurability,
      quickAccessHide: config.quickAccessHide,
      quickAccessTitle: config.quickAccessTitle,
      quickAccessTerm: config.quickAccessTerm,
      quickAccessSort: config.quickAccessSort,
      quickAccessLimit: config.quickAccessLimit,
      brand: JSON.parse(JSON.stringify(brandBlock(config))),
    });
    assertEquals(text.includes(f.token.access_token), false);
    const [listed] = f.operations.manager.listPlugins();
    const catalog = await json(f.composition.responses.catalog(f.request()));
    assertEquals(catalog.plugins, [{
      id: "projection",
      name: listed.name,
      version: listed.version,
      enabled: true,
      client: false,
      runtime: { client: false },
      rendering: false,
      commands: [{
        id: "write",
        label: "Background write",
        target: "server",
        pluginId: "projection",
        fullId: "plugin:projection:write",
      }, {
        id: "settle-action",
        label: "Settle action",
        target: "server",
        pluginId: "projection",
        fullId: "plugin:projection:settle-action",
      }],
    }]);
    f.policy("admin");
    const admin = await json(f.composition.responses.catalog(f.request()));
    assertEquals(
      admin.plugins.map((p: { pages: { id: string }[] }) =>
        p.pages.map((page) => page.id)
      ),
      [[fixturePage.id]],
    );
  }));

for (const level of ["view", "admin"] as const) {
  Deno.test(`identity projections: ${level} catalog uses its reported policy revision`, () =>
    withIdentityComposition(async (f) => {
      f.policy(level);
      const { policy } = f.operations.manager;
      const read = policy.read.bind(policy);
      const before = await read();
      let replaced = false;
      policy.read = async () => {
        const snapshot = await read();
        if (!replaced) {
          // Commit after capture but before the catalog derives its entries.
          replaced = true;
          await policy.setEnabled("projection", false, snapshot.metadata);
        }
        return snapshot;
      };
      const catalog = async () => {
        const { policy, plugins } = await json(
          f.composition.responses.catalog(f.request()),
        );
        return [
          policy.revision,
          plugins.map(({ id, enabled }: { id: string; enabled: boolean }) => [
            id,
            enabled,
          ]),
        ];
      };
      assertEquals([await catalog(), await catalog()], [
        [before.metadata.revision, [["projection", true]]],
        [
          before.metadata.revision + 1,
          level === "view" ? [] : [["projection", false]],
        ],
      ]);
    }));
}

Deno.test("identity projections: explicit None keeps own-account status but no vault metadata or catalog", () =>
  withIdentityComposition(async (f) => {
    f.policy("none");
    assertEquals(await json(f.composition.responses.config(f.request())), {
      ...expectedStatus(f, {
        canRead: false,
        canEdit: false,
        canManageVault: false,
      }),
      storageDurability: f.operations.config.storageDurability,
    });
    const error = await assertRejects(
      () => f.composition.responses.catalog(f.request()),
      HttpError,
      "HTTP 403",
    );
    assertEquals([error.status, error.detail], [
      403,
      "This account cannot perform that operation.",
    ]);
    // A guest without Everybody else access sees no vault binding either.
    f.policy("admin", "none");
    const guest = await json(f.composition.responses.status(guestRequest()));
    assertEquals([guest.principal, guest.vaultId, guest.capabilities], [
      { kind: "guest" },
      null,
      {
        canRead: false,
        canEdit: false,
        canManageVault: false,
        canManageOwnAccount: false,
        canCreateVault: false,
      },
    ]);
  }));

Deno.test("identity projections: None response needs no vault lease but ends with credential retirement", () =>
  withIdentityComposition(async (f) => {
    f.policy("none");
    const survives = await f.composition.responses.status(f.request());
    const retired = await f.composition.responses.status(f.request());
    // A later vault grant does not fence an instance-only None response.
    f.policy("view");
    assertEquals(
      (await survives.json()).vaultId,
      null,
    );
    f.policy("none");
    const pending = await f.composition.responses.status(f.request());
    await resetFixturePassword(
      f.accounts,
      f.alice.id,
      "replacement",
      NEXT_UPDATE,
    );
    const outcomes = [];
    for (const response of [pending, retired]) {
      const reader = response.body!.getReader();
      const error = await assertRejects(
        () => reader.read(),
        HttpError,
        "HTTP 401",
      );
      outcomes.push([error.status, error.detail]);
    }
    assertEquals(outcomes, [
      [401, "Invalid authentication credentials."],
      [401, "Invalid authentication credentials."],
    ]);
  }));

Deno.test("identity projections: reader response is fenced by demotion and composition retirement", () =>
  withIdentityComposition(async (f) => {
    f.policy("view");
    const demoted = await f.composition.responses.config(f.request());
    const retired = await f.composition.responses.status(f.request());
    f.policy("none");
    const demotedReader = demoted.body!.getReader();
    const error = await assertRejects(
      () => demotedReader.read(),
      OperationError,
      "Access policy changed while this operation was pending; it was not applied.",
    );
    assertEquals(error.status, 409);
    f.policy("view");
    f.lifetime.retire();
    const retiredReader = retired.body!.getReader();
    await assertRejects(
      () => retiredReader.read(),
      OwnershipError,
      "Owner is retired",
    );
    await assertRejects(
      () => f.composition.responses.status(f.request()),
      OwnershipError,
      "Owner is retired",
    );
  }));

Deno.test("identity projections: an instance admission never gains vault fields during preparation", () =>
  withIdentityComposition(async (f) => {
    const config = f.operations.config;
    const projections = createIdentityProjections({
      sessions: f.sessions,
      config,
      plugins: () => f.operations.manager,
      setupStatus: () => ({ setupRequired: false }),
      release: { version: "fixture", revision: "fixture-revision" },
    });
    f.policy("none");
    const admission = await f.composition.auth.statusAdmission(f.request());
    assertEquals(admission.scope, "instance");
    f.policy("view");
    assertEquals(
      f.composition.authority.capabilities(f.token.principal).canRead,
      true,
    );
    const response = new Response(
      admission.lease.body(
        admission.lease.prepare(projections.config(admission)),
      ),
    );
    f.policy("none");
    assertEquals(await response.json(), {
      ...expectedStatus(f, {
        canRead: false,
        canEdit: false,
        canManageVault: false,
      }),
      storageDurability: config.storageDurability,
    });
  }));

Deno.test("identity composition: View and None callers do not retire approved background service authority", () =>
  withIdentityComposition(async (f) => {
    // The explicit instance service input supersedes the legacy mode bridge.
    f.operations.config.authType = AuthType.READ_ONLY;
    const outcomes = [];
    for (const level of ["view", "none"] as const) {
      f.policy(level);
      const capabilities = f.composition.authority.capabilities(
        f.token.principal,
      );
      const receipt = await f.operations.command(
        "write",
        `background-${level}`,
      ) as { requestId: string };
      const settled = await f.operations.command(
        "settle-action",
        receipt.requestId,
      ) as { status: string };
      outcomes.push([
        level,
        capabilities.canEdit,
        f.composition.lifecycle.writable(),
        settled.status,
        Deno.readTextFileSync(`${f.fixture.vault}/background-${level}.md`),
      ]);
    }
    assertEquals(outcomes, [
      ["view", false, true, "completed", "service-owned"],
      ["none", false, true, "completed", "service-owned"],
    ]);
    assertEquals(f.operations.runtime.status("projection")?.status, "ready");
  }));

Deno.test("identity composition: service eligibility reads no uninitialized instance into existence", () =>
  identityFixture((root) => {
    const accounts = new AccountRepository(`${root}/identity`);
    const signing = new SessionRepository(accounts.root);
    const eligibility = identityServiceEligibility(
      new InstanceSessions(accounts, signing, { expirySeconds: 1000 }),
    );
    assertEquals([
      readAuthorityState(eligibility.operational),
      readAuthorityState(eligibility.writable),
    ], [
      false,
      false,
    ]);
    assertEquals(
      [...Deno.readDirSync(root)].map((entry) => entry.name),
      [],
    );
  }));

Deno.test("identity composition: a borrowed lifecycle must use its instance's readiness", () =>
  withIdentityComposition((f) => {
    const config = f.operations.config;
    const adapters = {
      sessions: f.sessions,
      acl: f.acl,
      vaultId: VAULT_A,
      config,
      cookieName: "identity",
      lifetime: f.lifetime.lease,
      plugins: () => f.operations.manager,
      setupStatus: () => ({ setupRequired: false }),
      release: { version: null, revision: null },
    };
    for (
      const lifecycle of [
        new PluginLifecycle(config),
        new PluginLifecycle(
          config,
          identityServiceEligibility(
            new InstanceSessions(f.accounts, f.signing, {
              expirySeconds: 1000,
            }),
          ),
        ),
      ]
    ) {
      assertThrows(
        () => createIdentityComposition({ ...adapters, lifecycle }),
        TypeError,
        "Plugin lifecycle belongs to another identity owner.",
      );
    }
    assertEquals(
      createIdentityComposition({
        ...adapters,
        lifecycle: f.operations.lifecycle,
      })
        .lifecycle === f.operations.lifecycle,
      true,
    );
  }));
