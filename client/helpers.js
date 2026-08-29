export function directoryFromPath(path) {
  if (!path) return "";
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function nextUntitledPath(paths, folder) {
  const prefix = folder ? folder + "/" : "";
  let n = 1;
  let candidate = prefix + "Untitled";
  while (paths.includes(candidate)) {
    n++;
    candidate = prefix + "Untitled " + n;
  }
  return candidate;
}

export function getToastOptions(description, title, severity) {
  return {
    summary: title,
    detail: description,
    severity: severity,
    closable: false,
    life: 5000,
  };
}
