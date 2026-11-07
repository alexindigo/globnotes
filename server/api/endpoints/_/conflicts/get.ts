// SPDX-License-Identifier: LGPL-3.0-only
import { serveIndex } from "@server/catchall.ts";
export const auth = false;
export default () => serveIndex();
