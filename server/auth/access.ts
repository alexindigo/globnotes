// SPDX-License-Identifier: LGPL-3.0-only

/** v2 configured-access glue; keeps the existing account and policy gate. */
import { HttpError } from "@pathfinder/pathfinder";
import {
  AuthType,
  type GlobalConfig,
  type StoredConfig,
  StoredConfigConflict,
} from "../config.ts";
import { getEnv, hashPassword } from "../helpers.ts";
import { state } from "../state.ts";
import { checkTotpCode, LocalAuth, totpSecretFromRawKey } from "./local.ts";
import { settingsWriteGuard } from "./middleware.ts";

function conflict(message: string): never {
  throw new HttpError(409, message);
}
function revision(config = state.config): number {
  const value = config.storedConfig?.access_revision ?? 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    conflict("Invalid saved access revision; original configuration retained.");
  }
  return value as number;
}
async function contentSignature(raw: string | null): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      raw === null ? "absent-access-v1" : `present:${raw}`,
    ),
  );
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
const pinKeys = {
  mode: "GLOBNOTES_AUTH_TYPE",
  username: "GLOBNOTES_USERNAME",
  password: "GLOBNOTES_PASSWORD",
  totp: "GLOBNOTES_TOTP_KEY",
  readOnlySettings: "GLOBNOTES_READ_ONLY_SETTINGS",
  sessions: "GLOBNOTES_SECRET_KEY",
};
function pins() {
  return Object.fromEntries(
    Object.entries(pinKeys).map(([key, name]) => [key, getEnv(name)]),
  ) as Record<keyof typeof pinKeys, string>;
}
function assertPersistence(
  config: GlobalConfig,
  snapshot: ReturnType<GlobalConfig["captureStoredConfig"]>,
) {
  try {
    config.assertStoredConfigUnchanged(snapshot);
  } catch (error) {
    if (error instanceof StoredConfigConflict) {
      conflict(
        "Configuration changed; review current settings before retrying.",
      );
    }
    throw error;
  }
}
function freezeBase(value: StoredConfig): StoredConfig {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freezeBase(child as StoredConfig);
  }
  return Object.freeze(value);
}
async function captureAccessSnapshot() {
  const config = state.config, auth = state.auth, lifecycle = state.lifecycle;
  const epoch = lifecycle?.epoch, stored = JSON.stringify(config.storedConfig);
  const authType = config.authType, setupRequired = config.setupRequired;
  const capturedPins = pins(), readOnlySettings = config.readOnlySettings;
  const settingsWritable = config.settingsWritable,
    savedRevision = revision(config);
  const persistence = config.captureStoredConfig(), raw = persistence.raw;
  let base: StoredConfig = {};
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (
        !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        JSON.stringify(parsed) !== JSON.stringify(config.storedConfig)
      ) {
        conflict(
          "Configuration changed externally; reload deployment before editing access.",
        );
      }
      base = freezeBase(parsed);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      conflict("Invalid stored configuration; original bytes retained.");
    }
  } else if (config.storedConfig !== null) {
    conflict("Stored configuration changed externally.");
  }
  const assertCurrent = () => {
    if (
      state.config !== config || state.auth !== auth ||
      state.lifecycle !== lifecycle ||
      lifecycle?.epoch !== epoch || config.authType !== authType ||
      config.setupRequired !== setupRequired ||
      JSON.stringify(config.storedConfig) !== stored ||
      revision(config) !== savedRevision ||
      JSON.stringify(pins()) !== JSON.stringify(capturedPins) ||
      config.readOnlySettings !== readOnlySettings ||
      config.settingsWritable !== settingsWritable
    ) conflict("Access settings changed while this request was pending.");
    assertPersistence(config, persistence);
  };
  const signature = await contentSignature(raw);
  assertCurrent();
  const view = {
    mode: authType === AuthType.TOTP ? "password" : authType,
    username: auth?.username ?? "",
    totpEnabled: auth?.isTotpEnabled ?? false,
    readOnlySettings,
    settingsWritable,
    revision: savedRevision,
    signature,
    lastUpdateId: config.storedConfig?.access_update_id ?? null,
    pinned: {
      mode: !!capturedPins.mode,
      username: !!capturedPins.username,
      password: !!capturedPins.password,
      totp: !!capturedPins.totp,
      readOnlySettings: !!capturedPins.readOnlySettings,
      sessions: !!capturedPins.sessions,
    },
  };
  return { view, base, persistence, config, auth, assertCurrent };
}
export async function accessView() {
  return (await captureAccessSnapshot()).view;
}
export async function updateAccess(
  req: Request,
  input: unknown,
  admittedGuard?: () => void,
) {
  const guard = admittedGuard ?? await settingsWriteGuard(req);
  guard();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(422, "Access settings require an object.");
  }
  const data = input as Record<string, unknown>;
  if (
    typeof data.mode !== "string" ||
    !["password", "none", "read_only"].includes(data.mode)
  ) {
    throw new HttpError(422, "Invalid access mode.");
  }
  const fields = [
    "mode",
    "username",
    "password",
    "totpEnabled",
    "totpKey",
    "totpCode",
    "readOnlySettings",
    "revision",
    "signature",
    "currentPassword",
    "currentTotp",
    "updateId",
  ];
  if (Object.keys(data).some((key) => !fields.includes(key))) {
    throw new HttpError(422, "Unsupported access setting.");
  }
  for (
    const key of [
      "username",
      "password",
      "totpKey",
      "totpCode",
      "currentPassword",
      "currentTotp",
      "signature",
    ]
  ) {
    if (data[key] !== undefined && typeof data[key] !== "string") {
      throw new HttpError(422, `${key} must be text.`);
    }
  }
  for (const key of ["totpEnabled", "readOnlySettings"]) {
    if (data[key] !== undefined && typeof data[key] !== "boolean") {
      throw new HttpError(422, `${key} must be a boolean.`);
    }
  }
  if (
    data.updateId !== undefined &&
    (typeof data.updateId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(data.updateId))
  ) throw new HttpError(422, "Invalid access update identity.");
  const snapshot = await captureAccessSnapshot(), before = snapshot.view;
  if (
    data.revision !== before.revision || data.signature !== before.signature
  ) {
    conflict(
      "Access settings changed; review current configuration before retrying.",
    );
  }
  const { auth, config } = snapshot;
  const protectedMode = data.mode === "password";
  const enabled = protectedMode &&
    (data.totpEnabled ?? before.totpEnabled) === true;
  const mode = protectedMode
    ? enabled ? AuthType.TOTP : AuthType.PASSWORD
    : data.mode === "none"
    ? AuthType.NONE
    : AuthType.READ_ONLY;
  const username = protectedMode
    ? ((data.username as string | undefined) ?? before.username).trim()
      .toLowerCase()
    : before.username;
  const password = data.password as string | undefined;
  const newKey = data.totpKey as string | undefined;
  if (protectedMode && (!username || (!auth && !password))) {
    throw new HttpError(
      400,
      "Username and password are required to create password protection.",
    );
  }
  if (password !== undefined && !password) {
    throw new HttpError(
      400,
      "A new password cannot be empty; omit it to keep the current password.",
    );
  }
  if (
    (!enabled && (newKey !== undefined || data.totpCode !== undefined)) ||
    (newKey === "")
  ) throw new HttpError(422, "Invalid authenticator enrolment.");
  if (enabled && (!before.totpEnabled || newKey !== undefined)) {
    if (
      !newKey || !/^\d{6}$/.test(String(data.totpCode ?? "")) ||
      !checkTotpCode(String(data.totpCode), totpSecretFromRawKey(newKey))
    ) {
      throw new HttpError(
        400,
        "Confirm the new authenticator with its current six-digit code before changing access.",
      );
    }
  }
  const securityChanged = protectedMode &&
    (!auth || username !== before.username || password !== undefined ||
      enabled !== before.totpEnabled || newKey !== undefined);
  const readOnlySettings = data.readOnlySettings ??
    (before.mode === "none"
      ? before.readOnlySettings
      : data.mode === "none"
      ? true
      : before.readOnlySettings);
  if (before.pinned.mode && mode !== config.authType) {
    conflict("Access mode is pinned by GLOBNOTES_AUTH_TYPE.");
  }
  if (before.pinned.username && username !== before.username) {
    conflict("Username is pinned by GLOBNOTES_USERNAME.");
  }
  if (before.pinned.password && password !== undefined) {
    conflict("Password is pinned by GLOBNOTES_PASSWORD.");
  }
  if (
    before.pinned.totp &&
    (enabled !== before.totpEnabled || newKey !== undefined) && protectedMode
  ) conflict("Authenticator is pinned by GLOBNOTES_TOTP_KEY.");
  if (
    before.pinned.readOnlySettings &&
    readOnlySettings !== before.readOnlySettings
  ) conflict("Read-only settings is pinned by GLOBNOTES_READ_ONLY_SETTINGS.");
  if (securityChanged && before.pinned.sessions) {
    conflict(
      "Session signing key is pinned by GLOBNOTES_SECRET_KEY; change credentials in deployment configuration.",
    );
  }
  const newHash = password !== undefined
    ? await hashPassword(password)
    : undefined;
  const commit = async () => {
    guard();
    snapshot.assertCurrent();
    if (auth) {
      if (typeof data.currentPassword !== "string") {
        throw new HttpError(
          401,
          "Confirm your current password and authenticator before changing access.",
        );
      }
      try {
        await auth.confirmCredentials(
          data.currentPassword,
          data.currentTotp as string | undefined,
        );
      } catch {
        throw new HttpError(
          401,
          "Current password or authenticator confirmation failed.",
        );
      }
    }
    guard();
    snapshot.assertCurrent();
    const next: StoredConfig = {
      ...snapshot.base,
      auth_type: mode,
      read_only_settings: readOnlySettings as boolean,
      access_revision: before.revision + 1,
      access_update_id: data.updateId as string | undefined ??
        crypto.randomUUID(),
    };
    if (protectedMode) {
      if (!auth || data.username !== undefined) next.username = username;
      if (newHash !== undefined) next.password_hash = newHash;
      if (enabled && newKey !== undefined) next.totp_key = newKey;
      if (securityChanged) {
        next.secret_key = [...crypto.getRandomValues(new Uint8Array(32))].map((
          byte,
        ) => byte.toString(16).padStart(2, "0")).join("");
      }
    }
    try {
      config.saveStoredConfig(next, snapshot.persistence);
    } catch (error) {
      if (error instanceof StoredConfigConflict) {
        conflict("Configuration changed before access commit.");
      }
      throw error;
    }
    const authorizationChanged = config.authType !== mode || securityChanged;
    const previouslyWritable = config.authType !== AuthType.READ_ONLY;
    config.authType = mode;
    config.setupRequired = false;
    state.auth = protectedMode
      ? securityChanged ? new LocalAuth(config) : auth
      : null;
    if (state.auth?.isTotpEnabled && securityChanged) {
      state.auth.markTotpUsed(
        newKey !== undefined ? String(data.totpCode) : String(data.currentTotp),
      );
    }
    if (authorizationChanged) state.lifecycle?.bumpEpoch();
    if (previouslyWritable !== (mode !== AuthType.READ_ONLY)) {
      state.plugins?.runtime?.suspend();
      state.plugins?.stop();
    }
    state.lifecycle?.notifyInvalidation();
    return {
      view: await accessView(),
      requiresLogin: protectedMode && securityChanged,
    };
  };
  const result = state.lifecycle
    ? await state.lifecycle.gate.run(commit)
    : await commit();
  // Settings-only locking leaves unrelated plugin owners intact.
  if (before.mode !== data.mode) await state.plugins?.runtime?.reconcile();
  return result;
}
