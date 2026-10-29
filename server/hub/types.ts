// SPDX-License-Identifier: LGPL-3.0-only

export type Vector = Record<string, number>;
export type Peer = "local" | "globnotes";
export interface FileState {
  key: string;
  diskPath: string;
  hash: string;
  size: number;
  mtimeMs: number;
  vector: Vector;
  seq: number;
}
export type Observation = Omit<FileState, "vector" | "seq">;
export interface ChangeEntry {
  seq: number;
  path: string | null;
  pathKey: string;
  kind: "created" | "modified" | "deleted" | "renamed";
  oldPath: string | null;
  oldPathKey: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  peer: Peer;
  origin: string | null;
  at: string;
}
export interface Mutation {
  path: string;
  file?: Observation;
  oldPath?: string;
}
export interface Collision {
  key: string;
  paths: string[];
}
export interface ScanStats {
  files: number;
  hashed: number;
  symlinks: number;
  unknown: string[];
}
