# Phase D2h crypto-substrate boundary (2026-08-26)

- **Status:** Draft / HOLD. This is an implementation-slice boundary, not an enablement, a merge
  authorization, or a key-custody ratification.
- **Parent contract:** `multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md`
  at SHA-256 `19f10cd8d7259861c75ee6d82af4f421f29b875101a5a2a583c0a73c67009caf` (verified against the
  file at this head). That file's own closing line still reads *"Status remains PROPOSED"*, while
  the D2a boundary doc cites the same SHA as "ratified". This slice does not resolve that tension
  and does not ratify anything; it cites the exact bytes it was built against.
- **Default posture:** `MULTITABLE_RECOVERY_ARCHIVE_ENABLED` remains exact-literal OFF. No flag is
  added, read, or changed. This slice has no runtime caller.

## Delivered by D2h

Two source artifacts, and nothing else:

1. `packages/core-backend/src/multitable/recovery-archive-crypto.ts`
2. `packages/core-backend/src/db/migrations/zzzz20260826124000_create_recovery_archive_crypto_registry.ts`

### 1. Narrow key-custody adapter (D-F)

`RecoveryArchiveKeyCustodyAdapter` declares exactly five verbs: produce a generation DEK, unwrap
one, derive the opaque `dek_fingerprint`, MAC the canonical manifest/root binding, and verify that
MAC. No vendor is named or implied — D1 §9.3 leaves KMS/key custody an open owner decision.

`deriveDekFingerprint` is specified over the **actual unwrapped DEK**. D-F rules out hashing the
wrapped ciphertext because randomized re-wrapping would produce a different value for one DEK and
hide reuse. The unit suite proves this directly: two wraps of one DEK give unequal wrapped bytes
and unequal wrapped-blob hashes, while the contract-conforming fingerprint is stable, so two builds
on one DEK collide at the registry instead of silently sharing a nonce.

`createTransactionGuardedKeyCustody` is the single choke point for every adapter call and does
three things per verb: re-check transaction depth, **validate the adapter's result at runtime**, and
**normalize any arbitrary throw** into a closed code. Result validation refuses a DEK that is not an
exact 32-byte `Uint8Array`, a blank wrapped id, an empty wrapped blob, an unwrap whose returned
wrapped id differs from the requested one, an empty MAC, and a non-boolean verify verdict — each of
which is silent corruption otherwise. Invalid key bytes are scrubbed *before* the refusal.

Generation-DEK results are treated as hostile objects after the adapter promise resolves. The
wrapper reads each required own **data descriptor** once, rejects accessors without invoking them,
normalizes Proxy reflection failures, and returns a plain snapshot rather than the original object.
If reflection exposes a valid DEK and a later field then fails, those bytes are scrubbed before the
closed refusal. This prevents a getter from exporting provider text and prevents a result object
from changing after validation but before fingerprinting or sealing.

`RecoveryArchiveCryptoError.message` is the closed code itself, and the class carries **no `cause`**:
attaching the original throwable would re-export exactly the provider text and host detail it exists
to strip. Adapter, reservation, sealer, and provider failures map to
`KEY_CUSTODY_FAILED` / `RESERVATION_FAILED` / `SEAL_FAILED` / `PROVIDER_FAILED`; an error this module
already produced passes through unchanged.

### 2. Transaction-depth guard (D-F: "No KMS call may run inside a database transaction")

`createTransactionGuardedKeyCustody(adapter, probe)` re-checks depth **at every verb**, and
`reserveThenSealRecoveryArchiveSections` applies it internally — it never holds a reference to the
unwrapped adapter on any path, so a caller cannot opt out by passing a raw one. An unreadable depth
(throw, non-integer, negative) fails closed exactly as hard as a nonzero depth.

The guard is deliberately per-call rather than entry-only. A mutation downgrading it to a single
entry check reds `the guard is per call, not entry only`, because a build that legitimately starts
at depth 0 and then opens a transaction must still be refused on its next KMS verb.

