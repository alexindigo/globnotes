# Ownership guard registrations

The guard checks capability roots and resolved import sites, not the flow of
JavaScript values. Every enumerated project module and local transitive is
parsed, including `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs` and
`.jsx`. Syntax errors, incomplete source/statement spans and module-set
mismatches fail before results can be accepted.

## Rules

`analyzeOwnership(sources, rules = PROCESS_OWNERSHIP)` returns violations only.
`OwnershipSourceOwner.analyze(root, rules)` and
`repositoryOwnership(root, rules)` accept the same explicit rules. No mutable
global registration is needed.

| # | Registration                       | Meaning                                                               |
| - | ---------------------------------- | --------------------------------------------------------------------- |
| 1 | `roots[name].members`              | Ordinary direct, non-computed members of a global root                |
| 2 | `roots[name].ownedMembers[member]` | Exact owner modules for that member; overrides the public member list |
| 3 | `modules[resolvedIdentity]`        | Exact owner modules for every runtime import/re-export of that module |

A global root in any other value position rejects: aliases, destructuring,
object values, spreads, arguments, exports and computed access. This includes
`globalThis`, `self`, `window`, Node's `global`, `process`, `module`, `require`,
`eval` and `Function`. Compiler binding information distinguishes real lexical
shadows from runtime globals; erased declarations and JS expando writes do not
create runtime shadows. Types are parsed but erased type-only dependencies do
not acquire a runtime capability.

Root occurrences are collected from the entire AST without subtree pruning. Each
occurrence is then classified by a closed list of erased ancestor positions:
annotations, type arguments, type parameters/aliases/interfaces, implements
clauses, type-only import/export forms and ambient declarations. Runtime class
heritage and internal import-equals aliases receive the ordinary root checks.
Unknown future node kinds are not presumed erased merely because they look like
types or have a field named `name`; known non-value names are listed explicitly.
Names in external export specifiers name the dependency's exports, not global
roots. Local export specifiers still reference local bindings or globals. The
dependency check governs re-exports, and each producer's own roots are checked.

Imports are classified by the graph's resolved identity, not alias spelling or
selected export names. Empty runtime re-exports still load their module. Dynamic
imports require a string literal and a graph edge; no string folding, URL
evaluation or re-export member lookup occurs. Unresolved runtime dependency
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
roots use `<root>.*`; direct denied members use `<root>.<member>`. Computed
imports use `dynamic-import.*`, missing edges use `unresolved-import`.
Owner-authorized references produce no violation site.

`inventoryErrors` consumes all supplied violations without a directory filter or
implicit owner exemption. Exact baseline occurrences are counted, stale entries
reject, and every entry names its migration and consumers. No new source form
automatically gains an allowance. Root-policy expansion records newly visible
baseline sites separately in `ownership_root_sites.json`; it does not weaken the
reference rules or claim class closure while migrations remain.

P01 no longer classifies credential encodings or follows credential values.
P07-P10 register their actual private module boundaries and owner-facing roots;
the old `CREDENTIAL_IMPORTS`, `SECRET_OWNER`, `protectedSource`, value
interpreter and export-member resolver are gone. Their former 26 credential
inventory entries are not represented as P01 credential protection. The
registration controls retain the old credential examples without claiming the
default process policy owns them.

The guard is a source ownership contract, not a sandbox for hostile JavaScript.
Declared owners, permitted public APIs and external dependencies remain trusted.

## Fixture pilot registration

P03's callback facades expose no partially constructed owner. Their private
construction engines are registered by resolved identity. The finite pilot file
list selects an explicit stricter root/module policy for those modules; other
families retain their P01 policy until migration. `registeredOwnership`
partitions the enumerated modules, analyzes every module exactly once with the
same analyzer, and supplies every violation to the inventory without owner or
prefix filtering. These are policy contexts, not a second parser or flow-based
rule mechanism.

Raw directory acquisition belongs to the private plugin constructor; the
operations constructor owns hub/manager acquisition. Importing a facade or
naming a callback `scope` grants no root permission. Trusted constructor
behavior, reserve-before-allocation and partial-runtime cleanup are runtime
contracts; the source guard does not infer callback provenance or count method
calls.

