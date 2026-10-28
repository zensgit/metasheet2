# Approval FWB exact-decimal compatibility design lock - 2026-07-21

**Status: PROPOSED.** Docs only. This lock does not ratify itself, does not
authorize runtime work, does not assert that any described runtime exists, and
does not assert that CI has passed. Owner ratification is required before a
production implementation or any related flag is enabled.

**Grounding baseline:** origin/main@749ba92d0edc794996334c46c7c2c87d8a11de69.
The completed architecture audit used that exact baseline. This document is a
precondition for enabling **number-field mappings** in the FWB production path
defined by approval-form-writeback-fwb0-designlock-20260712.md. It does not
block independently verified text, date, select, or record-link mappings, and
it does not replace that lock's authorization, permissions, idempotency, or
durable-delivery contracts.

## 1. Problem and stop rule

FWB must be able to move an approval form value into a multitable record,
revision, and downstream automation without changing its numeric meaning. The
current baseline cannot make that claim. For example, an applicant entering the
literal 9007199254740993.1 can be converted through JavaScript Number to
9007199254740994. Distinct values such as 9007199254740993.1,
9007199254740993.2, and 9007199254740994.1 can therefore collapse before the
FWB mapper, writer, revision, or outbox see them.

The audit located loss at least at these boundaries:

| Boundary | Current source ownership | Current unsafe shape |
| --- | --- | --- |
| Approval form input | apps/web/src/views/approval/ApprovalNewView.vue | el-input-number stores a JavaScript number. |
| Detail amount total | apps/web/src/approvals/amountAutoSum.ts | Math.round and JS-number accumulation. |
| FWB mapping | packages/core-backend/src/multitable/approval-form-value-mapping.ts | Numeric strings are coerced with Number(...). |
| Record editing and import | MetaCellEditor.vue, MetaGridTable.vue, MetaRecordFieldsPanel.vue, MetaFormView.vue, multitable/import/delimited.ts | Common paths use Number(...). |
| Write validation | field-validation-engine.ts, record write services, Plugin SDK | Numeric bounds and some SDK inputs use JavaScript numbers. |
| Semantics | univer-meta.ts, automation-conditions.ts, formula engine | Numeric sort/filter/condition/formula paths use Number, lexical string comparison, or floating arithmetic. |

**Stop rule:** number-field FWB mappings remain prohibited until the mandatory
D0-D4 gates in this lock pass. Both save-time validation and execute-time
validation must reject a number mapping while the exact-decimal capability is
unavailable. This type-level stop rule does not block other FWB mapping types
whose own gates pass. A mapper-only repair is not sufficient for numbers: it
would preserve neither the applicant input nor later numerical semantics.

## 2. Decimal-string-v1 contract

### 2.1 Stored representation

For every multitable field declared as an exact numeric field, the JSON value is
a JSON string containing decimal-string-v1, never a JSON number. The string is
the authoritative numerical value in live records, revision patches, revision
snapshots, approval form_snapshot, FWB payloads, durable events, and idempotency
inputs.

Approval exactness is authoritative at two layers. A published template version
marks each exact approval number source with
`valueFormat = 'decimal-string-v1'`; an unmarked `type = 'number'` field is
legacy and cannot source an exact mapping. Each approval instance also has a
dedicated `form_snapshot_format` column, added by migration, whose exact value is
`decimal-string-v1`. The marker is not stored inside the field-id map, where it
could collide with a user field id. Publication and submission validate the
frozen field markers and stamp the instance column in the same transaction as
the snapshot. Legacy application versions do not write the marker, and their
snapshots remain ineligible rather than being inferred exact from parsed values.

decimal-string-v1 has two forms:

1. A user literal accepted at an input boundary:
   ^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$
