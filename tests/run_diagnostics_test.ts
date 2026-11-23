import { assertEquals, assertStringIncludes } from "@std/assert";
import { command } from "./helpers/process.ts";

// Exercise launcher orchestration without nesting real engines. Real Chromium
// startup/cleanup is also checked through run.sh in the release verification.
const engine = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CALLS"
case "$*" in
    --version)
        printf 'engine version diagnostic\\n' >&2
        if [[ "$FAKE_BACKEND" == docker ]]; then printf 'Docker version test\\n';
        else printf 'podman version test\\n'; fi ;;
    'info --format json')
        if [[ "$FAIL_STEP" == prepare-engine ]]; then
            printf 'engine storage initialization rejected\\n' >&2; exit 42
        fi
        printf '{}\\n' ;;
    info*)
        case "$FAIL_STEP" in
            rootless-false) printf 'false\\n' ;;
            rootless-timeout) printf 'rootless query interrupted\\n' >&2; exit 124 ;;
            rootless-error) printf 'engine query denied\\n' >&2; exit 42 ;;
            rootless-invalid) printf 'unknown\\n' ;;
            *) printf 'true\\n' ;;
        esac ;;
    'image inspect '*)
        if [[ "$FAIL_STEP" == build-dev-image ]]; then exit 1; fi
        if [[ "$FAIL_STEP" == inspect-dev-image && -e "$FAKE_SEEN" ]]; then
            printf 'inspection denied\\n' >&2; exit 42
        fi
        touch "$FAKE_SEEN"
        printf '{}\\n' ;;
    build*) printf 'build rejected\\n' >&2; exit 42 ;;
    'network exists '*) exit 0 ;;
    'network inspect '*) exit 0 ;;
    create*)
        for kind in dev chromium; do
            if [[ "$*" == *"globnotes-prepare-$kind-"* && "$FAIL_STEP" == "prepare-$kind-image" ]]; then
                printf 'mapped storage rejected\\n' >&2; exit 42
            fi
        done
        printf 'prepared-cid\\n' ;;
    'inspect --format '*) printf '10.0.0.2\\n' ;;
    inspect*)
        for kind in dev chromium; do
            if [[ "$*" == *"globnotes-prepare-$kind-"* && "$FAIL_STEP" == "inspect-prepared-$kind-image" ]]; then
                printf 'prepared inspection rejected\\n' >&2; exit 42
            fi
        done
        printf '{}\\n' ;;
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
    rm*)
        for kind in dev chromium; do
            if [[ "$*" == *"globnotes-prepare-$kind-"* && "$FAIL_STEP" == "remove-prepared-$kind-image" ]]; then
                printf 'prepared removal rejected\\n' >&2; exit 42
            fi
        done ;;
    stop*) exit 0 ;;
    *) printf 'unexpected fake command: %s\\n' "$*" >&2; exit 98 ;;
