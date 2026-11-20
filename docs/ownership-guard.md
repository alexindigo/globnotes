# Ownership guard registrations

The guard checks capability roots and resolved import sites, not the flow of
JavaScript values. Every enumerated project module and local transitive is
parsed, including `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs` and `.jsx`. Syntax errors,
incomplete source/statement spans and module-set mismatches fail before results
can be accepted.

## Rules

`analyzeOwnership(sources, rules = PROCESS_OWNERSHIP)` returns violations only.
`OwnershipSourceOwner.analyze(root, rules)` and `repositoryOwnership(root, rules)`
accept the same explicit rules. No mutable global registration is needed.

| # | Registration | Meaning |
|---|---|---|
| 1 | `roots[name].members` | Ordinary direct, non-computed members of a global root |
| 2 | `roots[name].ownedMembers[member]` | Exact owner modules for that member; overrides the public member list |
| 3 | `modules[resolvedIdentity]` | Exact owner modules for every runtime import/re-export of that module |

A global root in any other value position rejects: aliases, destructuring,
object values, spreads, arguments, exports and computed access. This includes
`globalThis`, `self`, `window`, Node's `global`, `process`, `module`, `require`,
`eval` and `Function`. Compiler binding information distinguishes real lexical
shadows from runtime globals; erased declarations and JS expando writes do not
create runtime shadows. Types are parsed but erased type-only dependencies do
not acquire a runtime capability.

Root occurrences are collected from the entire AST without subtree pruning.
Each occurrence is then classified by a closed list of erased ancestor positions:
annotations, type arguments, type parameters/aliases/interfaces, implements
clauses, type-only import/export forms and ambient declarations. Runtime class
heritage and internal import-equals aliases receive the ordinary root checks.
Unknown future node kinds are not presumed erased merely because they look like
types or have a field named `name`; known non-value names are listed explicitly.

Imports are classified by the graph's resolved identity, not alias spelling or
selected export names. Empty runtime re-exports still load their module.
Dynamic imports require a string literal and a graph edge; no string folding,
URL evaluation or re-export member lookup occurs. Unresolved runtime dependency
edges reject rather than being presumed harmless; canonical static Node builtin
spellings can be classified directly.

For example, an owner can extend the process rules without adding an evaluator:

```ts
const rules = {
  roots: {
    ...PROCESS_OWNERSHIP.roots,
    Deno: {
      ...PROCESS_OWNERSHIP.roots.Deno,
      ownedMembers: {
        ...PROCESS_OWNERSHIP.roots.Deno.ownedMembers,
        makeTempDir: ["tests/helpers/fixture_scope.ts"],
      },
    },
  },
  modules: {
    ...PROCESS_OWNERSHIP.modules,
    "shared/private-engine.js": ["tests/helpers/fixture_scope.ts"],
  },
};
```

Owner permission does not authorize capturing a bare namespace. A private module
must have a separate public facade when ordinary callers need public functions.
Do not reintroduce factory-result, object-shape, member-value or re-export value
tracking. Owner provenance and business behavior remain runtime/type contract
responsibilities, not assertions inferred from arbitrary JavaScript flow.

## Sites and migration

`OwnershipSite` retains `file`, `capability`, `line`, `source` and `context`.
Sites now identify the first forbidden root or import, not every downstream use
of an alias. Import capabilities use `module:<resolvedIdentity>`; bare/computed
roots use `<root>.*`; direct denied members use `<root>.<member>`.
Computed imports use `dynamic-import.*`, missing edges use `unresolved-import`.
Owner-authorized references produce no violation site.

`inventoryErrors` consumes all supplied violations without a directory filter or
implicit owner exemption. Exact baseline occurrences are counted, stale entries
reject, and every entry names its migration and consumers. No new source form
automatically gains an allowance. Root-policy expansion records newly visible
baseline sites separately in `ownership_root_sites.json`; it does not weaken
the reference rules or claim class closure while migrations remain.

P01 no longer classifies credential encodings or follows credential values.
P07-P10 register their actual private module boundaries and owner-facing roots;
the old `CREDENTIAL_IMPORTS`, `SECRET_OWNER`, `protectedSource`, value interpreter
and export-member resolver are gone. Their former 26 credential inventory entries
are not represented as P01 credential protection. The registration controls retain
the old credential examples without claiming the default process policy owns them.

The guard is a source ownership contract, not a sandbox for hostile JavaScript.
Declared owners, permitted public APIs and external dependencies remain trusted.
