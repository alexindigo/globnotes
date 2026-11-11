// Test-owned metadata layout. State consumers receive the per-vault directory.
import { dirname, resolve } from "node:path";
export function metadataBase(vault, state) {
  if (resolve(state) === resolve(vault, ".globnotes")) return "";
  if (!state.endsWith("/globnotes")) throw Error("Fixture state must be <metadata base>/globnotes");
  return dirname(state);
}
export async function metadataDirectory(options) {
  const state = `${await Deno.makeTempDir(options)}/globnotes`;
  await Deno.mkdir(state);
  return state;
}
