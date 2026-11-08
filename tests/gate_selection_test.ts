// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStringIncludes } from "@std/assert";
import { command } from "./helpers/process.ts";

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
