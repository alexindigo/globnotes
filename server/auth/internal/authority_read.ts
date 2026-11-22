// SPDX-License-Identifier: LGPL-3.0-only
const readers = new WeakMap<object, (context: object | undefined) => unknown>();
export function registerAuthorityReader<T>(
  owner: object,
  read: (context: object | undefined) => T,
): void {
  if (readers.has(owner)) {
    throw new TypeError("Authority reader already bound.");
  }
  readers.set(owner, read);
}
export function authorityRead<T>(
  owner: object,
  context: object | undefined,
): T {
  const read = readers.get(owner);
  if (!read) throw new TypeError("Authority requires an issued reader.");
  return read(context) as T;
}
