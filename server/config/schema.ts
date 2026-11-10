// SPDX-License-Identifier: LGPL-3.0-only
import { parseAllowedHosts } from "../host_admission.ts";

export type Value = string | number | boolean | string[];
export interface Tree {
  [key: string]: Value | Tree;
}
export interface Leaf {
  type: "string" | "integer" | "number" | "boolean" | "list";
  valid?: (value: Value) => boolean;
}
export interface Schema {
  [key: string]: Leaf | Schema;
}
const positiveInteger: Leaf = { type: "integer", valid: (v) => Number(v) > 0 };
const nonnegative: Leaf = { type: "number", valid: (v) => Number(v) >= 0 };

/** Types and constraints only. Every baseline value belongs to shipped TOML. */
export const INSTANCE_SCHEMA: Schema = {
  server: {
    host: { type: "string", valid: (v) => String(v).length > 0 },
    port: {
      type: "integer",
      valid: (v) => Number(v) >= 0 && Number(v) <= 65535,
    },
    pathprefix: {
      type: "string",
      valid: (v) =>
        v === "" || (String(v).startsWith("/") && !String(v).endsWith("/")),
    },
    allowedhosts: {
      type: "list",
      valid: (v) => {
        try {
          parseAllowedHosts((v as string[]).join(","));
          return true;
        } catch {
          return false;
        }
      },
    },
  },
  vaults: {
    basepath: { type: "string", valid: (v) => String(v).trim().length > 0 },
  },
  metadata: { path: { type: "string" } },
  index: {
    batchsize: positiveInteger,
    batchdelay: nonnegative,
    scancachettl: nonnegative,
  },
  hub: { scaninterval: { type: "number", valid: (v) => Number(v) > 0 } },
  plugins: { renderworkers: positiveInteger },
  sessions: { expirydays: positiveInteger },
  log: {
    level: {
      type: "string",
      valid: (v) => ["DEBUG", "INFO", "WARNING", "ERROR"].includes(String(v)),
    },
  },
  mcp: {
    enabled: { type: "boolean" },
    ratelimit: { type: "integer", valid: (v) => Number(v) >= 0 },
  },
};

export interface InstanceConfig {
  server: {
    host: string;
    port: number;
    pathprefix: string;
    allowedhosts: string[];
  };
  vaults: { basepath: string };
  metadata: { path: string };
  index: { batchsize: number; batchdelay: number; scancachettl: number };
  hub: { scaninterval: number };
  plugins: { renderworkers: number };
  sessions: { expirydays: number };
  log: { level: string };
  mcp: { enabled: boolean; ratelimit: number };
}