The orchestration helper additionally checks depth at **four** points, each separately mutation-proven:
at entry, on every KMS verb, immediately after the reservation sink returns and before the first
encryption, and before **every** provider callback. The post-reservation check matters most: the
reservation sink is itself a database caller and is the likeliest place to have left a transaction
open. Provider callbacks are network I/O, which D-F forbids under a database transaction just as
firmly as it forbids KMS calls there.

### 3. AEAD seal/open (D-D, §2.1)

`aes-256-gcm` from `node:crypto` — no new dependency. Exact constants: 32-byte key, 12-byte nonce,
16-byte tag, closed one-member algorithm set, `RECOVERY_ARCHIVE_CRYPTO_CONTRACT_VERSION = 1`.

**AAD field set (14 fields, exact order).** This is the union of two lists and the union is
load-bearing, not gold-plating:

| Source | Fields |
|---|---|
| D1 §2.1 step 2 (tenant/anchor identity) | `format_version`, `archive_generation_id`, `workspace_id`, `base_id`, `sheet_id`, `anchor_operation_id`, `anchor_seq`, `checkpoint_id`, `section_name` |
| D2h task list (crypto-bearing descriptor, §2.1 step 3) | `aead_algorithm`, `key_id`, `wrapped_dek_id`, `dek_fingerprint`, `plaintext_sha256` |

The seven-field key-metadata list **alone** binds no tenant identity, which is exactly fork C2 that
D-C rejects ("C2 cannot prove tenant isolation") and exactly the *cross-binding mixup* row of the
§2.1 threat table. A mutation dropping the tenant/anchor fields reds three unit tests. All fields
are mandatory: a blank or missing field refuses rather than encoding as empty, because an empty
field silently produces a different security binding.

Encoding is a domain-separated, **type-tagged**, length-prefixed byte concatenation
(`tag(1) || length(4, big-endian) || bytes`), **not** JSON. D2g owns manifest canonicalization
(RFC 8785 JCS); this module must not fork a second canonicalizer, and a length prefix is unambiguous
without a delimiter a value could contain.

**Nullable expiry.** `expiresAt` in the manifest MAC binding is `string | null`, because a
never-expiring generation is a live D1 §9.2 horizon option and "no expiry" must be a bound value
rather than an omitted field. NULL carries its own tag byte, so **no string can forge the
null-expiry preimage** — not `''`, not `'null'`, not any timestamp. A tagless length-prefixed
encoding would collide `null` with `''`; the mutation that does exactly that reds. `undefined` is
neither a string nor null and is refused, so a forgotten field can never be read as "never expires".

**Canonical timestamps.** `createdAt` and a non-null `expiresAt` must be canonical UTC with exactly
millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). Three independent guards enforce this and all
three are mutation-proven load-bearing: the fixed-shape regex is the *only* thing that rejects an
expanded-year instant such as `+010000-01-01T00:00:00.000Z` (which round-trips through `Date`
exactly); the finiteness check is the only thing that rejects `2026-13-26T00:00:00.000Z`; and the
`Date` round-trip is the only thing that rejects `2026-02-30T…` and `2026-08-26T24:00:00.000Z`.

**Consequence a D2 verifier must not depend on.** Because `plaintext_sha256` is inside the AAD, a
manifest whose section hash was rewritten now fails at the **AEAD tag**, not at a hash comparison.
The §2.1 tampered-manifest golden still refuses before any live write, but the two error classes
collapse into one. A verifier must not branch on telling them apart.

Fail-closed refusals, each with its own closed code and a discriminating test: wrong key, tampered
tag, tampered ciphertext, tampered nonce, truncated ciphertext, any single AAD field changed,
unknown algorithm (checked *before* node crypto is touched, so Node's own length-bearing errors are
never surfaced), malformed key/nonce/tag length, and a `plaintext_sha256` that does not describe
the bytes handed in.

### 4. Immutable `(dek_fingerprint, nonce)` reservation registry

`meta_recovery_archive_nonce_reservations`, primary key on the exact pair, binding `generation_id`
and `section_name`.

