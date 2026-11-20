// SPDX-License-Identifier: LGPL-3.0-only
/** Public schema facade: no directory, observer or publisher construction. */
export {
  arrayRecordSchema,
  objectRecordSchema,
} from "./owned_record_channel.ts";
export type { RecordSchema, RecordSnapshot } from "./owned_record_channel.ts";
