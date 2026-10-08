// SPDX-License-Identifier: LGPL-3.0-only

/** Public `@globnotes/plugin-sdk` specifier — a LEAF module. Plugins
 * receive their facade instance from the host at activation; this module
 * carries only dependency-free constants so the import-map chunk never
 * duplicates app module instances (the shared-package identity rule). */

export const PLUGIN_SDK_VERSION = 1;
