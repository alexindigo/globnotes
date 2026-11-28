// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { record } from "./records.ts";

/** Accept either a Fetch request or Pathfinder's body accessor. Body I/O is
 * outside the parse boundary so transport, limit and abort errors pass through. */
export async function readRequestJson(
  body: { text(): Promise<string> },
  { allowEmpty = false } = {},
): Promise<unknown> {
  const text = await body.text();
  if (allowEmpty && text === "") return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HttpError(400, "Invalid JSON request body.");
    }
    throw error;
  }
}

export async function readRequestObject(
  body: Parameters<typeof readRequestJson>[0],
) {
  const value = await readRequestJson(body);
  if (!record(value)) throw new HttpError(400, "Expected a JSON object.");
  return value;
}
