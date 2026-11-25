// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";

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
