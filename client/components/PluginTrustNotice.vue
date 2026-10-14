<!-- SPDX-License-Identifier: LGPL-3.0-only -->
<template>
  <aside class="rounded border border-theme-border bg-theme-background-elevated p-3 text-sm text-theme-text" data-plugin-trust-notice>
    <p><strong>These permission controls apply to sandboxed server Workers only.</strong></p>
    <p class="mt-1">Browser/editor plugin code runs as trusted same-origin application code and is not restricted by these host approvals or Allow network. Browser network loads from rendered content are also outside these controls.</p>
    <details class="mt-2 text-theme-text-muted">
      <summary class="cursor-pointer">Trusted code and filesystem access</summary>
      <p class="mt-1">Trusted browser code can exercise your application authority. These controls do not cryptographically attest a human gesture against that code. Privileged legacy filesystem grants remain a separate trust boundary.</p>
    </details>
  </aside>
</template>
