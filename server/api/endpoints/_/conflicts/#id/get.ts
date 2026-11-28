// SPDX-License-Identifier: LGPL-3.0-only
export const operation = "public";
import { serveIndex } from "@server/catchall.ts";
export default () => serveIndex();