esac
`;

for (
  const [step, message, browser] of [
    ["prepare-engine", "engine storage initialization rejected", false],
    ["inspect-dev-image", "inspection denied", false],
    ["build-dev-image", "build rejected", false],
    ["prepare-dev-image", "mapped storage rejected", false],
    ["prepare-chromium-image", "mapped storage rejected", true],
    ["inspect-prepared-dev-image", "prepared inspection rejected", false],
    ["inspect-prepared-chromium-image", "prepared inspection rejected", true],
    ["remove-prepared-dev-image", "prepared removal rejected", false],
    ["remove-prepared-chromium-image", "prepared removal rejected", true],
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
          FAKE_BACKEND: "podman",
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
      if (step === "prepare-engine") {
        const calls = (await Deno.readTextFile(`${root}/calls`)).split("\n");
        assertEquals(calls.some((line) => line.startsWith("run ")), false);
        assertEquals(calls.some((line) => line.startsWith("image ")), false);
        assertEquals(calls.filter((line) => line.startsWith("info ")), [
          "info --format json",
        ]);
      } else if (step.includes("prepare")) {
        const calls = (await Deno.readTextFile(`${root}/calls`)).split("\n");
        assertEquals(calls.some((line) => line.startsWith("run ")), false);
        assertEquals(
          calls.some((line) => line.startsWith("rm globnotes-prepare-")),
          true,
        );
      } else if (browser) {
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

for (const backend of ["podman", "docker"]) {
  for (const browser of [false, true]) {
    Deno.test(`launcher prepares mapped storage before launch: ${backend}, browser=${browser}`, async () => {
      const root = await Deno.makeTempDir({ prefix: "launcher-preparation-" });
      try {
        await Deno.mkdir(`${root}/.devcontainer/chromium`, { recursive: true });
        await Deno.mkdir(`${root}/bin`);
        for (const file of ["run.sh", "Dockerfile", "chromium/Dockerfile"]) {
          await Deno.copyFile(
            new URL(`../.devcontainer/${file}`, import.meta.url),
            `${root}/.devcontainer/${file}`,
          );
        }
        await Deno.writeTextFile(`${root}/bin/${backend}`, engine, {
          mode: 0o755,
        });
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
            GLOBNOTES_CONTAINER_ENGINE: backend,
            FAKE_BACKEND: backend,
            FAIL_STEP: "",
            FAKE_CALLS: `${root}/calls`,
            FAKE_SEEN: `${root}/seen`,
          },
        }).output();
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        const calls = (await Deno.readTextFile(`${root}/calls`)).trim().split(
          "\n",
        );
        const creates = calls.filter((line) => line.startsWith("create "));
        const initialization = calls.indexOf("info --format json");
        const rootlessCheck = calls.indexOf(
          "info --format {{.Host.Security.Rootless}}",
        );
        if (backend === "docker") {
          assertEquals(creates, []);
          assertEquals(initialization, -1);
          assertEquals(rootlessCheck, -1);
          return;
        }
        assertEquals(
          initialization >= 0 && rootlessCheck > initialization,
          true,
        );
        assertEquals(
          rootlessCheck < calls.findIndex((line) => line.startsWith("image ")),
          true,
        );
        assertEquals(creates.length, browser ? 2 : 1);
        const firstRun = calls.findIndex((line) => line.startsWith("run "));
        for (const kind of browser ? ["dev", "chromium"] : ["dev"]) {
          const create = creates.find((line) =>
            line.includes(`globnotes-prepare-${kind}-`)
          );
          if (!create) throw new Error(`Missing ${kind} preparation`);
          assertStringIncludes(create, "--userns=keep-id:uid=1000,gid=1000");
          assertStringIncludes(create, `--user ${kind}`);
          assertStringIncludes(create, "--network none");
          const image = create.trim().split(/\s+/).at(-1)!;
          assertStringIncludes(image, `localhost/globnotes-${kind}:`);
          const launch = calls.find((line) =>
            line.startsWith("run ") && line.includes(image)
          );
          if (!launch) throw new Error(`Missing ${kind} launch`);
          assertStringIncludes(launch, "--userns=keep-id:uid=1000,gid=1000");
          assertStringIncludes(launch, `--user ${kind}`);
          const name = create.split("--name ")[1].split(" ")[0];
          const removed = calls.indexOf(`rm ${name}`);
          assertEquals(
            removed > calls.indexOf(create) && removed < firstRun,
            true,
          );
          assertEquals(
            calls.some((line) => line.startsWith(`start ${name}`)),
            false,
          );
          assertEquals(calls.filter((line) => line === launch).length, 1);
        }
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  }
}

for (
  const [failure, status, message] of [
    ["rootless-false", 1, "Podman is not rootless (reported false)"],
    ["rootless-timeout", 124, "rootless check timed out after 20 seconds"],
    ["rootless-error", 42, "rootless check errored (exit 42)"],
    [
      "rootless-invalid",
      1,
      "rootless check returned unexpected output: unknown",
    ],
  ] as const
) {
  Deno.test(`launcher reports the actual rootless check outcome: ${failure}`, async () => {
    const root = await Deno.makeTempDir({ prefix: "launcher-rootless-" });
    try {
      await Deno.mkdir(`${root}/.devcontainer`, { recursive: true });
      await Deno.mkdir(`${root}/bin`);
      await Deno.copyFile(
        new URL("../.devcontainer/run.sh", import.meta.url),
        `${root}/.devcontainer/run.sh`,
      );
      await Deno.writeTextFile(`${root}/bin/podman`, engine, { mode: 0o755 });
      const result = await command("bash", {
        args: [
          `${root}/.devcontainer/run.sh`,
          "--run-dir",
          `${root}/run`,
          "--",
          "true",
        ],
        env: {
          PATH: `${root}/bin:${Deno.env.get("PATH")}`,
          GLOBNOTES_CONTAINER_ENGINE: "podman",
          FAKE_BACKEND: "podman",
          FAIL_STEP: failure,
          FAKE_CALLS: `${root}/calls`,
          FAKE_SEEN: `${root}/seen`,
        },
      }).output();
      const stderr = new TextDecoder().decode(result.stderr);
      assertEquals(result.code, status);
      assertStringIncludes(stderr, message);
      assertStringIncludes(
        stderr,
        "podman info --format '{{.Host.Security.Rootless}}'",
      );
      assertStringIncludes(
        stderr,
        `step=check-rootless failed (exit ${status})`,
      );
      assertEquals(stderr.includes("rootless Podman required"), false);
      if (failure === "rootless-error") {
        assertStringIncludes(stderr, "engine query denied");
        assertStringIncludes(
          await Deno.readTextFile(`${root}/run/logs/rootless.stderr.log`),
          "engine query denied",
        );
      }
      const calls = (await Deno.readTextFile(`${root}/calls`)).trim().split(
        "\n",
      );
      assertEquals(calls, [
        "--version",
        "info --format json",
        "info --format {{.Host.Security.Rootless}}",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
