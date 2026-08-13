export function directoryFromTitle(title) {
  if (!title) return "";
  const i = title.lastIndexOf("/");
  return i === -1 ? "" : title.slice(0, i);
}

export function nextUntitledTitle(titles, folder) {
  const prefix = folder ? folder + "/" : "";
  let n = 0;
  let candidate = prefix + "Untitled";
  while (titles.includes(candidate)) {
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
