// Vitest setup: Node 26 has a built-in (getter-only, disabled without
// --localstorage-file) global localStorage that shadows jsdom's. Replace it
// with a simple in-memory implementation good enough for tests.
const makeStorage = () => {
  const data = new Map();
  return {
    getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
    setItem: (k, v) => data.set(String(k), String(v)),
    removeItem: (k) => data.delete(String(k)),
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
};

Object.defineProperty(globalThis, "localStorage", {
  value: makeStorage(),
  configurable: true,
  writable: true,
});
