// SPDX-License-Identifier: LGPL-3.0-only
import { HttpError } from "@pathfinder/pathfinder";
import { file_not_found, invalid_file_path } from "../api_messages.ts";
import type { VaultAuthorityLease } from "../auth/authority.ts";
import {
  type InstanceAuth,
  protectVaultResponse,
} from "../auth/http_policy.ts";
import {
  FileNotFoundError,
  type FileServing,
  type ServedFile,
  ValueError,
} from "./file_serving.ts";

export function servedFileResponse(
  served: ServedFile,
  request: Request,
  lease?: VaultAuthorityLease,
): Response {
  const headers = { "content-type": served.mediaType, ...served.headers };
  const response = new Response(
    request.method === "HEAD" ? null : served.body as BodyInit,
    { headers },
  );
  if (served.downloadName !== null) {
    response.headers.set(
      "content-disposition",
      `attachment; filename="${served.downloadName}"`,
    );
  }
  return lease ? protectVaultResponse(lease, response) : response;
}
export function createIdentityFileGet(auth: InstanceAuth, files: FileServing) {
  return async (request: Request, path: string) => {
    const lease = await auth.readLease(request);
    try {
      return servedFileResponse(
        files.get(path, lease.assertCurrent),
        request,
        lease,
      );
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        throw new HttpError(404, file_not_found);
      }
      if (error instanceof ValueError) {
        throw new HttpError(400, invalid_file_path);
      }
      throw error;
    }
  };
}
