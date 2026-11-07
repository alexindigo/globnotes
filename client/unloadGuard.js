/** The browser unload capability has one owner; each workflow owns its claim. */
const claims = new WeakMap();
const legacy = Symbol("legacy-unload");
function setClaim(target, owner, enable) {
  let owners = claims.get(target);
  if (!owners) claims.set(target, owners = new Set());
  if (enable) owners.add(owner); else owners.delete(owner);
  target.onbeforeunload = owners.size ? () => true : null;
}
export function setBeforeUnloadConfirmation(enable = true, target = window) {
  setClaim(target, legacy, enable);
}
export function createUnloadConfirmation(target = window) {
  const owner = Symbol("unload"); let disposed = false;
  return { set(enable) { if (!disposed) setClaim(target, owner, enable); },
    dispose() { disposed = true; setClaim(target, owner, false); } };
}
