// Deliberately broken producers in fresh guest copies must fail real consumers.
import { assert } from "./test-outcomes.mjs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const artifacts = Deno.env.get("GLOBNOTES_E2E_ARTIFACTS") ?? await Deno.makeTempDir({ prefix: "globnotes-unit-controls-" });
await Deno.mkdir(artifacts, { recursive: true, mode: 0o700 });
// The unit controls need client configuration and source, not a live checkout
// snapshot. In particular Vite's temporary config files are not inputs.
const configuration = ["deno.json", "deno.lock", "vitest.config.mjs", "tailwind.config.js"];
const sourceTrees = ["client", "shared"];
const sourceExtensions = /\.(?:js|ts|vue|json|css|html|svg|png|ico|otf|ttf)$/;

async function copyUnitControlSources(source, destination) {
  async function copyFile(relative) {
    if (!(await Deno.lstat(`${source}/${relative}`)).isFile) throw Error(`Not a source file: ${relative}`);
    await Deno.copyFile(`${source}/${relative}`, `${destination}/${relative}`);
  }
  async function copyTree(relative) {
    if (!(await Deno.lstat(`${source}/${relative}`)).isDirectory) throw Error(`Not a source directory: ${relative}`);
    await Deno.mkdir(`${destination}/${relative}`);
    for await (const entry of Deno.readDir(`${source}/${relative}`)) {
      const path = `${relative}/${entry.name}`;
      if (entry.name.startsWith(".") || ["dist", "node_modules"].includes(entry.name) || path === "client/tests/e2e") continue;
      if (entry.isDirectory) await copyTree(path);
      else if (sourceExtensions.test(entry.name)) await copyFile(path);
    }
  }
  await Deno.mkdir(destination);
  for (const file of configuration) await copyFile(file);
  for (const tree of sourceTrees) await copyTree(tree);
}

const controls = [
  { name: "milkdown-action", file: "client/keybindings/editor-keymap.js", old: "return pmKeymap(bindings);", broken: "return pmKeymap({});", test: "client/tests/keybinding-conflicts.test.js", title: "Milkdown's installed layer action wins over a conflicting default without editing the document" },
  { name: "default-tab", file: "client/components/Modal.vue", old: "if (props.trapFocus && rootEl.value) {", broken: "if (rootEl.value) {", test: "client/tests/modal.test.js", title: "does not trap Tab by default" },
  { name: "discarded-hydration", file: "client/sidebarTree.js", old: "levels.value = { ...levels.value, [path]: data };", broken: "levels.value = { ...levels.value, [path]: { folders: [], notes: [] } };", test: "client/tests/sidebar-hydration.test.js", title: "loads levels for all persisted expanded folders on mount" },
];
const outcomes = [];
for (const control of controls) {
  const directory = artifacts + "/" + control.name;
  await copyUnitControlSources(root, directory);
  await Deno.symlink(root + "/node_modules", directory + "/node_modules", { type: "dir" });
  const path = directory + "/" + control.file, original = await Deno.readTextFile(path);
  assert(original.split(control.old).length === 2, control.name + ": mutation context is not unique");
  await Deno.writeTextFile(path + ".bak", original, { createNew: true });
  await Deno.writeTextFile(path, original.replace(control.old, control.broken));
  const report = directory + "/vitest-result.json";
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["task", "test:client", control.test, "--reporter=json", "--outputFile=" + report], cwd: directory,
    env: { VITEST_MAX_WORKERS: "1", NO_COLOR: "1" }, stdout: "piped", stderr: "piped",
  }).output();
  await Deno.writeFile(directory + "/stdout.log", result.stdout, { createNew: true });
  await Deno.writeFile(directory + "/stderr.log", result.stderr, { createNew: true });
  const observed = JSON.parse(await Deno.readTextFile(report));
  const failures = observed.testResults.flatMap(row => row.assertionResults).filter(row => row.status === "failed");
  assert(result.code !== 0 && failures.some(row => row.title === control.title), control.name + ": the named consumer did not reject the broken producer");
  outcomes.push({ name: control.name, code: result.code, failedConsumers: failures.map(row => row.title), preservedCopy: directory });
}
await Deno.writeTextFile(artifacts + "/controls.json", JSON.stringify(outcomes, null, 2), { createNew: true });
console.log("Broken unit producers rejected", JSON.stringify(outcomes));
