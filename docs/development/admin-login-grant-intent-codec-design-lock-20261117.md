# Offline admin login grant intent codec

Date: 2026-11-17

## Scope and authority

Only `src/auth/admin-login-grant-intent.ts` and its backend unit file are in
scope, alongside this lock. The accepted minimum is section 3 of the private
2026-11-16 independent admin-grant-proof design review, with the main agent's
2026-11-17 opaque-ID clarification. This is an offline command-data codec,
not an authenticated context, proof, evidence reader, grant or authorization.
B2 and production proof delivery remain HOLD.

No production importer, barrel/index export, route, caller, flag, schema,
resolver, challenge or old-purpose change is permitted. The module's sole
runtime dependency is `node:crypto`. Its registry has exactly one inert entry:
`admin_login_grant_enable`, `confirmed_identity_set`, `local_password`,
`standard`, `productionAvailable: false`. No availability/service stub is added.

## Closed runtime data

- Intent owns exactly `purpose`, `commandId`, `actorId`, `orgId`, `provider`,
  `connectionId`, `applicationRevision`, `targets`.
- Purpose is exactly `admin_login_grant_enable`; provider is exactly `dingtalk`.
- Each target owns exactly `userId`, `identityId`, `bindingRevision`,
  `evidenceId`, `evidenceWitness`, `accessGeneration`, `privilegeWitness`.
- Objects have the ordinary or null prototype and own data properties only.
  Symbol/unknown/missing keys, accessors, inherited fields and reflection
  failures refuse with one fixed values-free error. Targets form a nonempty
  dense ordinary/null-prototype array, without extra properties or accessors.
- Target user IDs are unique, actor differs from every target, and output
  targets sort by JavaScript code-unit comparison of the unchanged user IDs.
  No deduplication, row skipping or batch maximum is introduced.
- Actor/user/org/command/evidence IDs and `evidenceWitness` are canonical nonempty
  strings: `value.trim() === value` is checked, never used to replace the value.
  Empty, whitespace-only and leading/trailing-whitespace values refuse. Interior
  spaces/separators, Unicode and case remain verbatim; no coercion, trimming,
  case folding, Unicode normalization or guessed maximum length is introduced.
  Their canonical representation here is their exact accepted string content.
  This codec does not call a downstream subject planner or attest its 255/C0
  subject restrictions; a future actual receiver must enforce its own contract.
  In particular commandId
  and evidenceId are opaque, not UUIDs; evidenceWitness has no established
  producer format and is opaque, not presumed SHA-256. The codec attests none
  of these facts. Future persistence/readers must receive them losslessly or
  independently version and review any tighter contract.
- Only identityId and connectionId are UUID-valued: accept canonical hyphenated
  hexadecimal spelling, normalize hex case to lowercase, and impose no UUID
  version/variant restriction. Do not trim or accept other PostgreSQL spellings.
- All three revision/generation values are canonical nonnegative decimal
  strings (`0` or a nonzero digit followed by digits). bindingRevision maps to
  existing challenge `expected_binding_revision bigint`; accessGeneration maps
  to existing `users.access_generation bigint`. Both are bounded by
  `9223372036854775807` without Number conversion. applicationRevision has no
  delivered physical mapping: enforce decimal syntax only, not a guessed SQL
  bound. A future mapping must explicitly receive or version this contract.
- privilegeWitness follows the actual `computePrivilegeWitness` → `witnessOf`
  producer's bare lowercase 64-hex SHA-256 output. The v2 domain
  `metasheet:security-action:privilege:v2|` is inside the hashed bytes, not an
  output prefix. Matching that syntax is not authentication,
  a classifier read, evidence validation or authority.

## Copy, encoding and digest

Normalization returns fresh copied intent/target/array containers, all frozen,
without freezing or retaining any caller-owned container. Encoding always
revalidates and emits JSON with fixed field order, explicit `targetCount` and
every complete target pin. Field names and JSON escaping supply unambiguous
structure; input object order and target permutation do not affect encoding.
No field, target or count is dropped. Hashing is SHA-256 over UTF-8 domain
`metasheet:admin-login-grant-intent:v1|` followed by that encoding. Opaque IDs
are cryptographically bound but not attested. There is no IO or production
availability transition.

## Verification and handoff

The new backend unit file owns codec negatives, copy/freeze checks, exact
encoding/hash pins, every-field digest changes, and source import/availability
guards with negative fixtures. The guard scans backend runtime and both plugin
roots; it is a static literal/computed-load boundary, not arbitrary data-flow
analysis. The module itself may import only `node:crypto`.

Backend `test:unit` selects `tests/unit`; the default Vitest exclude list must
not exclude this new file. No frontend two-point wiring or shared CI/guard edit
belongs here. Main owns running the new whole file plus old proof/policy
neighbors, independent source mutations and the independent code gate. A source
mutation removing a validator, sorting, copying/freezing, a field from encoding,
the domain or the inert/import boundary must produce a discriminating failure;
restore exact owned bytes, never overwrite another agent's source. No author
test, build, lint, typecheck, PG, network or CI result is claimed by this lock.
