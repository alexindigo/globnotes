// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStringIncludes } from "@std/assert";
import { command } from "./helpers/process.ts";
import { DENO } from "./helpers/process_values.ts";
import { fromFileUrl } from "@std/path";
import {
  OWNERSHIP_NATIVE_CONTROLS,
  selectChecks,
} from "../scripts/select-checks.ts";

/** Each fixture rewrite must apply exactly once; a missed pattern would leave
 * the generated script pointing at the real workspace and log locations. */
function rewrite(text: string, from: string, to: string): string {
  const parts = text.split(from);
  if (parts.length !== 2) {
    throw new Error(`gate fixture rewrite expected one ${from}`);
  }
  return parts.join(to);
}

Deno.test("gates: ownership selection validates fields, builds before native and forwards only selected families and controls", async () => {
  const root = await Deno.makeTempDir({ prefix: "gate-ownership-selection-" });
  try {
    for (
      const directory of [
        "bin",
        "logs",
        "client/tests/e2e",
        "server/api/endpoints",
      ]
    ) await Deno.mkdir(`${root}/${directory}`, { recursive: true });
    const server = [
      "tests/fixture_layout_ownership_test.ts",
      "tests/ownership_layout_guard_test.ts",
      "tests/config_paths_test.ts",
      "tests/config_owned_root_test.ts",
      "tests/server_lifetime_test.ts",
    ];
    const files = [
      "tests/helpers/fixture_layout.ts",
      ...server,
      "client/tests/e2e/setup-wizard.mjs",
      "client/tests/e2e/plugin-prefix-auth.mjs",
      ...OWNERSHIP_NATIVE_CONTROLS.map((name) =>
        `client/tests/e2e/${name}.mjs`
      ),
    ];
    const selection = selectChecks([{
      status: "M",
      path: "tests/helpers/fixture_layout.ts",
      removed: false,
    }], {
      files,
      imports: Object.fromEntries(server.map((file) => [file, []])),
    });
    assertEquals(selection.contractTests, [
      "tests/ownership_layout_guard_test.ts",
    ]);
    await Deno.writeTextFile(
      `${root}/selection.json`,
      JSON.stringify(selection),
    );
    await Deno.writeTextFile(
      `${root}/bin/deno`,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *--field* ]]; then exec "$REAL_DENO" run --config="$PROJECT_CONFIG" --allow-read "$SELECTOR" --field "\${@: -2:1}" "\${@: -1}"; fi
printf '%s\\n' "$*" >> "$GATE_FIXTURE/commands"
if [[ "$*" == 'task build:client' ]]; then : > "$GATE_FIXTURE/build-completed"; fi
`,
      { mode: 0o755 },
    );
    await Deno.writeTextFile(
      `${root}/client/tests/e2e/run.sh`,
      `#!/bin/sh
set -eu
test -f "$GATE_FIXTURE/build-completed"
test "$GLOBNOTES_E2E_CASES" = "$EXPECTED_CASES"
printf '%s\\n' "$GLOBNOTES_E2E_CASES" > "$GATE_FIXTURE/native-cases"
`,
    );
    let script = await Deno.readTextFile(
      new URL("../scripts/gates.sh", import.meta.url),
    );
    script = rewrite(script, "cd /workspace", 'cd "$GATE_FIXTURE"');
    script = rewrite(script, "logs=/run-logs", 'logs="$GATE_FIXTURE/logs"');
    script = rewrite(
      script,
      "artifacts=/artifacts",
      'artifacts="$GATE_FIXTURE/artifacts"',
    );
    await Deno.writeTextFile(`${root}/gates.sh`, script);
    const result = await command("bash", {
      args: [`${root}/gates.sh`, "--select", `${root}/selection.json`],
      env: {
        PATH: `${root}/bin:${Deno.env.get("PATH")}`,
        GATE_FIXTURE: root,
        GLOBNOTES_TEST_HOST: "globnotes.test",
        GLOBNOTES_E2E_CASES: "must-be-cleared",
        REAL_DENO: DENO,
        PROJECT_CONFIG: fromFileUrl(new URL("../deno.json", import.meta.url)),
        SELECTOR: fromFileUrl(
          new URL("../scripts/select-checks.ts", import.meta.url),
        ),
        EXPECTED_CASES: selection.browserCases.join(","),
      },
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals(
      (await Deno.readTextFile(`${root}/native-cases`)).trim(),
      selection.browserCases.join(","),
    );
    const gates = (await Deno.readTextFile(`${root}/logs/timings.jsonl`)).trim()
      .split("\n").map((line) => JSON.parse(line).gate);
    assertEquals(gates, [
      "browser-ready",
      ...selection.gates,
    ]);
    assertStringIncludes(
      await Deno.readTextFile(`${root}/commands`),
      "test --unstable-worker-options --allow-read --allow-write --allow-env --allow-run --allow-net tests/ownership_layout_guard_test.ts",
    );
    assertStringIncludes(
      await Deno.readTextFile(`${root}/commands`),
      server.join(" "),
    );
    assertEquals(gates.includes("unit-controls"), false); // Mandatory controls belong to the selected native suite, once.
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

for (const broken of [false, true]) {
  Deno.test(`gates: contract discovery ${broken ? "fails closed" : "runs every guard"}`, async () => {
    const root = await Deno.makeTempDir({ prefix: "gate-discovery-" });
    try {
      for (
        const directory of ["bin", "logs", "tests", "server/api/endpoints"]
      ) {
        await Deno.mkdir(`${root}/${directory}`, { recursive: true });
      }
      await Deno.writeTextFile(
        `${root}/tests/test_isolation_contract_test.ts`,
        "",
      );
      await Deno.writeTextFile(`${root}/tests/devcontainer_caps_test.ts`, "");
      await Deno.writeTextFile(
        `${root}/bin/deno`,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *scripts/guard-modules.ts* ]]; then
  ${
          broken
            ? "exit 42"
            : "printf 'tests/a_guard_test.ts\\ntests/nested/b_guard_test.ts\\n'"
        }
elif [[ "$1" == test && "$*" == *test_isolation_contract_test.ts* ]]; then
  printf '%s\\n' "$@" > "$GATE_FIXTURE/contracts"
fi
`,
        { mode: 0o755 },
      );
      const script = (await Deno.readTextFile(
        new URL("../scripts/gates.sh", import.meta.url),
      ))
        .replace("cd /workspace", 'cd "$GATE_FIXTURE"')
        .replace("logs=/run-logs", 'logs="$GATE_FIXTURE/logs"')
        .replace("artifacts=/artifacts", 'artifacts="$GATE_FIXTURE/artifacts"');
      await Deno.writeTextFile(`${root}/gates.sh`, script);
      const result = await command("bash", {
        args: [`${root}/gates.sh`, "--checks"],
        env: {
          PATH: `${root}/bin:${Deno.env.get("PATH")}`,
          GATE_FIXTURE: root,
          GLOBNOTES_TEST_HOST: "globnotes.test",
        },
      }).output();
      assertEquals(
        result.code,
        broken ? 42 : 0,
        new TextDecoder().decode(result.stderr),
      );
      if (!broken) {
        assertEquals(
          (await Deno.readTextFile(`${root}/contracts`)).trim().split("\n"),
          [
            "test",
            "--unstable-worker-options",
            "--allow-read",
            "--allow-write",
            "--allow-env",
            "--allow-run",
            "--allow-net",
            "tests/test_isolation_contract_test.ts",
            "tests/devcontainer_caps_test.ts",
            "tests/a_guard_test.ts",
            "tests/nested/b_guard_test.ts",
          ],
        );
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

for (const mode of ["checks", "native"]) {
  Deno.test(`gates: ${mode} keeps CI workloads separate and forwards its shard`, async () => {
    const root = await Deno.makeTempDir({ prefix: "gate-shard-" });
    try {
      for (
        const path of [
          "bin",
          "logs",
          "server/api/endpoints",
          "client/tests/e2e",
        ]
      ) {
        await Deno.mkdir(`${root}/${path}`, { recursive: true });
      }
      await Deno.writeTextFile(`${root}/bin/deno`, "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      await Deno.writeTextFile(
        `${root}/client/tests/e2e/run.sh`,
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$GATE_FIXTURE/argv"\ntest -z "${GLOBNOTES_E2E_CASES:-}"\n',
      );
      const script = (await Deno.readTextFile(
        new URL("../scripts/gates.sh", import.meta.url),
      ))
        .replace("cd /workspace", 'cd "$GATE_FIXTURE"')
        .replace("logs=/run-logs", 'logs="$GATE_FIXTURE/logs"')
        .replace(
          "artifacts=/artifacts",
          'artifacts="$GATE_FIXTURE/artifacts"',
        );
      await Deno.writeTextFile(`${root}/gates.sh`, script);
      const result = await command("bash", {
        args: [
          `${root}/gates.sh`,
          `--${mode}`,
          ...(mode === "native" ? ["--shard", "3/3"] : []),
        ],
        env: {
          PATH: `${root}/bin:${Deno.env.get("PATH")}`,
          GATE_FIXTURE: root,
          GLOBNOTES_TEST_HOST: "globnotes.test",
          GLOBNOTES_E2E_CASES: "must-be-cleared",
        },
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      const gates = (await Deno.readTextFile(`${root}/logs/timings.jsonl`))
        .trim().split("\n").map((line) => JSON.parse(line).gate);
      assertEquals(
        gates,
        mode === "native" ? ["browser-ready", "install", "build", "native"] : [
          "install",
          "lint",
          "check",
          "format",
          "worker",
          "handlers",
          "shell",
          "e2e-modules",
          "server",
          "client",
          "build",
          "cold-load",
        ],
      );
      if (mode === "native") {
        assertEquals(await Deno.readTextFile(`${root}/argv`), "--shard\n3/3\n");
      }
      const invalid = await command("bash", {
        args: [
          `${root}/gates.sh`,
          `--${mode}`,
          "--shard",
          mode === "native" ? "4/3" : "1/3",
        ],
        env: { GATE_FIXTURE: root, GLOBNOTES_TEST_HOST: "globnotes.test" },
      }).output();
      assertEquals(invalid.code, 2);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

// The fake command is the selector/process boundary, not an alternative gate.
const deno = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *--field* ]]; then
    field="\${@: -1}"
    if [[ "$field" == "$FAIL_FIELD" ]]; then printf 'selector fault: %s\\n' "$field" >&2; exit 42; fi
    case "$field" in
        browser) printf 'true\\n' ;;
        gates) printf '%s\\n' install server timing client build cold-load native native-controls ;;
        contractTests) printf 'tests/fixture.ts\\n' ;;
        *) printf 'all\\n' ;;
    esac
elif [[ "$*" == *--staged* ]]; then printf '{}\\n'
fi
`;

for (const mode of ["plan", "select"]) {
  for (
    const field of mode === "plan" ? ["browser", "gates"] : [
      "gates",
      "contractTests",
      "serverTests",
      "timingTests",
      "clientTests",
      "browserCases",
      "browser",
    ]
  ) {
    Deno.test(`gates: ${mode} rejects a failed ${field} read`, async () => {
      const root = await Deno.makeTempDir({ prefix: "gate-selection-" });
      try {
        await Deno.mkdir(`${root}/bin`);
        await Deno.mkdir(`${root}/logs`);
        await Deno.mkdir(`${root}/server/api/endpoints`, { recursive: true });
        await Deno.writeTextFile(`${root}/bin/deno`, deno, { mode: 0o755 });
        const script = (await Deno.readTextFile(
          new URL("../scripts/gates.sh", import.meta.url),
        ))
          .replace("cd /workspace", 'cd "$GATE_FIXTURE"')
          .replace("logs=/run-logs", 'logs="$GATE_FIXTURE/logs"')
          .replace(
            "artifacts=/artifacts",
            'artifacts="$GATE_FIXTURE/artifacts"',
          );
        await Deno.writeTextFile(`${root}/gates.sh`, script);
        await Deno.writeTextFile(`${root}/selection.json`, "{}");
        const args = mode === "plan"
          ? ["--plan", `${root}/selection.json`, `${root}/selection.json`]
          : ["--select", `${root}/selection.json`];
        const result = await command("timeout", {
          args: ["15", "bash", `${root}/gates.sh`, ...args],
          env: {
            PATH: `${root}/bin:${Deno.env.get("PATH")}`,
            GATE_FIXTURE: root,
            FAIL_FIELD: field,
            GLOBNOTES_TEST_HOST: "globnotes.test",
          },
        }).output();
        assertEquals(result.success, false);
        assertStringIncludes(
          new TextDecoder().decode(result.stderr),
          `selector fault: ${field}`,
        );
        const summary = await Deno.readTextFile(`${root}/logs/summary.txt`);
        assertStringIncludes(summary, "FAIL");
        assertStringIncludes(summary, "failed=selection");
        assertEquals(summary.includes("PASS"), false);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  }
}

for (const choice of ["local-all", "selected", "selector-fault"]) {
  Deno.test(`gates: CI controls ${choice} preserves the required gates`, async () => {
    const root = await Deno.makeTempDir({ prefix: "gate-controls-" });
    try {
      for (
        const directory of [
          "bin",
          "logs",
          "server/api/endpoints",
          "client/tests/e2e",
        ]
      ) {
        await Deno.mkdir(`${root}/${directory}`, { recursive: true });
      }
      await Deno.writeTextFile(
        `${root}/bin/deno`,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *--ci-controls* ]]; then printf '{}\\n'; fi
if [[ "$*" == *--control-field* ]]; then
  [[ "$CHOICE" != selector-fault ]] || exit 42
  printf 'native-results\\n'
fi
`,
        { mode: 0o755 },
      );
      await Deno.writeTextFile(
        `${root}/client/tests/e2e/run.sh`,
        "#!/bin/sh\nexit 0\n",
      );
      const script = (await Deno.readTextFile(
        new URL("../scripts/gates.sh", import.meta.url),
      ))
        .replace("cd /workspace", 'cd "$GATE_FIXTURE"')
        .replace("logs=/run-logs", 'logs="$GATE_FIXTURE/logs"')
        .replace(
          "artifacts=/artifacts",
          'artifacts="$GATE_FIXTURE/artifacts"',
        );
      await Deno.writeTextFile(`${root}/gates.sh`, script);
      const result = await command("timeout", {
        args: [
          "20",
          "bash",
          `${root}/gates.sh`,
          "--all",
          "--browser",
          ...(choice === "local-all" ? [] : [
            "--ci-changes",
            `${root}/missing-diff`,
            "--ci-ref",
            "refs/heads/main",
          ]),
        ],
        env: {
          PATH: `${root}/bin:${Deno.env.get("PATH")}`,
          GATE_FIXTURE: root,
          CHOICE: choice,
          GLOBNOTES_TEST_HOST: "globnotes.test",
        },
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
      const timings = (await Deno.readTextFile(`${root}/logs/timings.jsonl`))
        .trim().split("\n").map((line) => JSON.parse(line).gate);
      const controls = timings.filter((gate) =>
        [
          "unit-controls",
          "native-results",
          "native-controls",
          "entrypoint-results",
        ].includes(gate)
      );
      assertEquals(
        controls,
        choice === "selected" ? ["native-results"] : [
          "unit-controls",
          "native-results",
          "native-controls",
          "entrypoint-results",
        ],
      );
      assertEquals(timings.includes("native"), true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