2. The canonical stored form after exact normalization:
   ^(?:0|-?(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$

The canonical form has no leading plus sign, exponent, leading zero, negative
zero, or trailing fractional zero. Thus +1, 01, 1e3, -0, and 1.2300 are not
stored forms. Accepted input is either rejected or normalized to 1.23 before
any write. Formatting for a declared field scale may add display zeros without
changing stored data.

The proposed v1 limits are:

| Limit | Proposed value | Reason |
| --- | ---: | --- |
| Significant decimal digits | 38 | Bounded, portable exact arithmetic and sufficient for common operational values. |
| Fractional scale | 18 | Preserves high-precision business values while bounding formula and UI work. |
| Integer digits | 38 | No hidden conversion to IEEE-754. |
| Input length | 64 bytes | Bounds parsing and audit surfaces. |

These are proposed owner decisions, not a claim about existing field limits. A
field's configured display precision is a validation and presentation limit; it
is not permission to round a stored value silently. If a canonical value exceeds
the target field's accepted precision or scale, the write fails closed with a
typed validation result.

### 2.2 Shared implementation boundary

D0 creates one directly-declared workspace dependency, proposed as
@metasheet/exact-decimal, backed by decimal.js or an owner-approved equivalent.
It exposes only:

- parseExactDecimalInput and normalizeExactDecimal;
- branded ExactDecimalString values;
- exact compare, add, subtract, multiply, divide with bounded result rules;
- field precision/scale validation and display formatting;
- text-preserving legacy-number extraction and conversion for reads only.

No consumer may reimplement the grammar with Number, parseFloat, native
arithmetic, or lexical comparison. decimal.js must be a declared production
dependency of the shared package, not an incidental transitive dependency of a
test environment.

### 2.3 Legacy JSON number compatibility

Existing JSON numbers remain readable, but the compatibility adapter must not
receive them after the PostgreSQL driver has parsed JSONB through JavaScript.
The driver uses JSON.parse, so a stored JSONB token such as
9007199254740993.1 can still contain recoverable decimal text while the parsed
JavaScript value has already become 9007199254740994. D0 therefore reads legacy
numeric tokens through a text-preserving database expression such as
`data ->> field_id` (or an equivalently proved raw-JSON decoder) before exact
parsing. Calling String on a deserialized JavaScript number is prohibited at
this boundary.

The database boundary receives the original JSONB value, not only `->>` text,
and branches on `jsonb_typeof`. A JSON number is legacy input and its token is
extracted in PostgreSQL before JavaScript parsing; a JSON string must already be
canonical decimal-string-v1. Missing and JSON null both map to SQL NULL and do
not fabricate a numeric value. This distinction is load-bearing: a legacy JSON
number `1.2300` may normalize from its database token, while a JSON string
`"1.2300"` is a noncanonical new representation and is rejected.

This remains compatibility, not historical recovery: digits lost before the
JSONB value was stored cannot be reconstructed. Legacy exponent tokens are
expanded exactly only when their expanded canonical form is within the v1
digit, scale, and byte limits; otherwise the read returns a typed
LEGACY_EXACT_DECIMAL_OUT_OF_RANGE result and no exact write, formula, filter, or
FWB action may proceed from that value.

New writes for an exact numeric field use decimal-string-v1. Reads, filters,
sorts, validation, automation, and formulas must accept a mixed population of
legacy JSON numbers and canonical strings. Every record, history, restore,
export, and API read that can expose an exact field obtains that field through a
database-side exact projection: PostgreSQL dispatches on JSON type, extracts the
token, and returns canonical string text. A caller may also select the containing
JSONB object for non-exact fields, but it must overlay the database-projected
exact strings before any value is logged, compared, emitted, or serialized.
Returning the driver-parsed legacy number is prohibited. The comparison is exact
with respect to the stored legacy number's current token. A later non-destructive
migration may rewrite legacy finite numbers to their current canonical string,
but must not claim to restore historical precision or alter revisions.

## 3. Mandatory invariants

1. **No lossy ingress.** Approval forms, detail cells, grid edits, record
   drawers, forms, paste, CSV import, REST, batch write, Plugin SDK, and Yjs
   flush validate and store exact strings for exact numeric fields. JSON numbers
   are not accepted as new exact writes.
2. **One semantic contract.** TypeScript consumers call the shared package.
   Database-backed filter, sort, and keyset paths call the immutable
   `metasheet_exact_decimal_v1(jsonb)` function, which preserves JSON token type,
   validates the same grammar and bounds, then returns PostgreSQL `NUMERIC`
   without a fixed typmod. Missing/JSON-null inputs return SQL NULL. A fixed
   `NUMERIC(38,18)` is prohibited because it permits only 20 integer digits,
   while the contract permits up to 38 significant digits at lower scale. A
   parity corpus proves identical
   ordering, equality, rejection, and cursor behavior.
3. **No silent rounding.** A target precision or scale violation rejects the
   complete FWB action. It never rounds, truncates, coerces to a JS number, or
   writes a partial mapping.
4. **Byte-preserving history.** Record revisions, snapshots, PIT
   reconstruction, restore, JSON API reads, CSV export, and XLSX text export
   preserve the canonical string verbatim.
5. **Same transaction for FWB effects.** FWB business claim, record mutation,
   revision, and durable outbox rows commit in one database transaction. A
   failure leaves no new record or record-mutation residue and no new revision,
   claim, or outbox row. An FWB-2/3 target that existed before the transaction
   remains present and byte-identical.
6. **At-least-once transport, net-effect-once write.** Existing
   durable-delivery and FWB idempotency contracts remain in force. Replays may
   reattempt but may not create a second record, revision, or outbox effect.
7. **Irreversible v1 exactness.** An exact field cannot be downgraded to legacy
   number storage. Property PATCH, restore, duplication, provisioning, or a flag
   rollback cannot change true to false or remove the exact-field authority row.
   Rollback stops new activations and exact FWB actions while permanent mixed
   readers and exact writers continue to protect already stored strings.
8. **No oracle or value leak.** An unauthorized caller cannot learn a target
   record's existence, exact value, configured precision, or formula state from
   an error. Logs and audit events record identifiers, decision codes, and
   normalized metadata only, never approval values or decimal literals.

## 4. Staged implementation and exact ownership

The stages are ordered. D1-D4 must not be presented as complete merely because
their pure helpers compile.

### D0 - shared contract and migration posture

**Owner:** core shared-types and multitable foundations.

- Add the shared exact-decimal package and direct dependency declaration.
- Define field metadata that opts a number field into exact storage; define the
  read compatibility adapter for old JSON numbers. The adapter must extract the
  database token as text before any JSON.parse/JavaScript-number conversion.
- Make a normalized `meta_exact_decimal_fields` registry, not a mutable JSON
  property alone, the authoritative exactness state. Database privileges and
  triggers prevent direct registry updates and prevent a raw `meta_fields`
  property replacement from creating, deleting, or downgrading exactness. V1 has
  no deactivation operation.
- Add an exact-field activation preflight. It scans every live and recoverable
  stored value through database-token extraction, reports identifiers and typed
  reasons without values, and refuses activation unless all values fit the
  ratified bounds. Activation acquires a database-enforced per-sheet write lock,
  rescans, and inserts the registry row in that same transaction. A trigger on
  every `meta_records` INSERT/UPDATE acquires the same sheet lock, consults the
  registry, and rejects a JSON number or noncanonical string for an exact field.
  Equivalent validation triggers cover new canonical after-images written to
  revisions, trash, and field-value tombstones, while pre-activation historical
  rows remain byte-untouched. Archival capture of a legacy live row is a separate
  database operation: restricted capture functions use `INSERT ... SELECT` from
  the authoritative source JSONB and stamp immutable-source provenance in the
  same statement, so no JavaScript parse/serialize round-trip occurs. The archive
  trigger permits a legacy JSON number only when that function proves byte-
  identical capture from the locked source row; a caller-provided mode flag or a
  newly constructed JSON number is rejected. Delete, PIT reset, revision, trash,
  and tombstone writers must use this capture boundary. These triggers protect
  old or missed application writers; the
  optional
  `MULTITABLE_ENABLE_WRITER_FENCE` application flag is not accepted as this
  guard. REST, batch, SDK, Yjs, import, automation, restore, and internal writers
  still use the application fence for orderly errors, but correctness does not
  depend on cooperation. Ordinary post-activation reads are not the discovery
  path for out-of-range legacy data.
- Make the activation service the **only** path for an exactness transition.
  Field PATCH, config restore/revert/undelete, template or plugin provisioning,
  sheet/field duplication, migrations, and internal metadata writers may carry
  ordinary property changes, but any absent/false-to-true exactness change must
  call the activation service or fail closed, and any true-to-false/removal
  attempt fails permanently in v1. Direct property JSON replacement cannot
  create or remove an exact field. The database guard is primary; a bidirectional
  writer census and per-entrypoint tests prove the application surfaces use it.
  No allowlist entry may merely assert safety.
- Serialize cross-sheet dependency discovery. Activation, formula/rollup/link
  config writers, and exact-field transition writers use one total lock order:
  admission singleton, one global exact-metadata advisory transaction lock,
  every source and dependent sheet id in sorted order, authority rows, then
  record rows. Writers take the singleton's shared lock and generation
  advancement takes its exclusive lock as specified below; both then continue
  in the same order. The global
  lock prevents a new cross-sheet dependency phantom while activation discovers
  dependents; sorted sheet locks bound ordinary contention and prevent lock-order
  inversion. A source-sheet activation racing a rollup/lookup creation on another
  sheet must serialize to one of two valid outcomes: the config commits first and
  activation inventories/rejects it, or activation commits first and the config
  writer enforces exact semantics. Locking only each writer's local sheet is not
  sufficient.
- Add a persistent database admission epoch backed by generation-specific
  database identities, not a point-in-time fleet report or a caller-asserted
  version. Exact-aware binaries receive a new non-inheritable login/role whose
  credential is never distributed to N-1; the legacy application role cannot
  inherit or `SET ROLE` to it. Before the first activation, ownership of the
  application schemas, tables, sequences, triggers, and SECURITY DEFINER
  functions is transferred away from the legacy runtime credential to a
  dedicated non-login owner/migration role. No runtime login is a member of that
  owner role or has `WITH GRANT OPTION`, schema `CREATE`, trigger-disable, or
  function-replace authority. `EXECUTE` is revoked from `PUBLIC`; each SECURITY
  DEFINER function is owned by the non-login role, pins a safe `search_path`,
  schema-qualifies objects, and validates caller role and payload. The migration
  credential is distinct from every runtime `DATABASE_URL` and is not present in
  application pods. Merely revoking privileges from a table owner is explicitly
  insufficient because owners retain implicit authority.

  After that ownership split, direct DML on owned data,
  semantic-config, recovery, and background-writer tables is revoked from both
  generations. Exact-aware writers receive only `EXECUTE` on generation-pinned
  SECURITY DEFINER stored write functions that validate the payload and stamp
  the admission epoch from `session_user` exclusively. An updatable or directly
  writable view is not an alternative admission path.
  `current_user` is prohibited for admission because a SECURITY DEFINER call
  changes it to the common function owner. The function maps the authenticated
  login role OID/name to a closed generation registry; an unknown role, the
  non-login owner identity, or any role without the current generation fails
  before mutation. Before reading either registry or minimum, every stored
  writer locks one pre-existing singleton admission row `FOR KEY SHARE` and
  retains that lock until its transaction commits or rolls back. Triggers compare
  the DB-authenticated role generation with the minimum recorded by that row and
  never accept a manifest/version argument supplied by the caller. Generation
  advancement runs only in a transaction pinned to `READ COMMITTED` before its
  first statement. Its first database statement only locks the same singleton
  row `FOR UPDATE`; after any blocked writer commits, all drained-worker checks,
  data/config/recovery rescans, and authority reads execute in subsequent
  statements and therefore receive fresh statement snapshots. It then updates
  the singleton minimum and revokes the old generation in that one transaction.
  An old writer already holding the shared lock commits entirely before the
  activation's fresh-snapshot rescan; a writer whose `REPEATABLE READ` snapshot predates a
  completed advancement must observe the updated row or receive a serialization
  failure when it tries to lock it. A frozen MVCC snapshot may never authorize a
  post-advance write, and an activation transaction may not run at
  `REPEATABLE READ` merely because row locks establish commit order.
  Activation remains disabled until all exact-aware workers use the new identity
  and all N-1 instances are drained, then performs the locked atomic advance
  above. A late N-1 restart, or raw SQL using the old/shared
  application credential, cannot acquire the new role or call its write functions
  and is rejected before mutation. Raw SQL using the new role still cannot bypass
  validation because it has no direct table DML. This is mandatory because
  semantic configuration is spread across typed JSON surfaces that cannot all be
  made safe by the record-data trigger alone. Rolling-deploy tests cover both an
  old writer present during activation and an N-1 process that restarts after the
  admission epoch advances. Activation also retains a tested exact-aware rollback
  artifact that uses the current stored-function ABI and the current generation
  credential. Operators may roll back only to that compatible artifact after the
  minimum advances; redeploying an N-1 image or re-granting its revoked role is
  prohibited. A deployment rollback rehearsal proves the retained artifact can
  read and write after activation without weakening the admission floor. Tests
  also prove the old role cannot re-grant itself,
  disable/replace a trigger, create a shadow function in the resolution path, or
  assume either the new writer or owner role.
- Add `metasheet_exact_decimal_v1(jsonb)` as the database comparison boundary.
  It validates significant digits and scale explicitly, then returns untyped
  PostgreSQL `NUMERIC` only for valid legacy/canonical tokens. It has corpus
  parity tests against the shared package; no fixed typmod substitutes for the
  v1 bounds. It distinguishes canonical strings from legacy numbers through
  `jsonb_typeof`; reducing both to text before validation is prohibited.
- Add parsers, canonicalization, bounds, comparison, formatting, and a typed
  failure taxonomy.
- Inventory every existing Number, parseFloat, native arithmetic, and lexical
  numeric comparison in the owned paths. Each site is classified as D1-D4
  mandatory, explicitly legacy-read-only, or an approved later non-goal.
- Define an upgrade plan that preserves existing JSON and revision bytes.

**D0 exit:** a direct production dependency, contract tests, an exhaustive
inventory, the database-enforced activation protocol, and the persistent writer-
admission barrier exist. A constructed two-transaction test proves even an N-1/raw SQL
writer cannot commit an invalid value between preflight and registry activation.
A pair of isolation interleavings is mandatory. The first pauses an old-
generation `REPEATABLE READ` stored writer before its admission-row lock and
proves it either orders before advancement or fails serialization after the
singleton update, with no post-advance mutation. The second lets a writer hold
the shared lock and write, starts `READ COMMITTED` activation so its first
singleton-lock statement provably waits, commits the writer, then proves the
activation's subsequent rescan observes and rejects that value. Forcing the
activation back to `REPEATABLE READ` must turn the second test red.
An N-1 process restarted after activation cannot acquire the current admission
epoch and cannot write a semantic config, recovery artifact, or exact live value.
The retained current-generation rollback artifact can still perform a valid
write through the same stored-function ABI after activation; an ordinary N-1
binary remains rejected.
Alternate-transition tests prove field PATCH, config restore/undelete,
provisioning, duplication, migration, and internal metadata writes cannot create
or downgrade exactness outside the service. No FWB flag is enabled.

### D1 - approval ingress and FWB production path

**Owners:** apps/web/src/views/approval/ApprovalNewView.vue, the approval detail
editor, amountAutoSum.ts, approval submission validation,
ApprovalGraphExecutor.ts, ApprovalConditionFormula.ts, route preview, FWB
mapping, approval-fwb-write-action.ts, automation save validation, and
production executor registration.

- Replace approval numeric controls with string-preserving decimal inputs. They
  validate on edit and submit, retain the literal until canonicalization, and do
  not bind through el-input-number for exact fields. Published template versions
  persist `valueFormat = 'decimal-string-v1'` on each exact number source.
  Existing templates are not inferred or bulk-stamped: an owner must republish
  them through the exact-aware validation gate before they can source exact FWB.
- Add `approval_instances.form_snapshot_format TEXT NOT NULL DEFAULT
  'legacy-json-v1'` with a closed-set constraint and rolling migration. An
  exact-aware submit validates the frozen published schema, persists canonical
  strings, and writes `decimal-string-v1` in the same transaction. An N-1 submit
  writes the legacy default and is ineligible. FWB reloads numeric source tokens
  from the persisted snapshot using database text extraction, not the already-
  parsed `instance.form_snapshot` object. A legacy/unversioned snapshot, an
  unmarked source field, or one accepted as a JSON number is rejected with a
  typed result; digits already rounded before persistence are never guessed back.
- Make the complete approval runtime/source authority immutable in the database.
  Publication writes a normalized
  `approval_template_exact_sources(template_version_id, field_id, value_format)`
  binding set, the frozen template-version schema/authoring graph, and the
  `approval_published_definitions` compiled `runtime_graph` plus its
  `template_version_id` in one transaction. The binding table has a unique
  `(template_version_id, field_id)` key and a constrained value-format enum. The
  publication function inserts the complete binding set before the definition is
  marked published; after that mark, triggers prohibit INSERT, UPDATE, or DELETE
  of bindings and prohibit UPDATE/DELETE of the frozen version or compiled
  definition authority. Submission writes `form_snapshot`,
  `form_snapshot_format`, `template_version_id`, and `published_definition_id`
  together; triggers prohibit changing any of those source/binding columns after
  INSERT and enforce that the referenced published definition belongs to the same
  template version. A
  correction creates a new template version and/or approval instance rather than
  patching frozen evidence. FWB locks the approval-instance row, compiled
  published-definition row, published template-version row, and complete exact-
  source binding set in deterministic order; it verifies
  `definition.template_version_id = instance.template_version_id`, revalidates
  the runtime/source field type and marker, and extracts the snapshot token from
  those locked DB rows. Raw SQL cannot retain an exact marker while changing the
  authoritative value, runtime graph, schema, binding set, or instance binding.
- Replace amount total arithmetic with the shared decimal engine. The displayed
  total and backend consistency check must share the ratified arithmetic
  context. No context is inferred from UI defaults.
- Convert approval number validation, simple condition rules, formula branches,
  route preview, and runtime routing to the shared exact
  contract. A string-preserving form is not accepted until preview and execution
  select the same branch without Number, lexical comparison, or float fallback.
- Classify both ends of every mapping from authoritative frozen schemas at save
  time and again at execution. A source field whose frozen type is `number`
  remains prohibited unless its published marker and the instance snapshot marker
  are both `decimal-string-v1`, even when its target is text/select or the saved
  mapping claims a non-numeric target. Target type alone can never classify a
  mapping as non-numeric. An exact numeric source may be copied to a compatible
  text target only as its canonical string and only after all D0-D4 gates pass.
- Make mapApprovalFormValues output ExactDecimalString for a number target;
  remove Number(raw) from FWB mapping. Before coercion, the action reloads the
  authoritative target field property and distinguishes exact from legacy
  number fields. A saved targetType string is not sufficient authority.
- Build the authorized FWB production chain behind its existing default-OFF
  controls: action registration, save gate, executor dispatch, target metadata
  re-read, permission checks, and the same-transaction claim/record/revision/
  outbox composition. Save-time and transaction-time checks derive every mapped
  target field's current permission for the ratified FWB actor and call the same
  `isFieldWriteForbidden` semantics as ordinary record writes. A hidden,
  read-only, missing, or otherwise non-writable target field rejects the entire
  action before claim/write; sheet-level write is insufficient. This lock does
  not claim that chain exists today.
- Serialize the transaction-time metadata and authority checks, not merely
  re-read them. FWB and every role, member-group, base/sheet permission, field-
  permission, precision, exactness, and target-field config writer acquire the
  same database authority/fence keys in a fixed order before reading or changing
  those rows. FWB then locks the approval instance, compiled published definition,
  published version and complete exact-source binding set, authoritative target
  field rows, and target record before
  claim/write. A concurrent revoke or config/source change either commits
  first and is observed, or waits until the FWB transaction commits; disjoint
  advisory and row-lock schemes are not accepted as proof.
- Exact FWB execution requires the conjunction of the exact-decimal, FWB, and
  durable-delivery capabilities. Startup rejects an impossible flag combination.
  Inside the FWB transaction, enqueue must return the inserted durable outbox row;
  `null`, disabled delivery, or any enqueue failure aborts claim, record,
  revision, and outbox together. It is not legal to commit three artifacts and
  treat the missing fourth as a later repair.

**D1 exit:** v1 maps persisted top-level exact approval fields only. Detail
rows, cells, totals, and aggregates are not mappable until a separate frozen
aggregate-source schema defines aggregate identity, operator, result scale,
empty-set behavior, snapshot key, transactional stamping, row identity, and
one-vs-many record creation. An exact top-level value survives to a FWB-created
record as a JSON string with an identical canonical value. A
failed validation, field-permission check, durable prerequisite, or transaction
writes nothing.

### D2 - ordinary record writing and editing

**Owners:** record REST and batch writers, RecordWriteService, Plugin SDK records
API, Yjs bridge, MetaCellEditor.vue, MetaGridTable.vue,
MetaRecordFieldsPanel.vue, MetaFormView.vue, delimited import/export, and both
browser/backend XLSX import paths.

- Every ordinary write entry validates exact numeric **string** input and
  persists a canonical string for an exact field. REST, batch, Plugin SDK, FWB,
  Yjs, and import entrypoints reject JSON numbers for exact fields because a JSON
  parser may already have rounded them. Legacy numeric compatibility is a
  database-read rule only; a new request has no preserved database token.
- Every editor and paste/import path displays and edits the value as text, not
  a JS number. Invalid text remains visible to the editor and is rejected at
  save; it is never replaced with a nearby number.
- Plugin and REST contracts document the accepted string form and reject JSON
  number input for exact fields. Only the legacy database-read adapter may
  normalize from a text-preserved database token.
- XLSX import uses one explicit policy on both browser and backend paths. For v1,
  exact fields accept text cells containing decimal-string-v1; numeric workbook
  cells are rejected because the workbook may already have rounded them through
  IEEE-754. The importer must retain the cell-kind evidence needed to enforce
  this rule rather than flattening every cell with `raw: false` first.
- Define one database-produced `ExactRecordEnvelope` for every recovery family.
  It contains the untouched source JSONB plus a field-id-to-canonical-token map
  produced from the source column in PostgreSQL before the driver parses it.
  Preview, diff/hash, authorization, execute, and after-image construction all
  consume that envelope; no path first selects an entire JSONB snapshot and then
  calls `JSON.stringify` on a driver-parsed number.
- Capture is part of the same contract as restore. Delete revision, trash,
  tombstone, and PIT archival paths copy legacy source JSONB through the restricted
  database capture function described in D0. They preserve immutable source bytes
  even after field activation; only new live values and new after-images must be
  canonical strings. A test that deletes a post-activation mixed legacy row must
  both succeed and prove byte-identical archive data, while a synthetic legacy-
  number archive insert is rejected.
- Revision restore, batch restore, trash undelete, field-value-tombstone
  undelete, PIT reset/revert, record reconstruction, and every future recoverable
  store register in a closed recovery-family manifest and use the envelope.
  Historical source revision/trash/tombstone bytes remain unchanged. Restoring an
  in-range legacy JSON number into an exact field extracts its token in the
  database and writes a canonical decimal-string-v1 value to the new live row and
  new after-image; out-of-range or noncanonical inputs fail closed with no live
  mutation. Restore never writes a legacy JSON number into an exact live field.

**D2 exit:** an ordinary create, patch, bulk update, SDK write, Yjs update,
drawer edit, form edit, paste, and import all preserve the same canonical value.
The recovery-family manifest is exact and bidirectional: each registered family
has a token-preservation test, and any discovered recovery writer missing from
the manifest fails required CI.

### D3 - semantic consumers

**Owners:** field-validation-engine.ts; view query/filter/sort in
routes/univer-meta.ts; Plugin SDK filtering, sorting, and keyset pagination in
multitable/query-service.ts; automation rule editor and
automation-conditions.ts; row-permission numeric predicates; rollup reducers;
and formula engine arithmetic/comparisons.

- Replace min/max validation with exact comparison.
- Every semantic operand boundary is string-only for an exact field: REST/SDK
  filters, saved-view predicates, validation min/max, automation conditions,
  row-permission predicates, approval visibility rules, field defaults,
  declarative conditions, resubmit/prefill snapshots, detail `derivedFrom`
  arithmetic, approval formulas, and formula literals reject JSON numbers before
  they can pass through JavaScript Number. Their editors hold and submit decimal
  strings. A closed semantic-config manifest enumerates every persisted family.
  Exact-field activation inventories all manifest entries; a legacy JSON-number
  operand or a noncanonical string blocks activation until an authorized author
  re-saves and re-confirms it as a canonical string. Semantic-config writers
  acquire the persistent admission epoch, global exact-metadata lock, and sorted
  source/dependent sheet locks described in D0 before they re-read exactness and
  commit. Their database triggers and stored write functions reject a legacy or
  missing DB role generation, so a late N-1 restart cannot reintroduce an old
  JSON-number config after activation.
  The system does not silently normalize policy or routing configuration whose
  original literal may already have been rounded.
- Replace numeric view filtering and sorting with exact comparison across mixed
  legacy numbers and canonical strings.
- Replace Plugin SDK filter/order/cursor comparisons with exact comparison and
  exact keyset encoding across mixed legacy-number/canonical-string rows. These
  database-backed paths use `metasheet_exact_decimal_v1(data -> field_id)` in
  WHERE and ORDER BY before LIMIT. A sibling immutable function,
  `metasheet_exact_decimal_v1_text(jsonb)`, returns the canonical v1 string by
  JSON-type-aware token parsing and normalization; it does not use bare
  `numeric::text`, whose scale may retain `1.00`. The keyset cursor contains that
  canonical text plus stable record id, and comparison uses the same numeric
  value plus id tie-break. Nulls sort last in both directions. No cursor value is
  reconstructed from driver-parsed JSONB. Ordering is explicit:
  `null_rank ASC, exact_value ASC|DESC, record_id ASC`. Pagination does not use
  a direction-ambiguous tuple shorthand: ASC advances on a greater value or an
  equal value with greater id; DESC advances on a lesser value or an equal value
  with greater id; after the non-null range it advances through the null tail by
  record id. Post-LIMIT JavaScript sorting is forbidden.
- Replace automation condition comparison with exact comparison. String values
  are not compared lexically when the field is exact numeric.
- Replace approval graph declarative comparisons and ApprovalConditionFormula
  literals, aggregates, arithmetic, and comparisons with the same contract.
  Template dry-run/route preview and ApprovalGraphExecutor runtime receive the
  same fixture and must choose the same branch, including detail aggregates.
- Implement exact +, -, *, /, comparisons, SUM, AVG, MIN, and MAX in the
  formula engine. Exactness propagates: any formula or rollup that consumes an
  exact operand has an authoritative exact-result marker in field metadata,
  stores/cache-emits a canonical string, and is compared downstream as exact
  regardless of its outer `type = 'formula'` or `type = 'rollup'`. Authoring and
  execution reject an exact dependency until the complete propagation path is
  implemented. Any unsupported function returns typed #VALUE!; it must not
  silently fall back to IEEE-754 or expose a string that consumers compare
  lexically.
- Treat a derived field's first exact dependency as an activation, not an
  ordinary config PATCH. A candidate formula/rollup config and its complete
  canonical materialized result generation are built in shadow storage. Under
  the complete D0 lock order (admission singleton, global metadata lock, then
  sorted dependency-sheet locks), the service
  revalidates dependencies and atomically publishes the config pointer, exact-
  result registry row, and result-generation pointer. A failed recomputation
  leaves the old config/results visible. The baseline shape that commits config
  before a separately fallible recompute is prohibited. Exactness is irreversible:
  after activation, removing the last exact dependency does not downgrade the
  output field; any later numeric formula still runs under exact semantics. An
  edit to a non-numeric/legacy result type is rejected in v1 unless a separately
  ratified field-replacement migration creates a new field.
- Use a concrete v1 arithmetic context. Addition, subtraction, multiplication,
  SUM, MIN, and MAX are exact and reject a result beyond 38 significant digits
  or 18 fractional digits; they never round. Division and AVG require an explicit
  resultScale from 0 through 18 on the formula/rollup definition and use
  ROUND_HALF_EVEN, then canonicalize trailing zeros. Missing resultScale is an
  authoring and execute-time error. Required expected values include
  `1 / 3` at scale 18 = `0.333333333333333333`, AVG(1,2) at scale 18 = `1.5`,
  and -1.005 rounded at scale 2 = `-1`; multiplication overflow returns typed
  #NUM! and writes no cached result.
- Use this normative operand/error table; existing formula/rollup coercion
  differences are not inherited:

  | Operation | Missing/null | Non-numeric/invalid | Empty input | Exceptional arithmetic |
  | --- | --- | --- | --- | --- |
  | Binary `+ - * /` and comparisons | `#VALUE!` | `#VALUE!` | n/a | division by zero = `#DIV/0!`; overflow = `#NUM!` |
  | `SUM` | skip | `#VALUE!` | canonical `0` | intermediate or final overflow = `#NUM!` |
  | `AVG` | skip | `#VALUE!` | SQL NULL / no scalar result | divide once at declared `resultScale`; overflow = `#NUM!` |
  | `MIN` / `MAX` | skip | `#VALUE!` | SQL NULL / no scalar result | overflow during normalization = `#NUM!` |
  | `UNIQUE` | skip | `#VALUE!` | empty array | canonicalize before equality; invalid token aborts the reducer |

  Formula error operands propagate without conversion. Reducers may normalize a
  legacy database-number token only through the D0 database projection. They do
  not coerce text, booleans, or malformed values to zero and do not silently skip
  them. Bounds are checked after every operator and reducer accumulation, not
  only on the final output; an intermediate value beyond 38 significant digits
  or 18 scale fails even if a later operation could reduce it. Division rounds
  once at the declared scale before the same bounds check. Any error writes no
  materialized cache, revision, or downstream event.
- Implement exact rollup SUM/AVG/MIN/MAX/UNIQUE before exact fields may be
  selected as rollup sources. UNIQUE canonicalizes both legacy numeric tokens
  and exact strings before equality, so `1` and `"1"` are one value. Any reducer
  not proven exact is rejected by authoring and execute-time validation; a
  warning or display-only caveat is not a correctness gate.

**D3 exit:** exact values have the same ordering and decision result in field
validation, multitable/Plugin queries, approval preview/runtime routing,
automation, permissions, and the mandatory formula subset. ASC and DESC keyset
tests include duplicate values and null tails without skips or duplicates.

### D4 - rollout, compatibility, and full-chain proof

**Owners:** migration tooling, API/export surfaces, FWB/durable-delivery
integration, CI ownership, and operations.

- Add upgrade-path tests for mixed legacy/new records and non-destructive
  optional migration, including database-token extraction before JSON parsing,
  exact-field activation preflight, approval snapshot-format migration, published
  source-marker migration posture, and legacy approval snapshot rejection.
- Declare CSV and XLSX exact-decimal output as text-preserving. Any view-based
  export must first use D3 exact ordering/filtering.
- Enforce the D2 XLSX text-cell-only ingress rule on both import
  implementations, with typed rejection of numeric workbook cells.
- Run the FWB-1, FWB-2, and FWB-3 full chains, including retry/replay and
  downstream automation depth, with exact decimal values.
- Run the closed recovery-family matrix and outward API projection matrix. Each
  family must preserve source bytes while returning/writing canonical exact
  strings without first consuming driver-parsed numeric values.
- Add required CI coverage, a production rollout checklist, metrics, alerting,
  rollback posture, and a staged default-OFF flag plan.

**D4 exit:** all mandatory activation gates in section 7 are satisfied. Only an
owner may authorize number-field FWB mappings after reviewing that evidence.

## 5. Frontend input, display, and editor contract

1. Exact numeric fields use a text-based decimal editor with numeric keyboard
   affordances where available. The component holds strings, supports IME and
   paste, and exposes an accessible validation error.
2. The editor must not parse on every keystroke in a way that erases an
   incomplete literal such as -, 1., or a pasted value. It validates and
   normalizes at the defined blur/submit boundary.
3. Display formatting may group digits or pad to configured scale, but copy,
   edit, history, and API payloads expose the canonical stored value. Locale
   formatting never changes the serialized form.
4. The approval top-level form, detail form, approval history/detail view,
   multitable cell editor, record drawer, form view, paste flow, and imports
   use the same component or the same shared parser contract.
5. Date behavior is separate: exact decimal work does not reintroduce date-time
   serialization. Date-only approval fields continue to use YYYY-MM-DD.

## 6. Backend and data contract

1. Field validation accepts canonical strings on writes. Mixed reads accept
   valid legacy database numbers only through text-token extraction and compare
   bounds exactly.
2. Record writers normalize only at validated input boundaries, preserve the
   resulting string in JSONB, and retain revision snapshots/patches verbatim.
3. Query filters, sorting, automation conditions, and row-permission numeric
   predicates call the exact comparator. No lexical comparison is permitted for
   a field declared exact numeric.
4. Formula evaluation uses exact arithmetic for the D3 mandatory subset. A
   failure is explicit and deterministic, never a hidden float fallback.
   Division/AVG require explicit resultScale and ROUND_HALF_EVEN; exact-result
   metadata follows formula/rollup outputs into storage and downstream dispatch.
5. FWB reloads target field type and precision inside its transaction before
   claim/write; it rejects a changed, missing, inaccessible, or incompatible
   target without leaking whether a protected record exists. It also derives the
   current mapped-field write decision for the ratified actor and rejects any
   forbidden field before creating the idempotency claim.
6. The transaction owns all four FWB artifacts: idempotency claim, record
   mutation, record revision, and expanded durable outbox consumer rows. No
   post-commit best-effort emit is allowed, and a disabled/null durable enqueue is
   a transaction-aborting prerequisite failure.
7. Exact-read API projection is canonical string output. Query services may not
   serialize driver-parsed legacy values from a full JSONB row; database-side
   token projections overlay exact fields before any outward or semantic use.

## 7. Activation gates and scope boundary

### Mandatory before FWB production enablement

All of D0-D4 are mandatory for an exact numeric FWB value. In particular:

- Approval form and detail ingress must preserve strings.
- FWB production action wiring must be present and default OFF until accepted.
- Ordinary record writers and editors must not turn the value back into a JS
  number.
- Validation, filtering, sorting, automation conditions, permissions, and the
  D3 formula/rollup subset must use exact semantics.
- Plugin SDK filters, ordering, and keyset cursors must use the ratified database
  exact function before LIMIT, with parity to the shared package.
- Exact-field activation must pass the complete stored-value preflight, and an
  exact FWB source snapshot must carry `decimal-string-v1`. Preflight, rescan,
  registry insertion, and metadata publication share the database-enforced total
  order of admission singleton, global metadata lock, and sorted dependency-sheet
  locks in one transaction. The
  persistent admission epoch rejects missing/old writers, including a late N-1
  restart, and the database record/config/recovery triggers reject invalid side-
  door writes.
- Exactness is irreversible in v1. A downgrade/removal attempt fails closed even
  during config restore, rollback, or flag disablement.
- Approval validation, declarative/formula routing, route preview, and runtime
  graph execution must consume exact strings and produce identical branches.
- FWB mapped-field permission, durable-flag conjunction, transaction/revision/
  outbox, and replay proof must pass.
- The full-chain matrix must prove a string survives approval, FWB, revision,
  restore, read, filter/sort, automation, and export.

Until those gates pass, the server must reject number-field FWB mappings at
both save and execution. Non-numeric mappings follow their own ratified gates
and may be enabled independently; no client-only hiding or operator convention
is accepted as the number-mapping control.

### Later polish, not an excuse to defer mandatory work

Chart rendering, dashboard aggregation outside the D3 rollup reducers,
conditional-formatting polish, footer aggregations, and a broad legacy-data
rewrite are later tracks. They do
not block FWB solely as visual product work. They must, however, remain disabled
or explicitly state their numeric limitation for exact fields until they consume
D0's exact semantic API. They may not silently convert exact strings to JS
numbers.

## 8. Discriminating verification and mutation matrix

| Guard | Required evidence | Mutation that must turn red |
| --- | --- | --- |
| Canonical parser | Unit values for 9007199254740993.1, 0.1 < 0.2, invalid exponent/whitespace/leading-zero cases | Replace parser/compare with Number |
| Approval ingress | Component tests for top-level and detail input retaining full literal | Replace string binding with el-input-number or number coercion |
| FWB mapper | Unit and real-DB action test assert JSON string byte equality; a frozen numeric source mapped to text is still blocked without both exact source markers | Reintroduce Number(raw), or classify solely by saved target type |
| Same transaction | Real DB failure injection after claim, record, revision, and outbox steps | Move any FWB artifact outside transaction |
| Ordinary writers | REST, bulk, SDK, Yjs, drawer, form, paste, and import round trips | Convert one path through Number |
| Legacy extraction and JSON type | Record JSONB numeric token beyond 2^53 and exponent token read through database extraction; canonical string accepted; noncanonical string rejected; missing/JSON-null returns SQL NULL; legacy approval snapshot rejected; versioned string snapshot accepted | Reduce JSONB to text before type dispatch, deserialize before extraction, call String on a JS number, or accept an unversioned snapshot |
| Activation preflight | Mixed in-range/out-of-range field inventory blocks exact activation without exposing values | Skip one stored-value class or permit activation on a typed read failure |
| Activation serialization | Raw legacy writer, cross-sheet rollup creation, and activation races under separate connections; each commits before and is inventoried or waits and is validated after activation; dependency phantoms cannot appear; an inverse interleaving between a config writer and activation proves both acquire admission singleton before global metadata lock and complete without deadlock/starvation; a writer commits while `READ COMMITTED` activation waits on its first singleton-lock statement, and the activation's later fresh-snapshot rescan must observe/reject the write | Reverse singleton/global acquisition, run activation at `REPEATABLE READ`, rescan in the waiting lock statement/snapshot, move scan/registry insert outside the total-order lock transaction, omit a dependent sheet, or remove a live/config/recovery trigger |
| Database/admission barrier | A non-login owner/migration role owns schemas/tables/functions; runtime roles have no ownership/grant/schema-create/trigger-disable authority and PUBLIC has no function execute; legacy and exact-aware workers use distinct non-inheritable DB roles; direct table DML is revoked; SECURITY DEFINER functions map `session_user` only through a closed role-generation registry and reject the owner/unknown identities; every writer locks the pre-existing admission singleton before validation; activation's first `READ COMMITTED` statement locks and later updates that row, then subsequent statement snapshots rescan, so a paused old-generation transaction orders before the advance, is observed, or fails serialization; an old worker and late N-1 restart cannot assume the new/owner role, re-grant itself, replace a trigger/function, or mutate through raw SQL; a retained current-generation rollback artifact writes through the current function ABI after activation while an N-1 image remains rejected | Use `current_user`, read generation before locking the admission row, let activation take an earlier snapshot, omit the shared/exclusive epoch fence, permit an updatable-view bypass, leave runtime as owner, grant membership/role inheritance/direct DML/schema CREATE/PUBLIC execute, trust caller-supplied manifest input, disable the DB trigger/privilege guard, re-enable the revoked generation for rollback, or keep the old generation executable after epoch advance |
| Activation transition choke point | Field PATCH, config restore/revert/undelete, provisioning, duplication, migration, and internal metadata attempts cannot set exactness except through activation and cannot downgrade/remove exactness | Let any metadata writer copy/patch exact=true or clear exactness directly |
| Exact semantic operands | REST/SDK filters, saved views, validation bounds, automation, permissions, approval visibility/defaults/resubmit, detail derived arithmetic, routing, and formulas accept canonical strings and reject JSON-number operands; persisted legacy operands block activation | Parse/stringify any operand through Number, omit one manifest family, or let a config writer bypass the sheet fence |
| Semantic layer | Mixed legacy/string REST and Plugin-SDK filter, sort, keyset cursor, condition, min/max, UNIQUE, reducer, approval routing, and formula cases; SQL-function parity corpus | Replace exact comparator/reducer with lexical or Number comparison, or sort after LIMIT |
| Query keyset | Duplicate exact values and null tails across ASC/DESC pages; cursor bytes are canonical (`1.00` becomes `1`) from `metasheet_exact_decimal_v1_text` | Use tuple comparison, omit null rank/id tie-break, cast NUMERIC directly to text, or derive cursor from parsed JSONB |
| Approval routing | Submission validation, route preview, declarative branches, formula/detail aggregates, and runtime graph choose the same branch | Reintroduce Number/float or leave one preview/runtime path on legacy semantics |
| Arithmetic context/propagation | 1/3 at scale 18, AVG, negative half-even ties, division by zero, null/invalid/empty reducer matrix, intermediate multiplication overflow, formula/rollup exact-result activation, storage, and downstream comparison | Change rounding mode/scale, coerce invalid to zero, skip an invalid operand, commit config before recompute, remove exact-result marker, or return a JS number |
| XLSX ingress | Browser and backend import accept exact text cells and reject numeric workbook cells | Flatten cell kinds before validation or accept a numeric cell |
| History/restore/export | Closed recovery manifest covers revision/batch restore, trash, field tombstone, PIT, and reconstruction; database archival capture preserves mixed-legacy source bytes; synthetic legacy archive writes fail; envelope restores canonical live/after-image; CSV/XLSX emit exact text | Parse/re-serialize before archival, accept caller-asserted immutable provenance, omit a recovery family, copy a legacy number live, or rewrite source history |
| Approval source authority | Frozen template version, compiled published definition/runtime graph, complete exact-source binding set, and instance snapshot/version/definition bindings are stamped transactionally and DB-immutable; post-publish binding INSERT/UPDATE/DELETE and raw authority mutation are rejected; FWB locks and cross-checks all source rows; legacy/N-1 snapshots cannot source exact FWB | Infer exactness from type/value, append a binding, mutate/rebind a frozen schema/runtime graph/snapshot/definition, omit one source lock, or store marker only in the field-id map |
| FWB field permission and durable prerequisite | Hidden/read-only mapped field, concurrent role/group/base/sheet/field-permission revoke, precision/property race, durable-disabled flag combination, and null enqueue all roll back with no claim/record/revision/outbox; sanctioned positive actor succeeds | Check only sheet write, omit a shared authority lock, skip one field, or accept null enqueue |
| No-oracle | Unauthorized/missing target tests return identical public body and bounded query count | Expose target/value/precision distinction |
| Replay | FWB duplicate/retry and downstream automation tests create one net record/revision/outbox effect | Remove idempotency claim or fence |

The standard exact ordering fixture is:

    0.1 < 0.2 < 9007199254740993.1 < 9007199254740993.2 < 9007199254740994.1

Each negative test has a positive control so a red mutation proves the intended
guard, not a broken harness. Real-DB tests assert that the JSONB value type is
string. Canonical-string restore is byte-identical; legacy-number restore keeps
the historical source bytes but asserts the canonical new live/after-image
contract above. For FWB-1, every injected transaction
failure leaves zero new record/revision/claim/outbox rows. For FWB-2/3, the bound
record remains present with byte-identical data and version, and there is no new
revision, claim, or outbox row.

## 9. Rollout flags

1. Exact writes and exact-field activation are introduced default OFF. They may
   use a dedicated MULTITABLE_EXACT_DECIMAL_V1_ENABLED rollout control if the
   owner approves one; no code may treat an unset flag as enabled. Mixed-read
   compatibility and the semantic adapters required to interpret already-
   stored canonical strings are permanent and always on before the first exact
   write. A rollback may never disable those readers.
2. Existing FWB and durable-delivery controls remain governed by their own
   ratified gates. Exact FWB activation is a server-enforced conjunction: durable
   delivery, the applicable FWB class, FWB production, and exact decimal must all
   be enabled. Startup and execute-time validation fail closed on any impossible
   combination; a null durable enqueue aborts the business transaction.
3. Before any field activation, all producer/config/recovery/background binaries
   must report the minimum compatible manifest version and all N-1 instances must
   be drained and exact-aware workers must use the new non-inheritable DB role.
   Activation is pinned to `READ COMMITTED`; its first statement exclusively
   locks the persistent admission singleton, its later fresh-snapshot statements
   rescan, and it then advances the row and revokes the old generation. Every subsequent owned write first holds a
   shared lock on that same row and goes through a generation-pinned
   stored function; direct DML and a missing/stale identity, including an N-1
   restart after activation, are rejected. Rolling-deploy tests cover both old-
   instance timings. The release bundle must also retain and rehearse one exact-
   aware rollback artifact built for the current stored-function ABI and current
   generation credential. After the minimum advances, rolling back to N-1 or
   restoring its revoked role is forbidden; rollback means deploying that
   compatible artifact or forward-fixing.
4. Rollout order is: D0/D1 internal test data, D2/D3 mixed legacy/new staging,
   D4 required CI and real-DB proof, owner UAT, then owner-authorized number-
   mapping enablement. The rollout records error counts by typed code but never
   values.
5. Rollback disables new activations and exact FWB enablement first. It must not
   disable mixed readers, semantic adapters, or exports needed by persisted
   strings, must not downgrade exact fields, and must not rewrite or coerce stored
   exact strings back to JSON numbers. A post-activation binary rollback uses
   only the retained exact-aware artifact with the current generation identity;
   there is no authorization to re-admit an N-1 binary.

## 10. Explicit non-goals

- Recovering digits lost before this contract is deployed.
- A destructive migration of all historical JSON numbers or revision rows.
- New currency, exchange-rate, accounting, or tax semantics.
- Claiming exact semantics for charts, dashboard footers, or conditional
  formatting before their later tracks adopt the shared API. Rollup reducers
  are mandatory D3 work or exact fields remain prohibited as rollup sources.
- Widening FWB source visibility, target read access, or automation permissions.
- Supporting a lossy legacy-number FWB capability. Every number-field mapping
  requires an authoritatively exact target and this lock's D0-D4 gates.
- Enabling a runtime flag merely because this document is written or ratified.

## 11. Owner decisions required for ratification

1. Accept or amend the proposed v1 limits: 38 significant digits, 18 scale,
   64-byte input length.
2. Confirm whether every current multitable number field becomes an exact field
   after a mandatory preflight, or whether exactness is field-property opt-in
   with an explicit migration path and the same preflight. In either case,
   legacy non-exact number targets are prohibited for FWB; target exactness must
   be loaded authoritatively before mapping, never trusted from saved targetType
   metadata.
3. Approve the proposed shared production dependency and package boundary.
4. Confirm the canonical normalization policy that storage removes trailing
   fractional zeros while configured field scale controls display.
5. Confirm the formula D3 mandatory subset, exact-result metadata propagation,
   and explicit #VALUE! behavior for unsupported exact-decimal functions.
6. Ratify the proposed arithmetic context and operand table: +, -, *, SUM, MIN,
   and MAX never
   round and reject beyond 38 significant/18 fractional digits; division and AVG
   require explicit resultScale 0..18 and ROUND_HALF_EVEN; canonical output trims
   trailing zeros; invalid operands are not coerced/skipped; binary null is
   #VALUE!, SUM empty is 0, AVG/MIN/MAX empty is null, UNIQUE empty is empty,
   division by zero is #DIV/0!, and intermediate/final overflow is typed #NUM!
   with no cached write. The matrix pins 1/3 at scale 18, AVG(1,2), -1.005 at
   scale 2, and multiplication overflow.
7. Decide whether number-field mappings use a dedicated exact-decimal rollout
   flag or another server-enforced capability gate in addition to the existing
   FWB flags, and name the responsible operational owner for staged enablement
   and rollback. Independently accepted mappings whose frozen source and target
   are both non-numeric remain unblocked; a numeric source mapped to a text target
   is still governed by this exact-decimal gate.
8. Approve the rollup boundary: implement exact D3 reducers before allowing an
   exact source, or prohibit exact fields as rollup sources. A warning-only
   state is not allowed.
9. Approve the XLSX v1 ingress policy: exact fields accept text cells only on
   both browser and backend import paths; numeric workbook cells are rejected.
10. Approve the legacy JSON-number extraction policy: read the database token as
    text before JavaScript conversion; exponent/out-of-range tokens receive a
    typed fail-closed result, and field activation is blocked until the complete
    preflight has no failures.
11. Approve the approval source/snapshot boundary: a frozen published field has
    `valueFormat = 'decimal-string-v1'`; an instance has a dedicated constrained
    `form_snapshot_format` column stamped in the submit transaction; only when
    both are exact may the value source exact FWB. Legacy/N-1 snapshots fail
    closed and are never inferred or bulk-stamped.
12. Approve `metasheet_exact_decimal_v1(jsonb)` as the database
    filter/order/keyset boundary: it dispatches on JSON type, treats
    missing/JSON-null as SQL NULL, enforces the v1 significant-digit/scale limits,
    returns PostgreSQL `NUMERIC` without a fixed typmod, and has shared-package
    corpus parity plus record-id cursor tie-breaking.
13. Approve the normalized exact-field registry, database-enforced total lock
    order (admission singleton, global metadata lock, sorted dependency-sheet
    locks, authority rows, record rows), data/config/recovery
    triggers, restricted metadata transition, and persistent admission epoch.
    A dedicated non-login owner/migration role owns application schemas, objects,
    triggers, and safe-search-path SECURITY DEFINER functions; runtime roles have
    no ownership/membership/grant/schema-create/trigger-replace authority and
    PUBLIC has no execute. Exact-aware workers use a generation-specific non-
    inheritable DB identity; direct table DML is revoked and stored write
    functions derive generation from `session_user` alone through a closed role-
    generation registry rather than from `current_user` or caller input; the
    owner and unknown identities fail closed. Every writer locks a pre-existing
    admission singleton before validation and retains the shared lock through
    commit; activation uses `READ COMMITTED`, acquires the same row exclusively
    in its first statement, rescans in later fresh-snapshot statements, and
    updates it before commit. A stale writer then orders before activation or
    fails serialization, while activation cannot miss a writer that committed
    while it waited.
    Activation locks, rescans, inserts
    authority, advances the minimum generation, and revokes the old role in one
    transaction; raw SQL/N-1 writers and late N-1 restarts cannot forge admission.
    The deployment retains and rehearses an exact-aware rollback artifact for the
    current function ABI and generation credential; it never restores the revoked
    N-1 role merely to roll back an unrelated regression.
    Field PATCH, restore,
    provisioning, duplication, migration, and internal metadata writes cannot set
    exactness directly, and v1 exactness cannot be downgraded or removed.
14. Approve query ordering as nulls-last for both ASC and DESC, with record id
    ascending as the stable tie-break and a database-derived canonical cursor.
15. Approve string-only exact semantic operands across filters, views, validation,
    automation, permissions, approval routing, and formulas. Persisted JSON-number
    or noncanonical operands block field activation until authorized re-save and
    re-confirmation; they are not silently normalized.
16. Approve the closed recovery manifest and `ExactRecordEnvelope`: delete/
    revision/trash/tombstone/PIT archival copies immutable legacy source JSONB
    through restricted database `INSERT ... SELECT` capture without JavaScript
    parsing, while
    batch restore, trash undelete, field tombstone undelete, PIT reset/revert,
    and record reconstruction preserve source bytes, project legacy tokens in
    PostgreSQL, canonicalize the new live row/after-image, and fail closed for an
    invalid token before driver parsing.
17. Approve the mixed-read wire contract: every API, history, export, formula,
    event, and recovery read overlays PostgreSQL-projected canonical exact strings
    before semantic or outward use; driver-parsed legacy numbers are never exposed.
18. Approve v1 detail cardinality: FWB maps persisted top-level exact approval
    values only. Detail rows, cells, totals, and aggregates remain blocked until
    a separate frozen aggregate-source and row-identity/one-vs-many contract is
    ratified.
19. Approve FWB field authorization and prerequisite coupling: each mapped field
    is rechecked while holding the same ordered authority/config locks used by
    every role, member-group, base/sheet/field-permission and field-config writer,
    and
    exact FWB can run only when durable delivery and all applicable FWB controls
    are enabled; a disabled/null enqueue aborts the full transaction.
20. Approve derived-field activation: first exact dependency builds candidate
    config/results in shadow storage and atomically publishes config, irreversible
    exact-result authority, and result generation under the global/dependency
    locks. Exact derived fields cannot later become legacy/non-numeric fields in
    place; config-before-recompute is prohibited.
21. Approve frozen approval-source authority: template-version schema/authoring
    graph, compiled published-definition runtime graph/version binding, and the
    complete normalized exact-source set are DB-immutable after publication,
    including rejection of later binding INSERT; instance snapshot, snapshot
    format, template-version id, and published-definition id are immutable after
    insert and must reference the same version. FWB locks and cross-checks all
    those rows before extracting a source token. Corrections require a new version
    or instance.

## 12. Ratification boundary

This is a proposed design lock. It records the identified compatibility gap and
the minimum work necessary before exact numeric FWB mappings are enabled in
production. It neither states that D0-D4 are implemented nor grants permission
to implement, merge, deploy, or enable any flag. It does not revoke a separate
authorization for non-numeric mappings. Owner ratification must explicitly
select the decisions in section 11 and authorize the staged work.
