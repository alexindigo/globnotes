// SPDX-License-Identifier: LGPL-3.0-only
import { validPath } from "./crypto.js";

export async function hash(value) {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}

function root(value, invalid) {
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw invalid("Invalid remote root");
  }
  // Remotely Save normalizes outer slashes only. Interior separators and spelling
  // are meaningful; reject ambiguity rather than guessing a different namespace.
  const normalized = value.replace(/^\/+|\/+$/g, "");
  if (normalized && !validPath(normalized)) {
    throw invalid("Invalid remote root");
  }
  return normalized;
}

function address(value, invalid) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid("A remote HTTP URL is required");
  }
  if (
    !["http:", "https:"].includes(url.protocol) || url.username ||
    url.password || url.hash || url.search
  ) {
    throw invalid(
      "Remote URLs must be HTTP(S), without credentials, query or fragment",
    );
  }
  // Check before URL's dot-segment normalization can conceal traversal.
  const rawPath = value.replace(/^[a-z]+:\/\/[^/]+/i, "");
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw invalid("Invalid URL path encoding");
  }
  if (
    decoded.split("/").some((part) => part === "." || part === "..") ||
    decoded.includes("\\")
  ) throw invalid("Invalid URL path");
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url.href;
}

/** No lookup at activation: missing selected keys become SDK open():locked. */
export async function readConfiguration(ctx) {
  const invalid = (message) =>
    new ctx.driver.StorageError("invalid", { effect: "none", message });
  const needed = async (key, label) => {
    const value = await ctx.secrets.get(key);
    if (!value) {
      throw new ctx.driver.StorageError("unauthorized", {
        effect: "none",
        message: `needs ${label}`,
      });
    }
    return value;
  };
  const source = ctx.instance.settings;
  const backend = source.backend ?? "s3";
  const encryption = source.encryption ?? "none";
  if (
    !["s3", "webdav"].includes(backend) ||
    !["none", "openssl-base64", "rclone-base64"].includes(encryption)
  ) throw invalid("Unknown backend or encryption mode");
  const excluded = [
    ...new Set((source.excludedPrefixes ?? "").split(/\r?\n/).filter(Boolean)),
  ].sort();
  if (excluded.some((value) => !validPath(value, true))) {
    throw invalid("Invalid excluded prefix");
  }
  let connection, credentials;
  if (backend === "s3") {
    const endpoint = address(source.s3Endpoint ?? "", invalid);
    const bucket = source.s3Bucket ?? "";
    const region = source.s3Region ?? "us-east-1";
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      bucket.includes("..")
    ) throw invalid("Invalid S3 bucket");
    if (!/^[a-z0-9-]+$/.test(region)) throw invalid("Invalid S3 region");
    connection = {
      endpoint,
      bucket,
      region,
      prefix: root(source.s3Prefix ?? "", invalid),
      pathStyle: source.s3PathStyle ?? false,
    };
  } else {
    const url = address(source.webdavUrl ?? "", invalid);
    const auth = source.webdavAuth ?? "anonymous";
    const username = source.webdavUsername ?? "";
    if (!["anonymous", "basic", "digest"].includes(auth)) {
      throw invalid("Unknown WebDAV authentication");
    }
    if (auth !== "anonymous" && (!username || /[:\r\n]/.test(username))) {
      throw invalid("A WebDAV username without colon or newline is required");
    }
    connection = {
      url,
      baseDir: root(source.webdavBaseDir ?? "", invalid),
      auth,
      username,
    };
  }
  // Complete structural validation before any credential lookup or endpoint I/O.
  if (backend === "s3") {
    credentials = {
      accessKey: await needed("s3_access_key", "S3 access key"),
      secretKey: await needed("s3_secret_key", "S3 secret key"),
      sessionToken: await ctx.secrets.get("s3_session_token"),
    };
  } else {
    credentials = {
      password: connection.auth === "anonymous"
        ? null
        : await needed("webdav_password", "WebDAV password"),
    };
  }
  const password = encryption === "none"
    ? ""
    : await needed("encryption_password", "Encryption password");
  // Credentials, account names and auth method do not identify the remote tree.
  const identity = backend === "s3"
    ? {
      backend,
      endpoint: connection.endpoint,
      bucket: connection.bucket,
      prefix: connection.prefix,
      encryption,
    }
    : { backend, url: connection.url, baseDir: connection.baseDir, encryption };
  return {
    backend,
    encryption,
    connection,
    credentials,
    password,
    excluded,
    endpoint: {
      id: await hash(JSON.stringify(identity)),
      epoch: "remotely-save-v3-format-1",
    },
    scope: await hash(JSON.stringify(excluded)),
  };
}