P03's coordination-bearing scenario modules also register `Promise` as a root:
ordinary result aggregation is permitted, while raw constructors, deferreds and
aliases reject. Milestones enter through `fixture_coordination.ts`, which admits
the wait, observes the enclosing scope's cancellation and releases its listener
when the wait settles. Runtime controls prove cancellation and prompt release;
the registration alone does not prove those behaviors. Hub, lifecycle, auxiliary
and in-process driver constructors use the same fixture ownership engine rather
than implementing another cleanup loop.

## Record pilot registration

P11 protects the channel and raw protocol modules at resolved runtime imports.
Ordinary schema-only callers use `record_schema.ts`. Sync's native/preload/control
modules have explicit raw-I/O root rules, while the channel's observer primitives
belong to the existing lower protocol owner. The seven existing product-input and
artifact references remain exact finite inventory, not `allowed` sites. Newly
exposed legacy protocol/Node/std filesystem imports are inventoried at their
import references for A09/A11, rather than blessing their callers as owners.

Node filesystem identities and std root/copy identities are registered explicitly;
the latter match the actual source-owner graph, including its subpath identity.
Bridge controls reject the import/re-export producer, not downstream aliases.
Runtime ordering, schemas, exclusive publication and cancellation are proved by
the channel/observer contracts, not by following method calls.

The channel is a registered owner of P03's two private construction modules: it
links borrower scopes to their directory owner and binds issued plugin fixture
roots. Its contract test is registered the same way as the P03 scope test. The
channel's stricter root policy still rejects bare `Promise` references.

Promise-only reads and observations reject retirement through their promises;
native readers, cancellation and native publication keep synchronous fences.
Publication captures its options and method receivers once and observes arbitrary
IO completions once before advancing to commit or staging cleanup. Contract-only
directory preparation and observer construction ports avoid process-global IO
overrides across awaits. Test milestones use P03's admitted fixture gates.

The Sync pilot's Deno surface is an explicit allowlist of environment/error APIs
and existing fixture-directory construction, not an enumerated record-IO denylist.
Unlisted members, including remove/removeSync and future filesystem APIs, reject
by default; the finite artifact/input inventory is unchanged. Owner exit is
recorded in the first subscribed fulfillment callback. Observation joins any
pre-exit read but accepts its final snapshot only from a post-exit probe, and
publication checks cancellation before staging custody begins.

The raw protocol facade delegates publication to the import-free
`record_publication.ts` module with explicit IO capabilities. Restricted native
plugin fixtures copy and import that complete module, never a function's
`toString()` body with missing lexical dependencies. Its runtime import belongs
only to the protocol facade; the same registration rejects ordinary consumers.

## Child pilot registration

P12 registers `process.ts` as the raw launcher module. Its actual child-lifetime
owner, the source graph owner and a values-only facade are exact import owners.
Ordinary child lifetimes use `spawnOwnedChild`; callers needing only DENO or
environment values use `process_values.ts`. Existing raw-launcher imports remain
exact migration records, including selected-member imports: no imported alias or
factory result is followed. Boot has no raw-launcher reference and has explicit
no-private-timer root rules. Its real cleanup/receipt controls prove delegation.
The one existing post-verdict rescue is counted, not a permanent owner allowance.

Child acquisition returns an owned handle. Cancellation reaps the child through
`onCancel` before admitted child work drains; LIFO release still joins reaping.
Child custody precedes status subscription and cancellation-hook setup. Its
acquisition disposer also closes piped stdin; uncreated pipes are never touched.
Status retirement is recorded in the first callback on the native status promise.
Boot uses an explicit Deno allowlist and rejects health outcomes after actual
child exit, including outcomes returned through the contract-only health IO port.
Boot admits layout metadata and health effects through both the layout owner and
the runtime borrower. Layout retirement cancels and joins its child runtime before
releasing roots; acquired values stay in handles across awaits.

## Layout and completed-build registration

P15's public completed-build facade exports only successful concrete build entry
points. Injected producers and the installer live in a private module registered
to the layout owner, facade and owner contract. Boot and the prefix fixture have
explicit root rules denying raw directory acquisition/copying; the layout/build
owners retain those direct roots. Product note and artifact byte writes stay real.
The migrated prefix command occurrence and boot's obsolete std filesystem import
are removed from inventory in the same commit. No factory-result or build-path
string heuristic remains; runtime contracts prove successful production, immutable
captured bytes, scoped installation and borrowed-root behavior.

