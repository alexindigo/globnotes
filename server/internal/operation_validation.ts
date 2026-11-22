// SPDX-License-Identifier: LGPL-3.0-only
let current: object | undefined;
const active = new WeakSet<object>();
const origins = new WeakMap<object, object>();
export function withOperationValidation<T>(
  context: object | undefined,
  run: () => T,
): T {
  const previous = current;
  current = context;
  try {
    return run();
  } finally {
    current = previous;
  }
}
/** Only this native check receives the context. Callbacks and nested public
 * checks cannot implicitly inherit it, and a retained token expires on return. */
export function operationValidation<T>(
  run: (context: object | undefined) => T,
): T {
  const origin = current;
  const context = origin ? Object.freeze({}) : undefined;
  if (context && origin) origins.set(context, origin);
  return withOperationValidation(undefined, () => {
    if (context) active.add(context);
    try {
      return run(context);
    } finally {
      if (context) active.delete(context);
    }
  });
}
export function activeOperationValidation(context: object): boolean {
  return active.has(context);
}
/** A fresh check identity cannot be replayed during a later check of the same
 * publication set. Only the matching layer resolves its private origin. */
export function operationValidationOrigin(context: object): object | undefined {
  return active.has(context) ? origins.get(context) : undefined;
}