- **No cascade.** The table has zero foreign keys, inbound or outbound — proven both mechanically
  (`pg_constraint` contype `f` count is zero in both directions) and behaviourally (a reservation is
  admitted for a generation with no catalog row at all, so admission never consults a parent).
  D-F calls this a "values-free safety tombstone, not an object reference": deleting an old
  ciphertext must never make its pair reusable.
- **Never auto-pruned.** UPDATE, DELETE, and TRUNCATE all refuse. The TRUNCATE guard is a separate
  statement trigger because row triggers do not fire on TRUNCATE.
- **One nonce has one spelling.** Identity columns are `COLLATE "C"` (byte-exact equality
  independent of server collation) and constrained to canonical lowercase hex. Uppercase, padded,
  truncated, and whitespace-prefixed spellings are **refused, never normalized** — if two spellings
  of one nonce could both be admitted they would be two rows and a real reuse would go undetected.
- **Same nonce, different fingerprint is admitted**, as D-F explicitly permits, proven with two
  fingerprints derived from two different DEKs by the same domain-separated PRF.
- **No JS number for counters.** There is no sequence or counter column; `format_version` is a
  closed version literal, and `anchor_seq` is a decimal *string* everywhere it appears in the
  crypto binding (a JS-number spelling refuses; `Number('9007199254741993')` rounds).

- **One generation reserves each section exactly once.** A second UNIQUE constraint on
  `(generation_id, section_name)` closes the retry hole the primary key alone cannot: a retry that
  minted a *fresh* nonce for an already-reserved section has a genuinely new `(fingerprint, nonce)`
  pair, so only this arbiter refuses two live ciphertexts both claiming to be one section.
- **A complete format-v1 `archive_snapshot` is exactly ten reservations under one generation** —
  the ten contract sections, in the exact D-D order, one nonce each.

**Why a SQL primitive exists.** `meta_recovery_archive_reserve_nonce(...)` uses an explicit
`ON CONFLICT (dek_fingerprint, nonce) DO NOTHING` and raises the values-free
`recovery_archive_nonce_reservation_conflict`. A bare duplicate INSERT is still refused by the
primary key — correctness never depends on the function — but PostgreSQL's unique-violation
`DETAIL` spells out `Key (dek_fingerprint, nonce)=(…)`, which would put a nonce into an ordinary
log and violate D-M. Likewise the BEFORE-ROW shape guard runs ahead of the declarative CHECK
constraints so a malformed value never reaches a check violation, whose DETAIL prints the failing
row. **D2's runtime writer must reserve through this function, not through a bare INSERT.**

The conflict clause is deliberately **bare** (`ON CONFLICT DO NOTHING`, no arbiter named). With two
unique constraints, a targeted `ON CONFLICT (dek_fingerprint, nonce)` absorbs only the one it names,
so a `(generation_id, section_name)` duplicate escapes as a raw 23505 whose text is
`duplicate key value violates unique constraint` with a DETAIL naming the generation and section.
The mutation narrowing the clause reds on exactly that leak.

### 5. Complete-snapshot, closed discriminants, and DEK scrubbing

`reserveThenSealRecoveryArchiveSections` requires a **complete** format-v1 `archive_snapshot` plan:
exactly the ten contract sections, in exact order, one nonce each. D-D says omission, duplication,
an unknown section, or a different order refuses, so a partial plan is not a smaller archive — it is
an archive that cannot be a full-sheet recovery point. It is refused before any adapter call.

`dekSource.kind` is a closed runtime-validated discriminated union (`produce` | `unwrap`). An
unknown discriminant refuses rather than falling through to the unwrap branch, which is what a
`kind === 'produce' ? … : …` ternary silently does; the mutation restoring that ternary reds.

`scrubRecoveryArchiveDek` zeroes any value that is an exact 32-byte `Uint8Array`, scoped by shape
rather than by field name, and runs on **every** exit: success, reservation refusal, adapter throw,
invalid adapter result, seal failure, provider failure, and depth refusal. Each path is asserted
against the buffers the test adapter actually issued.

### 6. Reservation strictly before encryption and upload (D-H2)