Boot, the prefix fixture, the layout owner and the completed-build owner each
have an explicit Deno member allowlist. The native fixture's permitted stream,
network and evidence APIs do not widen boot's filesystem surface. Construction
captures input/options once, and both server close adapters join their cached
close promise. Every live borrower of the cached build links to its producer
scope, so cancellation can reap the child before admitted work drains. A
producer retired before issuing its input is never joined: a later borrower
starts a fresh producer even before the cancelled job's rejection settles. Native
readiness fences actual exit and scope retirement after IO; donor preservation
compares the donor's captured bytes or absence, never private-build equality.
Readiness IO uses the P04 bound-operation owner inside layout admission, including
native health, catalogue transport and body parsing. Cancellation-ignoring IO or
body disposal cannot retain that admission. Root cleanup remains tracked through
failed construction/removal until successful removal or confirmed absence. P15
contracts use the shared scoped gates and private cancellation waiter, without
adding raw coordination allowances.
Native catalogue body ownership includes the locked reader, not only the
Response: cancellation releases that reader without joining uncooperative body
IO. Boot retains the generation's output observer and the shared
UnexpectedServerExitError distinction; native close uses the same bare verdict
only after successful cleanup. Pre-handoff native publication failures remain
inside construction custody and cannot leave a child or owned layout behind.
Build acquisition checks borrower custody after capturing caller options, before
donor inspection, producer entry or cached delivery. A getter cannot retire the
borrower and still obtain the cached input.

## Operation leases and sinks (P05)

`OPERATION_OWNERSHIP` composes `RESOURCE_OWNERSHIP` and registers the lease issuer
and private guarded sink modules with exact authority/middleware/contract owners.
Ordinary consumers may import erased lease types, not runtime private factories.
An alias or bridge fails at its producer's private import, not a later call site.
The 15 former flow-site allowances are removed. Final-effect synchrony, issued
provenance, mode binding and actual value/chunk delivery remain runtime/type
contracts; there is no flow hook or arbitrary callback-body scanner.

Lease issuance captures explicit parent dependencies. A check evaluates all
ancestor and child witnesses before a final pass of pure owner-lifetime fences.
Private sinks inspect prepared values (including potentially reentrant getters)
before that check, then invoke only the bound synchronous delivery with no
result inspection or payload return. Public disclosure returns a lazy
single-value stream retaining the opaque handle until pull, not unsealed data
for a later queue. Stream chunks use the same inspection/fence/enqueue ordering.

Credential verification is shared only for the same request and admitted session
owner. Both admission paths retain that owner across verification. Stream
cleanup starts reader cancellation while locked, observes its rejection, and
releases the lock without waiting for an open tee peer or other pending
cancellation.

The authority family shares its prepared-handle and stream engine in private
`server/internal/authority_disclosure.ts`. Instance leases expose the same
`prepare`, `read`, `disclose`, `body` and `stream` ports without selecting a
vault; `body` serializes JSON before the last enqueue fence. `readInstance`
permits a guest status projection, not own-account access. Compatibility
`instanceGuard` uses the same live instance lease. Both prepared constructors
still require an issued live composition lifetime; request cancellation and the
captured session owner are explicit parent dependencies, not nested assertion
callbacks.

An `acknowledgment` surface requires a domain-issued outcome lease and retains
the composition as a parent. It supplies no live authority or credential-change
policy. The later domain workflow binds its exact historical receipt.

Plugin RPC's host-only `prepareDisclosure` issues a handle whose synchronous
read selector runs at posting. `disclose(handle)` queues only that operation's
handle. The captured native Worker post receives a structured-cloned response
envelope, after selector, payload getter, error projection and source inspection
complete. Generation, source binding and live child context are checked at the
final sink. Only correlation fields and the existing RPC payload cross IPC; the
lease and principal never enter the envelope. Metadata get/query is the bounded
pilot; viewer continuation and production instance activation remain later
adoptions. The private engine is importable only by authority and the trusted
plugin host.

## Owned publication (P06)

`PUBLICATION_OWNERSHIP` composes the operation policy with exact import owners
for the publication adapter and private writer port. `BoundFileStore` registers
its private preparation method by exact instance in that port; preparation is
not a public instance/prototype member. Public errors and receipts live in the
pure `publication_outcome.ts` module, with compatibility re-exports from the store.

