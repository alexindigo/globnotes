// SPDX-License-Identifier: LGPL-3.0-only

export type Vector = Record<string, number>;
export type Peer = string;
export interface Conflict {
  id: string;
  revision: number;
  path: string | null;
  copyPath: string | null;
  peer: Peer;
  reason: string;
  state: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
}
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
  batch: number;
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
