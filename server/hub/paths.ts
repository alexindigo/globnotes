// SPDX-License-Identifier: LGPL-3.0-only
import { createHmac } from "node:crypto";
import * as path from "@std/path";

export const pathKey = (value: string): string => value.normalize("NFC");
export function anonymousPath(secret: string, value: string): string {
  return createHmac(
    "sha256",
    new Uint8Array(secret.match(/../g)!.map((v) => parseInt(v, 16))),
  ).update(pathKey(value)).digest("hex");
}
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.SEPARATOR}`) &&
      !path.isAbsolute(relative));
}
