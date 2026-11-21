# Writing tests

Run tests on ark through the worktree's rootless Podman devcontainer, never
directly on the host. The tracked signed commit hook uses the same runner.
Commands, gate selection and browser setup are in the
[infrastructure reference](testing.md).

## Compare the whole outcome

Use `assertEquals` on the complete result or event list, including identities,
order, duplicates and failures. Derive expected pages from the fixture, not a
second call to the search being tested. Counts and disjointness alone do not
prove the requested result. Do not use `.every`, `.some` or `indexOf` as the
proof: they can accept missing or empty outcomes.

```ts
assertEquals(events, ["admitted", "revoked", "persistence"]);
assertEquals(page.results.map((row) => row.path), ["notes/a", "notes/b"]);
```

## Check each rejection once

Use one `assertRejects` (or `assertThrows` for synchronous calls) per operation.
Specify its exact error type and message; inspect that captured error for any
additional fields. Do not rerun a call to check a second error property.
Bad inputs get ordinary "must be rejected" tests that stay in the suite.

```ts
const error = await assertRejects(() => saving, OperationError, expectedMessage);
assertEquals([error.status, error.code, error.message], [409, expectedCode, expectedMessage]);
```

## Wait for the operation you test

Await the real operation or its actual completion callback before checking its
consumer. If broken code could leave that wait hanging, use `bounded` from
`tests/helpers/worker_liveness.ts`. Never substitute sleeps or guessed event-loop
turns. A timeout contains a broken test; it does not prove the effect occurred.

```ts
await bounded(completed.promise, "index pass completion");
assertEquals(index.search("retried").map((row) => row.path), ["failed-note"]);
```

## Own fixtures from construction

Create fixtures inside their owning test/scope, not before entering it. Keep
cleanup with that owner. For a late guard, record successful admission, retire
authority through the existing injected boundary, then observe the final guard
and unchanged persisted/runtime state. For byte erasure, prove the real stored
token is present before deleting and absent afterward, including after reopen.
