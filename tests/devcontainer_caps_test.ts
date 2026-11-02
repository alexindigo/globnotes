import { assertEquals } from "@std/assert";

Deno.test("launcher and devcontainer use the same resource caps", async () => {
  const directory = new URL("../.devcontainer/", import.meta.url);
  const configText = await Deno.readTextFile(
    new URL("devcontainer.json", directory),
  );
  const config = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, ""));
  const launcher = await Deno.readTextFile(new URL("run.sh", directory));
  const declaration = launcher.match(/^DEV_CAPS=\(([^)]+)\)$/m);
  if (!declaration) throw new Error("Missing DEV_CAPS declaration in run.sh");
  assertEquals(
    declaration[1].trim().split(/\s+/).sort(),
    config.runArgs.toSorted(),
  );
  assertEquals(config.runArgs.length, 4);
});