`IdentityFile` retains only the owned adapter, not the raw writer. The same
analyzer applies `PUBLICATION_PILOT_OWNERSHIP` to the pilot and adapter: runtime
imports of the raw store and filesystem modules, and direct filesystem mutation
roots, require exact owners. Other existing writers are not migrated by P06.
The ten former flow-site allowances are removed. Candidate identity/bytes, final
lease/CAS, exact installation, committed warnings and recovery fences remain
runtime/type contracts, including all 18 publication mutations.

Publication storage validation is a child of the admitted live lease: parent
callbacks run first, candidate bytes/CAS and permissions are validated next, then
all lifetime fences run immediately before the bound native link/rename. The
private sink returns no payload. Runtime installation and receipts describe the
already-committed operation rather than granting another live effect.
Inspection returns an envelope, not the result of the write.

The compatibility `IdentityFile.commit` guard keeps its `() => void` contract:
ordinary synchronous return values are ignored. Async functions reject before
entry; returned thenables reject before staging. The lease witness itself always
returns `undefined` after the guard finishes synchronously.

Candidate creation exclusively opens a private file and immediately registers
store-owned cleanup custody. Identity comes from that original descriptor, never
an unverified pathname. Custody keeps the original descriptor open through
preparation and failed cleanup, pinning its inode for every identity-based retry.
Cleanup checks that descriptor is still live before using cached device/inode
numbers. A positive zero-link count means the owned file is already gone: cleanup
revokes unlink authority and closes the descriptor without touching its old path.
Otherwise it keeps the descriptor pinned across transient failures until cleanup
succeeds, then closes it and clears custody.
If identity acquisition fails transiently, the same descriptor remains available
for retry. A lost descriptor releases custody without unlinking or retaining its
cached identity. Failed cleanup remains store-owned and is retried on the next
preparation, without blocking unrelated mutations or replaying an already-reported
warning. Active prepared candidates are not cleanup requests. Discard retires
publication and marks unpublished candidates discarded before cleanup; committed
candidates stay committed, but their temporary aliases remain cleanup-retryable
through either the prepared handle or the store.

Before unlinking, cleanup compares the pathname's
device/inode to the original descriptor's identity and rejects a mismatch. This
check and the pathname unlink are separate operations: an external writer can
replace the name between them, and that replacement can be removed. Deno has no
descriptor-relative unlink; service write serialization does not exclude external
writers or eliminate this residual window.

## Sign-in delivery (P08)

The preparatory instance sign-in API returns an issued principal and a lazy
response body, never raw token fields. Its private stream retains signed bytes
and the claimed proof until native enqueue or cancellation. Parent, claim and
session-validation callbacks precede the final lifetime fences. Proof completion
and retirement happen after actual delivery, not before those fences. Tests
consume the real JSON response body through a test-only consumer helper; active
legacy sign-in handlers are unchanged.
Inspection returns a plain envelope; token bytes are delivered data, never a
pending inspection result.

The aggregate may reject sign-in with `AuthenticationError.code` equal to
`authenticator_required` only after a correct password and current account/owner
checks, including after the verifier returns. Missing or empty code spends no
TOTP step and issues no proof or session. The next submission verifies the full
credentials again; no challenge is retained. Other failures and credential-change
verification remain generic, including adapter-thrown errors with that code.

## Credential publication dependencies (P09-P10)

Credential commands pass their admitted domain/aggregate lease through the sealed
transition and repository adapter to the identity writer. Prepared account writes
retain the same chain; offline recovery also retains the issued recovery-lock
lease. Storage validation runs before final fences for every ancestor, rather
than relying on nested assertion callbacks that finish before storage checks.
Post-commit redacted identities remain acknowledgments, not permission for a
second write. Candidate and decoded-account maps stay local to their issuing
aggregate; no request-only credential cache is introduced.

## P02 resource boundary

`tests/helpers/ownership_rules.ts` composes `RESOURCE_OWNERSHIP` from
`PROCESS_OWNERSHIP`. Only the public facade `shared/ownership.js` may import or
re-export `shared/ownership-engine.js`; ordinary consumers and the native
finalizer use the facade. The always-selected isolation contract supplies this
policy explicitly. No analyzer hook or value-flow interpretation is involved.

The engine's platform-free contract runs the same analyzer with public runtime
root members removed and checks its dependency manifest is empty. Resource
identity, retirement, rollback, transfer, error preservation and exactly-once
all-attempt finalization remain runtime/type contracts. Import permission does
not prove arbitrary adapter logic delegates correctly. P02 migrates none of
P01's 90 process/root sites and adds no inventory allowance.
