/** The browser unload capability has one owner; callers supply dirty state. */
export function setBeforeUnloadConfirmation(enable = true, target = window) {
  target.onbeforeunload = enable ? () => true : null;
}
