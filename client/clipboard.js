// SPDX-License-Identifier: LGPL-3.0-only

/** Copy literal text from a user gesture without changing focus or selection. */
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  let written = false;
  const copy = (event) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    written = true;
  };
  document.addEventListener("copy", copy, { capture: true });
  try {
    if (!document.execCommand("copy") || !written) {
      throw Error("Clipboard copy is unavailable");
    }
  } finally {
    document.removeEventListener("copy", copy, { capture: true });
  }
}
