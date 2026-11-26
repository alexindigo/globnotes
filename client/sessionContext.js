// SPDX-License-Identifier: LGPL-3.0-only

/** A captured context can be narrowed to a resource, a request slot, or a
 * capability. No consumer can widen it or capture replacement authority. */
export function bindContext(parent, ...targets) {
  const values = targets.map(read => read());
  const current = () => targets.every((read, i) => Object.is(read(), values[i])) && parent();
  return Object.freeze(Object.assign(current, {
    bind: (...reads) => bindContext(current, ...reads),
    assert() { if (!current()) throw retiredContext(); },
  }));
}

export function retiredContext() {
  return Object.assign(new Error("Operation belongs to a retired identity or target."), { staleIdentity: true, clientScopeRetired: true });
}

/** The app owns one projection and credential lifetime. A credential-scoped
 * config read may start without a live projection; normal transport may not.
 * Transition contexts stay current while their own projection is installed. */
export function createSessionContext({ key = () => undefined, tokens } = {}) {
  let projection = 0, credential = 0, disposed = false;
  function captureCredential() {
    const captureStorage = tokens?.capture?.();
    return bindContext(() => !disposed && (captureStorage?.() ?? true), () => credential, () => tokens?.getStoredToken());
  }
  const captureTransition = () => captureCredential().bind(() => projection);
  const capture = () => captureTransition().bind(key);
  function transport(recovery) {
    const session = key(), token = tokens?.getStoredToken();
    const current = recovery ? captureCredential() : capture();
    if (!current() || !recovery && session == null) throw retiredContext();
    return { token, current };
  }
  return Object.freeze({ capture, captureTransition, captureCredential, transport,
    advanceProjection() { projection++; return captureTransition(); },
    advanceCredential() { credential++; },
    get generation() { return projection; },
    get disposed() { return disposed; },
    dispose() { disposed = true; },
  });
}
