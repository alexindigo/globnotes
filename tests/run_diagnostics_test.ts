import { assertEquals, assertStringIncludes } from "@std/assert";
import { command } from "./helpers/process.ts";

// Exercise launcher orchestration without nesting real engines. Real Chromium
// startup/cleanup is also checked through run.sh in the release verification.
const engine = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CALLS"
case "$*" in
    --version) printf 'podman version test\\n' ;;
    info*) printf 'true\\n' ;;
    'image inspect '*)
        if [[ "$FAIL_STEP" == build-dev-image ]]; then exit 1; fi
        if [[ "$FAIL_STEP" == inspect-dev-image && -e "$FAKE_SEEN" ]]; then
            printf 'inspection denied\\n' >&2; exit 42
        fi
        touch "$FAKE_SEEN"
        printf '{}\\n' ;;
    build*) printf 'build rejected\\n' >&2; exit 42 ;;
    'network exists '*) exit 0 ;;
    'inspect --format '*) printf '10.0.0.2\\n' ;;
    inspect*) printf '{}\\n' ;;
    run*)
        if [[ "$*" == *globnotes-chromium* && "$*" == *--rm* ]]; then
            printf 'browser would lose its logs\\n' >&2; exit 99
        fi
        if [[ "$*" != *--detach* && "$FAIL_STEP" == workload ]]; then
            printf 'workload rejected\\n' >&2; exit 42
        fi
        printf 'fake-cid\\n' ;;
    exec*)
        if [[ "$*" == *'chromium --version'* && "$FAIL_STEP" == chromium-version ]]; then
            printf 'container has exited\\n' >&2; exit 42
        fi
        if [[ "$*" == *'deno eval'* && "$FAIL_STEP" == chromium-cdp-readiness ]]; then
            printf 'CDP unavailable\\n' >&2; exit 42
        fi ;;
    logs*) printf 'retained Chromium crash diagnosis\\n' ;;
    stop*|rm*) exit 0 ;;
    *) printf 'unexpected fake command: %s\\n' "$*" >&2; exit 98 ;;
esac
`;

for (
  const [step, message, browser] of [
    ["inspect-dev-image", "inspection denied", false],
    ["build-dev-image", "build rejected", false],
    ["workload", "workload rejected", false],
    ["chromium-version", "container has exited", true],
    ["chromium-cdp-readiness", "CDP unavailable", true],
  ] as const
) {
  Deno.test(`launcher diagnoses ${step} and retains logs`, async () => {
    const root = await Deno.makeTempDir({ prefix: "launcher-diagnostics-" });
    try {
      await Deno.mkdir(`${root}/.devcontainer/chromium`, { recursive: true });
      await Deno.mkdir(`${root}/bin`);
      for (const file of ["run.sh", "Dockerfile", "chromium/Dockerfile"]) {
        await Deno.copyFile(
          new URL(`../.devcontainer/${file}`, import.meta.url),
          `${root}/.devcontainer/${file}`,
        );
      }
      await Deno.writeTextFile(`${root}/bin/podman`, engine, { mode: 0o755 });
      const result = await command("bash", {
        args: [
          `${root}/.devcontainer/run.sh`,
          ...(browser ? ["--browser"] : []),
          "--run-dir",
          `${root}/run`,
          "--",
          "true",
        ],
        env: {
          PATH: `${root}/bin:${Deno.env.get("PATH")}`,
          GLOBNOTES_CONTAINER_ENGINE: "podman",
          FAIL_STEP: step,
          FAKE_CALLS: `${root}/calls`,
          FAKE_SEEN: `${root}/seen`,
        },
      }).output();
      assertEquals(result.code, 42);
      const stderr = new TextDecoder().decode(result.stderr);
      assertStringIncludes(stderr, `step=${step} failed (exit 42)`);
      assertStringIncludes(stderr, "last 80 lines of");
      assertStringIncludes(stderr, message);
      if (browser) {
        assertStringIncludes(stderr, "retained Chromium crash diagnosis");
        assertStringIncludes(
          await Deno.readTextFile(`${root}/run/logs/chromium.log`),
          "retained Chromium crash diagnosis",
        );
        const calls = (await Deno.readTextFile(`${root}/calls`)).split("\n");
        const logs = calls.findIndex((line) => line.startsWith("logs "));
        const remove = calls.findIndex((line) =>
          line.startsWith("rm --force ")
        );
        assertEquals(logs >= 0 && remove > logs, true);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
