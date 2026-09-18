import { basePath } from "./vault.js";

export function notePath(path) {
  const prefix = basePath();
  return prefix + "/" + path.split("/").map(encodeURIComponent).join("/");
}
