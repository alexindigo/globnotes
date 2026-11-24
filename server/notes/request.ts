// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { readRequestObject } from "../auth/request_json.ts";
import { parseBase, parseOnStale } from "../hub/gate.ts";
import type { NoteCreate, NoteUpdate } from "./models.ts";
import { validateNotePath } from "./validate.ts";

type Body = Parameters<typeof readRequestObject>[0];
function optionalText(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  throw new HttpError(400, `${field} must be a string or null`);
}

export async function readNoteCreate(body: Body): Promise<NoteCreate> {
  const { path, content } = await readRequestObject(body);
  return {
    path: validateNotePath(path, "path"),
    content: optionalText(content, "content"),
  };
}

export async function readNoteUpdate(body: Body): Promise<NoteUpdate> {
  const {
    newPath,
    newContent,
    baseContent,
    base: inputBase,
    onStale: inputOnStale,
  } = await readRequestObject(body);
  if (baseContent !== undefined && typeof baseContent !== "string") {
    throw new HttpError(400, "baseContent must be a string");
  }
  if (inputBase !== undefined && baseContent !== undefined) {
    throw new HttpError(400, "pass either base or baseContent");
  }
  let base, onStale;
  try {
    base = inputBase === undefined ? undefined : parseBase(inputBase);
    onStale = parseOnStale(inputOnStale);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  return {
    newPath: newPath == null ? newPath : validateNotePath(newPath, "newPath"),
    newContent: optionalText(newContent, "newContent"),
    baseContent,
    base,
    onStale,
  };
}
