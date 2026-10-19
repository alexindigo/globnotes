<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <aside class="max-w-[65ch] text-[13px] text-theme-text-muted" data-plugin-trust-notice>
    <p>Plugins that run in the browser have full access to globnotes; these permissions limit only a plugin’s server code.</p>
    <details class="mt-2">
      <summary class="focus-ring w-fit cursor-pointer hover:text-theme-brand">Learn more</summary>
      <p class="mt-2">These permission controls apply to sandboxed server Workers only. Browser/editor plugin code runs as trusted same-origin application code and is not restricted by these host approvals or Allow network. Browser network loads from rendered content are also outside these controls.</p>
      <p class="mt-2">Trusted browser code can exercise your application authority. These controls do not cryptographically attest a human gesture against that code. Privileged legacy filesystem grants remain a separate trust boundary.</p>
    </details>
  </aside>
</template>