`reserveThenSealRecoveryArchiveSections` fixes the order: validate the plan → obtain the DEK and
its fingerprint outside every transaction → reserve **every** pair → only then seal → only then
upload. A refused reservation leaves zero seal calls, zero upload calls, zero ciphertext, and no
manifest MAC.

The upload seam is a caller-supplied callback. **D2h implements no object store** and no archive
runtime caller: this helper opens no transaction, writes no catalog row, reads no flag, and stores
nothing.

## Explicit non-deliverables

- **No key registry.** D1 §5 assigns "key registry / reference-admission lock" and the whole D-L
  key lifecycle (`active -> retiring`, deletion intents/receipts) to **D3**. D2a already binds
  `key_id` on `meta_recovery_archives`, which is sufficient for D2h. D-H2's claim phase mentions
  locking a key-registry row; that row is a D3 deliverable, not a D2h gap. No D3 deletion
  lifecycle is implemented here.
- **No archive runtime caller**, no object-store adapter or upload, no manifest canonicalizer, no
  D2g import, no catalog write, no verify/restore/prune path, no route, no scheduler, no flag.
- **`dek_fingerprint` shape is provisional.** Format v1 admits 64 lowercase hex characters. D-F
  says only "opaque, KMS-attested, one-to-one, domain-separated PRF over the unwrapped DEK", and
  D1 §9.3 leaves the KMS product an **open owner decision**. The 64-hex shape is this format
  version's admission rule, bound to `format_version = 1`; it is not a ratified custody design and
  a different custody product may require a format bump.

## Residuals a reviewer should not have to discover

1. **AAD is a superset of the D2h task list.** Deliberate, justified above. It is also a superset
   of §2.1 step 2 in the key-metadata direction. If the owner wants the narrower list, that is a
   contract decision, and the tenant-isolation loss must be accepted explicitly.
2. **Error-class collapse** for tampered manifests (see §3 above).
3. **A complete snapshot is enforced by shape, not by content.** The helper proves all ten sections
   are present and ordered; it cannot prove a section's bytes are that section's real canonical
   content. That is D2g's and the D2 runtime's obligation.
4. **D2g seam is declared, not exercised end to end.** `plaintext` is an opaque `Uint8Array`; this
   slice never produces canonical JCS bytes, so "the sealed bytes are the canonical manifest bytes"
   is unproven until D2g lands and feeds the seam.
5. **The depth probe is an interface, not a wired Postgres probe.** D2h proves the guard refuses at
   depth > 0; proving a real pool reports its real depth belongs to the D2 runtime slice.
6. **`ALTER TABLE … DISABLE TRIGGER USER`** can still clear the registry as the table owner. The
   integration harness uses exactly that to reset an ephemeral database, which is also the evidence
   that nothing short of a schema-owner trigger disable can empty it. Blocking a table owner is not
   in scope for a migration.

## Exit gate for this slice

D2h may be reviewed as a Draft/HOLD substrate only when its exact head has:

- type-check, the focused unit suite, and the real-DB registry suite green with zero skips;
- CI two-point wiring (vitest `test.exclude` + the exact-id real-DB step) and a behavioural
  fail-not-skip proof under its own distinct sentinel;
- restored mutation evidence for: the reservation-before-encryption order; the transaction guard at
  all four checkpoints; the AAD field set; the null-expiry type tag; each of the three timestamp
  guards independently; complete-snapshot enforcement; the closed DEK-source discriminant; adapter
  result data-descriptor validation and snapshotting; Proxy-reflection throw normalization and DEK
  scrubbing; throw normalization and the absence of a `cause`; `COLLATE "C"`;
  nonce-spelling canonicality; duplicate refusal; the generation+section uniqueness arbiter; the
  bare conflict clause; reservation immutability; and the absence of a cascading foreign key;
- an independent review that treats the D3 key registry, the D2g canonical-byte seam, and the D2
  archive runtime caller as blocking dependencies of full D2 rather than crediting them here.

Until that review, D2h must not be described as complete D2, complete D-F, merge-ready runtime, or
archive encryption delivery.
