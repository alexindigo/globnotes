# Testing

Every test and browser check runs inside the project's devcontainer,
started by `.devcontainer/run.sh`. Nothing runs Deno, Chromium or the test
suites directly on the host. The pre-commit hook runs the checks related to a
commit; GitHub CI runs the full suite (`scripts/gates.sh --all --browser`).

## The devcontainer

| # | Part | What it is |
|---|---|---|
| 1 | Dev image | `.devcontainer/Dockerfile`: Deno 2.9.6 (the root `Dockerfile`'s version) and git, user `dev` (uid/gid 1000). Tagged `localhost/globnotes-dev:<first 16 hex of the Dockerfile's SHA-256>` and built only when that tag is missing |
| 2 | Browser image | `.devcontainer/chromium/Dockerfile`: headless Chromium, user `chromium`, CDP on `127.0.0.1:9335`. Started only with `--browser`, in the dev container's network namespace |
| 3 | Resource caps | Dev container: 8 GB memory = memory+swap, 512 PIDs, 4 CPUs (`DEV_CAPS` in `run.sh`, equal to `runArgs` in `devcontainer.json`; `tests/devcontainer_caps_test.ts` keeps them equal). Chromium: 2 GB, 512 PIDs, 2 CPUs, 1 GB shared memory |
| 4 | Network | Own network `globnotes-test`; no published ports. The dev container's hostname is `globnotes.test` |
| 5 | Mounts | `/workspace` = the source directory, `/run-tmp` (`TMPDIR`), `/run-logs`, `/artifacts` = the run directory's `tmp`, `logs`, `artifacts`; `/deno-dir` = the dependency cache (row 6) |
| 6 | Engine | Rootless Podman when installed, else Docker; `GLOBNOTES_CONTAINER_ENGINE=podman\|docker` chooses. Podman maps the host user to `dev` (`--userns=keep-id`) and uses the cache volume `globnotes-deno-cache`; Docker runs as the host user with the cache in `~/.cache/globnotes-run/deno-dir` (see CI) |

`devcontainer.json` uses the same image and caps for an editor session.

## Running commands: `.devcontainer/run.sh`

```sh
.devcontainer/run.sh [--browser] [--source DIR] [--run-dir DIR] -- COMMAND [ARG...]
```

`COMMAND` runs in `/workspace`. `--source` defaults to the checkout; pass a
fresh export to check an exact tree. `--run-dir` (default: a new directory
under `~/.cache/globnotes-run/`) receives the container's scratch space, logs
and artifacts, and the launcher's own logs (image builds, container inspects).
Host `/tmp` is refused as a workspace. Examples:

```sh
.devcontainer/run.sh -- deno task test
.devcontainer/run.sh -- bash scripts/gates.sh --all
.devcontainer/run.sh --browser -- bash scripts/gates.sh --all --browser
```

## The gates: `scripts/gates.sh`

One gate list serves the hook and full runs. Each gate logs to
`/run-logs/<gate>.log` and appends its exit status and seconds to
`/run-logs/timings.jsonl`; the first failing gate stops the run.
`/run-logs/summary.txt` gets one line per run.

| # | Mode | Runs |
|---|---|---|
| 1 | `--all` | Every non-browser gate below, the server suite in parallel |
| 2 | `--all --browser` | Also the browser gates (needs `run.sh --browser`) |
| 3 | `--timing` | The timing-budget tests in `tests/timing/`, serially |
| 4 | `--plan STAGED FILES` | The commit check's selection (`scripts/select-checks.ts`), written to `/run-logs/selection.json` |
| 5 | `--select SELECTION` | The gates and tests a selection names |

`--serial` runs the server tests without `--parallel`.

| # | Gate | Command (in `/workspace`) |
|---|---|---|
| 1 | install | `deno install` |
| 2 | lint | `deno lint server/ tests/` |
| 3 | check | `deno check server/main.ts tests/**/*.ts` (all test files, with `globstar`) |
| 4 | format | `deno fmt --check server/ tests/` |
| 5 | worker | `deno check` of `server/plugins/worker_entry.ts` |
| 6 | handlers | `deno check` of each `server/api/endpoints/**/*.ts`, which main loads only at run time |
| 7 | shell | `bash -n` / `sh -n` of every `*.sh` file and `.githooks/*` |
| 8 | e2e-modules | `deno bundle` (esbuild) of every `client/tests/e2e/*.mjs` and `*.js` into a scratch directory: links each module graph without running it, so a duplicate binding, a missing module or a missing named export fails even in a script the native suite doesn't select |
| 9 | contracts | `tests/test_isolation_contract_test.ts`, `tests/devcontainer_caps_test.ts` |
| 10 | server | `deno test --parallel` (`DENO_JOBS=4`) of the server tests, not `tests/timing/` |
| 11 | timing | `deno test` of `tests/timing/`, serially |
| 12 | client | Vitest with `VITEST_MAX_WORKERS=4`: the whole suite, or `vitest related` of changed files |
| 13 | build | `deno task build:client` |
| 14 | cold-load | `scripts/cold-load.mjs`: the built server answers health, index, assets and a note |
| 15 | unit-controls | `unit-consumer-controls.mjs`: broken keymap, Tab and hydration producers in fresh source copies are rejected by their actual client tests |
| 16 | native | The native browser suite, `client/tests/e2e/run.sh`; `GLOBNOTES_E2E_CASES=<case,…>` restricts it to named cases |
| 17 | native-results | `native-result-controls.mjs`: real nonzero children with misleading success output, missing startup, timeout with zero exit, a completed child |
| 18 | native-controls | `native-consumer-controls.mjs`: wrong clipboard/token/image/link/identity/tag/palette/visibility/geometry consumers fail, equivalent CSS passes; follows `GLOBNOTES_E2E_CASES` for case-owned controls |
| 19 | entrypoint-results | `runner-entrypoint-controls.mjs`: the shell entrypoint with a misleading nonzero child and a completed zero-exit child |

Gates 16–19 need the Chromium sidecar; a selection or `--browser` run checks
the CDP endpoint first. The native suite records each child's actual exit and
timeout state; printed PASS/OK words cannot grant success.

## Browser tests: a local HTTP domain

Browser tests open the application only through an ordinary local HTTP
hostname, never `localhost` or a loopback address: plain HTTP on a local domain
is a first-class deployment (Axiom 1), and browsers treat loopback as a secure
context.

| # | Item | Convention |
|---|---|---|
| 1 | Hostname | `globnotes.test`, the dev container's hostname. It resolves to the container's own non-loopback address, in the dev and the Chromium container alike (shared network namespace) |
| 2 | Variable | `run.sh` sets `GLOBNOTES_TEST_HOST=globnotes.test`; test servers and proxies bind to its address |
| 3 | Page check | Every application `goto()` rejects any URL other than `http://$GLOBNOTES_TEST_HOST:<port>`, then requires the loaded origin and `isSecureContext === false`, logging an `application-origin` record. An unset, loopback or foreign name fails before navigation |
| 4 | Browser security | Chromium runs with its sandbox and normal security settings |
| 5 | Loopback stays for | CDP (`127.0.0.1:9335`, browser control), server tests (`tests/helpers/boot.ts`), server-side network-egress fixtures and the cold-load probe (a server check, not a browser test) |

Plain HTTP has no `navigator.clipboard`. `client/tests/e2e/native-clipboard.mjs`
observes the real clipboard with page APIs only, through a test-owned witness
page on the same domain in its own browser context. It reads with the trusted
`paste` event of a native Ctrl+V, and writes or restores every exposed type with
`execCommand("copy")` and a `copy` handler under a CDP user gesture, so the
application page keeps focus. Open the witness (`prepareClipboardWitness`)
before a focus-sensitive flow.

## Commit check: `.githooks/pre-commit`

Activate the tracked hooks once per checkout. In a repository with several
worktrees, worktree-scoped configuration needs the `worktreeConfig` extension:

```sh
git config extensions.worktreeConfig true   # once per repository
git config --worktree core.hooksPath .githooks
```

(A single checkout can use `git config core.hooksPath .githooks`.)

On `git commit` the hook:

1. writes the index as a tree, refusing unmerged paths, symlinks and
   submodules;
2. creates the run directory
   `~/TemporaryFiles/globnotes/validation/<UTC yyyymmddThhmmssZ>-pre-commit-<tree12>/`
   (`GLOBNOTES_VALIDATION_DIR` moves its parent) and exports the tree into
   `source/` with `git archive`, checking that every tracked file arrived;
3. writes the staged paths (`git diff --cached --name-status -M -z`) and the
   tree's file list into `run/logs/`;
4. runs `gates.sh --plan` in the container, which selects the checks into
   `run/logs/selection.json`, then `gates.sh --select` with `--browser` when
   the selection has browser gates. Both use the snapshot's own `run.sh` and
   scripts;
5. prints one line: PASS/FAIL, wall time, the gates run (and the failing one),
   the run directory; and a warning above the 300-second budget;
6. keeps logs, selection and timings. On PASS it deletes `source/`, the
   scratch space and every artifact except JSON results; on FAIL it keeps
   everything.

The host side is git plumbing, `tar` and the launcher; the selection and every
check run in the container. `GLOBNOTES_CHECK_BASE=<commit-or-tree>` makes the
hook select against that base instead of `HEAD`, for example to check a
temporary index (`GIT_INDEX_FILE`) or to re-run a commit's check:

```sh
GLOBNOTES_CHECK_BASE=HEAD~1 git hook run pre-commit   # the change HEAD~1..index
```

### What a change selects

The selection (`scripts/select-checks.ts`) reads the snapshot. When in doubt it
selects more; every choice is recorded with its reason in `selection.json`.

| # | Changed path | Selected |
|---|---|---|
| 1 | Any change | Static gates 1–8 |
| 2 | `server/**`, `shared/**`, `tests/**` (not `tests/timing/`) | The server tests whose dependencies contain the path, run in parallel |
| 3 | `client/**` (not `client/tests/e2e/`), `shared/**` | `vitest related` of the changed files, unit-controls, build, cold-load. The Vitest setup file selects the whole client suite |
| 4 | `client/tests/e2e/**` | The cases whose driver reaches the file or that the case map (`FILE_CASES` in `legacy-native-suite.mjs`) names, with native-controls for them; the meta gates (native-results, unit-controls, entrypoint-results) whose entrypoint reaches it; `vitest related` of the file. A shared harness file, a file the native suite imports, a removed file or a non-module outside the map and graph selects the whole browser suite. A `*.test.js` file is a client test |
| 5 | Shared inputs: `deno.json`, `deno.lock`, `vite.config.js`, `vitest.config.mjs`, `.devcontainer/**`, `scripts/gates.sh`, `scripts/select-checks.ts`, `scripts/cold-load.mjs`, `entrypoint.sh`, `Dockerfile` | Every non-browser gate: the whole server suite, the whole client suite, unit-controls, build, cold-load. `.devcontainer/**` also the whole browser suite |
| 6 | `tests/timing/**` | The changed timing tests, serially; a helper or a removed file there selects all of them |
| 7 | Docs: `*.md`, `docs/**` | Row 1 |
| 8 | Anything else | Row 5 |
| 9 | Renames and deletions | Old and new paths are both classified. A removed server or client path selects its whole suite (its dependents are not in the snapshot) |

A server test's dependencies are its `deno info` module graph plus the
repository paths its modules name in string literals (`new URL("…",
import.meta.url)`, launcher arguments, fixture files), followed transitively.
A directory named relative to a module is a loader: its modules count too
(the server's endpoint directory, a bundled plugin). Any other named directory
counts for server-side paths only; the launcher `tests/helpers/boot.ts` names
the repository root as the server's working directory, so every test that
starts a server through it is selected by every server-side change. A path a
server test names selects it whatever the path's row (a script, a browser
driver, a document). Dynamic imports the literal scan cannot resolve are
listed in `KNOWN_DYNAMIC` with what they load; any other one makes its tests
depend on everything. Without a module graph or a case map the selection
falls back to the whole server or browser suite.

Browser cases and timing tests are left to full runs for server and client
changes; the selection says so in its reasons.

## Push check: `.githooks/pre-push`

`scripts/check-push-dates.py` reads git metadata only and runs no tests. For
each pushed ref it takes the new commits (remote tip..local, or for a new
branch everything not on that remote's branches) and rejects the push when an
author or committer date is on a weekday between 09:00 and 18:00
America/Los_Angeles, or when either date is earlier than the previous
commit's (starting from the remote tip). It also rejects updates that do not
contain the remote tip. Deletions pass.

## CI: `.github/workflows/ci.yml`

GitHub CI runs everything it can, in the same devcontainer, with rootless
Podman (`GLOBNOTES_CONTAINER_ENGINE=podman`), matching the ark commit check,
so a commit whose hook was skipped is still checked. Podman is preinstalled
on the [GitHub-hosted Ubuntu runner](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2604-Readme.md):

```sh
export GLOBNOTES_CONTAINER_ENGINE=podman
.devcontainer/run.sh --browser --run-dir "$RUNNER_TEMP/globnotes/all" -- bash scripts/gates.sh --all --browser
.devcontainer/run.sh --run-dir "$RUNNER_TEMP/globnotes/timing" -- bash scripts/gates.sh --timing
```

The first runs every gate, including the browser suite with its Chromium
sidecar; the second the timing tests, serially. Chromium's sandbox stays
enabled. CI uses Podman because Docker's default isolation on the hosted
runner blocks the namespace creation Chromium needs for its sandbox.
The `docker-build` job builds the production image.

The Podman launcher requires rootless operation and maps the invoking user
to container UID/GID 1000 with `--userns=keep-id:uid=1000,gid=1000` (Podman
4.3 or newer). It uses a named bridge network and shares the dev container's
network namespace with Chromium, keeping CDP internal. Image builds use
`--memory=4g`; rootless memory limits require cgroups v2. There is no
version-specific fallback or automatic relaxation of sandbox settings.

Contributors can still select `GLOBNOTES_CONTAINER_ENGINE=docker`. Under
Docker the launcher runs the containers as the invoking user, with a cache
directory and `HOME` that user owns, and caps image builds with `--memory`
or BuildKit's `--resource`, whichever the engine offers
(`run/logs/build-caps.txt`).

On failure, the launcher names the failing step and prints log tails. CI
also uploads `test-failure-diagnostics`, containing the all/timing run
directories' `logs/` and JSON artifacts.

## Evidence

| # | Run | Where |
|---|---|---|
| 1 | Commit check | `~/TemporaryFiles/globnotes/validation/<stamp>-pre-commit-<tree12>/`: `tree.txt`, `base.txt`, `run/logs/` (`staged.z`, `files.z`, `selection.json`, gate logs, `timings.jsonl`, `summary.txt`, launcher logs) and JSON results under `run/artifacts/` |
| 2 | Manual `run.sh` | The `--run-dir` (default `~/.cache/globnotes-run/run.*`) |
| 3 | CI | The job log: every gate's output and its `== gate` header, the summary line |
