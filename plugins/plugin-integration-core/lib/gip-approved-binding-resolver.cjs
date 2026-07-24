'use strict'

// GIP-D0 / B1a — APPROVED-BINDING RESOLVER (LATENT: no route, no flag, no arming, no
// runtime consumer; the only importers are this module's own tests).
//
// WHAT IT IS. The server-side derivation of the COMPLETE six-field qualification tuple
//
//     { actionProfileVersion, systemContentKey, configContentKey,
//       objectKey, canonicalObjectVersion, orderingKeySpec }
//
// from ONE immutable APPROVED read-source config version plus its tenant's system
// record — and from NOTHING else. It exists to close the caller-supplied surface of
// gip-binding-qualification-spike.cjs: `verifyBindingQualification({ expectedInputs })`
// recomputes the digest from whatever the caller passes, so a caller that assembles
// `expectedInputs` by hand can pair config A with system-or-profile B. Probe AND verify
// must both re-enter through this resolver; a cached caller-side tuple is never honoured.
// Binding only three of the six fields re-opens exactly that forgery, which is why the
// resolver derives all six or refuses.
// STATUS (R3.3): that re-entry now EXISTS at the module boundary — the spike's
// probeFromResolution() / verifyBindingQualificationFromResolution() take a resolution
// authenticated by isTrustedBindingResolution below and refuse any tuple field supplied
// beside it. It is NOT wired to a runtime: the spike's ratified caller-supplied entry
// points remain exported, and closure is enforced at the gated wiring point.
//
// R3 — DERIVED, NEVER SUPPLIED
//   1. Approval + scope are RE-VERIFIED on every resolution through the real store path
//      `configStore.getForRuntime({ tenantId, workspaceId, id })`: `loadRow` applies the
//      tenant/workspace WHERE clause and `getForRuntime` throws
//      ReadSourceConfigNotApprovedError for a non-approved row. An id is never treated as
//      evidence of approval.
//      DELIBERATELY MERGED REJECTION: not-found, out-of-scope and not-approved all become
//      the single closed reason APPROVED_VERSION_UNRESOLVABLE. Distinguishing them would
//      turn the resolver into a cross-tenant existence oracle. Any other store-path
//      failure also lands there — fail-closed beats a leaky taxonomy.
//   2. `configContentKey` is RECOMPUTED from the SERVED body with the store's own exported
//      `contentKeyFor` (sha256 over the store's stableStringify of the config MINUS
//      `version`) and compared to the stored `content_key` column; a mismatch is a closed
//      rejection. The tuple then carries the RECOMPUTED key — the stored column is never in
//      the tuple's provenance path (assembleBindingTuple does not read it at all).
//      The store's own hasher is reused, never reimplemented: it is the definition of the
//      column being compared against, and a second implementation would drift.
//      PRECISE PROVENANCE — DO NOT SIMPLIFY THIS TO "the immutable body" (review lens 2):
//      the store's only exported reads (`get` / `getForRuntime`) return
//      sanitizeIntegrationPayload(row.config), i.e. a LOSSY PROJECTION of the stored body,
//      while `content_key` was computed by the store AT WRITE TIME over the RAW row. So the
//      comparison is recompute(PROJECTION) === write-time-key(RAW), and it passes only when
//      the projection is IDENTITY on that body. That is exactly what makes the config plane
//      safe: the write-time key is a LOSSLESS witness, so any lossy projection is DETECTED
//      and the resolution fails closed (CONFIG_CONTENT_KEY_MISMATCH) instead of hashing a
//      projection. The system plane had no such witness — see the LOSSLESS SYSTEM IDENTITY
//      section below.
//      ACCEPTED OPERATIONAL LIMIT, pinned behaviourally in the suite so it cannot rot: a
//      body the sanitizer would change is UNBINDABLE today — >50 fieldMap entries (the
//      boundary is pinned: 50 resolves, 51 refuses), any string >2000 chars, nesting deeper
//      than 6, or a secret-SHAPED substring. Raising those limits (or exposing a lossless
//      store read) is a GATED change to a live store path, not B1a's to make.
//   3. The denormalized `object` / `system_id` columns are cross-checked against the
//      immutable body (APPROVED_ROW_BODY_DIVERGENT). Same doctrine as (2): the body is the
//      truth, columns are convenience.
//   4. Callers cannot override ANY tuple field. Two separately-red-able properties:
//        (a) the run input is an EXACT key allowlist { tenantId, workspaceId?,
//            approvedConfigVersionId } — anything else is refused, counted not echoed;
//        (b) assembleBindingTuple(approvedRow, systemRecord) takes the two SERVER-side
//            records and nothing else — an override is INEXPRESSIBLE there, not merely
//            rejected. Its test calls it with an extra override-shaped argument (the
//            position a careless refactor would wire run input into) and pins that the
//            tuple is unchanged.
//      Dependencies (store, registry) are captured ONCE by the factory, server-side, and
//      are never accepted as run data — mirroring the P1 fix in the qualification spike
//      where a per-call registry was a duck-typed injection bypass.
//
// R2 — DEEP-IMMUTABLE, NOT MERELY PROVENANCE-CHECKED
//   WeakSet identity proves WHO built an object; it does not stop a holder from mutating a
//   nested array inside the probe's async query window (a probe reads the ordering key,
//   awaits the source, and would read it again). Shallow Object.freeze leaves nested
//   entries writable, and a draft that ALIASES store-returned arrays stays writable through
//   the original reference. So:
//     • validation is validate-then-ALIAS on purpose (normalizeOrderingKeySpec returns the
//       body's own array). Ownership is taken at EXACTLY ONE choke point —
//       deepCloneFrozenCanonical(draft) — so there is a single place to audit. The resolver
//       deliberately does NOT rely on its injected store deep-copying: a decorating store,
//       an in-process cache or a mapper may legitimately hand back a live reference.
//     • the returned resolution is an owned, recursively frozen clone in the strict
//       canonical-JSON domain (gip-canonical-json.cjs: index loops not .map,
//       Object.defineProperty not assignment so a `__proto__` data key cannot pollute,
//       rejects Proxy/accessor/sparse/symbol).
//     • TRUST IS OBJECT IDENTITY: membership in the module-private WeakSet
//       `trustedBindingResolutions`. There is NO public boolean brand — a brand is
//       duck-typable, and a structurally perfect hand-built clone must still be refused.
//       Consumers call assertTrustedBindingResolution(resolution).
//
// R6 — orderingKeySpec CLOSED SCHEMA (schema plane only)
//   Canonical fieldIds only: /^[A-Za-z][A-Za-z0-9_]{0,63}$/ — a single flat identifier.
//   Raw SQL, expressions, aliases, quoted identifiers, dotted paths and embedded direction
//   tokens ("qty DESC", "COALESCE(a,b)", "a AS b", "\"id\"", "a.b") are refused BY SYNTAX,
//   before any resolution step. A dotted token is a PATH INTO A RESPONSE BODY, not a field
//   identity, so it is refused even when a fieldMap target happens to carry one.
//   Non-empty; duplicate fieldIds refused (a repeated key cannot strengthen an order and
//   hides a mis-configured composite key — never silently deduped); entries are closed
//   objects with exactly { fieldId, direction }; every fieldId must resolve through the
//   SAME approved config version's fieldMap targets (unresolvable ⇒ closed rejection).
//   FIELD-ID NAMESPACE — READ THIS BEFORE CONSUMING THE TUPLE. A `fieldId` is the CANONICAL
//   CLEANSING-ZONE FIELD IDENTITY: it is resolved against the approved version's fieldMap
//   TARGETS. It is NOT a source column name, and it is NOT directly usable as a probe SQL
//   identifier. Neither side of the mapping is: a fieldMap `source` is a dotted HTTP
//   RESPONSE PATH ('Data.FQty'), and a `target` is a cleansing-zone column id
//   ('material_code'). The qualification spike's probe feeds `keyColumns` through
//   quoteIdentifier straight into SQL against `objectKey`, so a consumer that hands these
//   fieldIds to it would emit ORDER BY over columns the source view does not have. The
//   target → source-column translation is a NAMED GATED FOLLOW-UP (it needs a per-system
//   column mapping that does not exist today); a probe strategy may NOT guess it, and this
//   resolver deliberately does not invent one.
//   THE ONE CONSUMER, AND WHAT IT DOES (R3.3, kept in sync with that module's header):
//   gip-binding-qualification-spike.cjs's probeFromResolution() derives its probed field set
//   from THIS orderingKeySpec and passes the fieldIds through BY IDENTITY — it does not
//   translate them. That is deliberate: a caller-supplied field set is exactly the
//   "config A + field set B" forgery, and probe evidence is values-free (a count, never
//   field names) so no after-the-fact check could ever catch it. B1a is LATENT — no SQL
//   reaches a real source — and the gated translation lands at that ONE derivation point
//   (deriveProbeKeyColumns) when B1b brings the per-system column mapping.
//   DEPENDENCY DIRECTION: the spike requires this module; this module must NEVER require
//   the spike (cycle, and this is the lower layer — it derives what the spike consumes).
//   DIRECTION CASE POLICY — DELIBERATE: exactly 'ASC' | 'DESC'. Lowercase 'asc' is
//   REFUSED, never silently uppercased. What a human approved must be byte-identical to
//   what runs: a read-time normalizer would make two textually different approved bodies
//   (different configContentKeys, different digests) behave identically, so the
//   content key would no longer pin behaviour. Known wart, deliberately not papered over:
//   read-source-config.cjs's resolver sort direction vocabulary is LOWERCASE
//   (RESOLVER_SORT_DIRECTIONS = ['asc','desc']). R6 is the ratified vocabulary for the
//   ordering key; reconciling the two cases belongs to the gated change that adds
//   orderingKeySpec to the config allowlist (below), not here.
//   NULLABILITY IS DELIBERATELY NOT A SCHEMA CHECK. Whether an ordering key column is
//   nullable is a property of the LIVE SOURCE, not of the config text, and it is
//   unobservable here. It stays fail-closed at the qualification probe, which asserts it
//   against the real source in the same snapshot as the duplicate probe
//   (ORDERING_KEY_NULL_FOUND). Schema plane = shape; probe plane = observed source facts.
//   Declaring nullability in config would let a config text "prove" a source property.
//
// ── B1a DECISIONS (explicit, owner-visible) ────────────────────────────────────────────
//
// D1. `actionProfileVersion` and `orderingKeySpec` are read from the IMMUTABLE APPROVED
//     CONFIG BODY, never from run input. Approval is the human gate that binds
//     config ⇄ action profile ⇄ ordering key in ONE record; if the profile were run data,
//     "config A + profile B" would still be expressible. `actionProfileVersion` is
//     validated against the ONE profile-id vocabulary (PROFILE_ID_PATTERN, imported from
//     gip-profile-certification-contracts.cjs) so the two cannot drift.
//     KNOWN GAP, not silently glossed: read-source-config.cjs's ALLOWED_CONFIG_KEYS does
//     NOT yet contain `orderingKeySpec` or `actionProfileVersion`, so a body carrying them
//     is rejected at save time TODAY. Adding them is a GATED change to a live validation
//     path and is therefore out of B1a's latent scope; the test suite asserts the current
//     rejection behaviourally, so this note cannot rot into a stale comment.
//
// D2. `systemContentKey` HAS NO PRODUCER TODAY (it appears only in the GIP spike). B1a
//     derives it, with the same discipline the config store uses for its content key —
//     sha256 over a stable stringify of IMMUTABLE IDENTITY FIELDS — but over the STRICT
//     canonical codec (gip-canonical-json), which rejects Date/class/sparse/undefined
//     rather than coercing them:
//       'sck1:' + sha256(stableCanonicalStringify({ domain tag, systemId, tenantId,
//                        workspaceId, kind, role, config }))
//     INCLUDED: `config` — it carries the endpoint/connection identity; repointing a
//       system at a different host MUST invalidate qualifications taken against the old one.
//     EXCLUDED and why: `name` (mutable human label), `status` (operational state — it is
//       an ADMISSION GATE below, not identity; hashing it would churn the key on a
//       transient 'error'), `capabilities`/`lastTestedAt`/`lastError` (operational),
//       credential material (never enters a digest; a rotation does not change WHICH
//       system this is).
//     The 'sck1:'/'cov1:' prefixes and the domain tag make the derivation SCHEME VERSION
//     part of the hashed material, so a future scheme change cannot collide with this one
//     and cannot silently look like the same key.
//
// D2.1 LOSSLESS SYSTEM IDENTITY — THE FIX FOR A PROVEN FORGERY. Hashing `config` is only
//     an identity if the config we hash is the STORED one. The registry's PUBLIC read
//     (`getExternalSystem`) returns sanitizeIntegrationPayload(row.config): it replaces
//     sensitively-NAMED values with '[redacted]' and truncates at depth 6 / 50 array items /
//     2000 string chars. Hashing THAT projection was a REALIZED forgery, reproduced end to
//     end before this fix: a qualification minted against a production ERP still verified
//     `verified: true` after the same system was repointed at attacker.example through the
//     production upsertExternalSystem path — in FIVE classes, two key-name-dependent
//     (`connectionString`, `jdbcUrl`) and three key-name-INDEPENDENT (depth / array / string
//     truncation), which is why no allowlist of "safe" config keys could ever have closed it.
//     Because `canonicalObjectVersion` is derived FROM `systemContentKey`, both
//     system-identity fields of the six-field tuple collapsed together.
//     THE FIX, in two independent layers (each separately red-able):
//       (1) SOURCE. The identity record is read through the registry's UNSANITIZED read,
//           `getExternalSystemForAdapter` (rowToAdapterExternalSystem passes `row.config`
//           through untouched). It is REQUIRED BY THE FACTORY: a registry that offers only
//           the sanitized read is refused up front (RESOLVER_DEPENDENCY_INVALID), so the
//           lossy path is not merely avoided — it is not wired. The record is narrowed to
//           the identity fields IMMEDIATELY (loadSystemRecord), so the decrypted credential
//           material that read also carries never reaches assembly, the digest or an error.
//       (2) FAIL-CLOSED WITNESS. Unlike the config plane there is NO write-time key column
//           to compare against, so losslessness cannot be VERIFIED — it can only be demanded
//           and its violation detected. assertLosslessSystemIdentityConfig refuses, before
//           any hashing, a config that shows PROJECTION: (a) any object node whose prototype
//           is not Object.prototype — sanitizePayloadValue builds EVERY object node with
//           Object.create(null), while every reachable raw path (pg's JSON.parse, the
//           registry's own `{...value}` spread) yields Object.prototype, so this is a
//           one-directional detector of a sanitize pass with no reachable false positive;
//           (b) any string carrying a sanitizer marker ('[redacted…', '…[truncated]',
//           '[N more items truncated]', '[max-depth]', '[circular]', '[omitted]');
//           (c) any UNSAFE_PAYLOAD_KEYS key ('__proto__'/'constructor'/'prototype'), which is
//           the one class a projection drops leaving NO marker — a config carrying one can
//           never be safely projected, so it is refused rather than bound.
//       Silently hashing a lossy projection — "looks verified, isn't" — is never an outcome:
//       every path is either the lossless read or a closed refusal.
//     REJECTED ALTERNATIVES (named, so the next reviewer need not re-derive them):
//       • an allowlist of "safe" config keys — three of the five proven classes are
//         key-name-INDEPENDENT truncation; an allowlist cannot see them;
//       • marker-scanning the SANITIZED record and hashing it when clean — unsound: the
//         '__proto__'/'constructor'/'prototype' drop leaves no marker at all;
//       • adding a lossless read (or a write-time system content-key column) to
//         external-systems.cjs — a latent slice must not widen the API of a module that live
//         routes consume, and a store-side key would split this derivation (domain tag,
//         'sck1:' scheme) across two modules. If a future gated change adds a write-time
//         column, THAT is when the config plane's recompute-and-COMPARE becomes possible
//         here; until then (2) is the honest substitute and says so.
//     WHY THE CREDENTIAL RULE KEYS ON `credentials` AND NOTHING ELSE: that is the ONLY
//     plaintext-bearing field the lossless read produces (rowToAdapterExternalSystem sets it
//     and nothing else). The PUBLIC read's `hasCredentials`/`credentialFingerprint`/
//     `credentialFormat` are not plaintext and are not listed — a public record is refused
//     anyway, by the prototype rule, because its config is always a projection.
//     ACCEPTED COSTS, stated plainly: getExternalSystemForAdapter decrypts credentials, so
//       (i) a credential store that throws makes an otherwise-valid system UNBINDABLE
//       (fail-closed: SYSTEM_RECORD_UNRESOLVABLE), and (ii) resolution costs one decrypt.
//       Both are preferred over a forgeable identity.
//     RESIDUAL, not closed: a decorating registry that sanitizes AND THEN JSON-round-trips
//       (restoring prototypes) hides layer (2a); marker-visible losses are still caught by
//       (2b), but a difference living ONLY under a dropped '__proto__'/'constructor'/
//       'prototype' key would not be. That requires a collaborator deliberately laundering a
//       projection; the wiring gate binds the runtime to the real registry.
//
// D3. `canonicalObjectVersion` likewise has no producer. B1a derives it from the approved
//     object's CANONICAL SHAPE as declared: 'cov1:' + sha256 over { domain tag,
//     systemContentKey, objectKey, ordered fieldMap projection }. The projection is
//     ORDER-SENSITIVE because the mapping is a sequence of writes (the config validator
//     rejects duplicate targets for exactly that reason).
//     SHARED ROOT WITH systemContentKey — DELIBERATE, NOT A COLLAPSE TO FIX. Because the
//     material INCLUDES systemContentKey, the two identity fields always move together; a
//     reviewer who saw them collide under the pre-fix lossy hash was seeing ONE defect
//     (a forgeable sck), not two. `cov` is DEFINED as "this object, as declared, against
//     THIS system": decoupling it would let an object version outlive a repoint, which is
//     the opposite of what D2 exists to guarantee. With the D2.1 lossless fix the shared
//     root is no longer a hole, and the suite asserts BOTH fields move for every repoint
//     class so a mutation that drops the systemContentKey binding still reds.
//     WHAT IT DOES NOT PROVE — state it plainly: this derivation is a pure function of the
//     system record plus the approved config body, so it adds NO discriminating power
//     beyond systemContentKey + configContentKey and CANNOT detect source-side schema
//     drift (a column retyped or dropped in the external source does not change it). It
//     satisfies what B1a needs — deterministic, server-derived, never caller-suppliable,
//     never a hole — and is the placeholder for a future source-catalog-observed object
//     version (e.g. a digest of the live relation's attribute list), which is the only
//     thing that could carry a drift claim honestly.
//
// D4. The system record is looked up in the SAME tenant+workspace scope as the approved
//     config, and must be `status === 'active'` with a READ-capable role
//     ('source' | 'bidirectional'). A config may not bind a system outside its own scope,
//     an inactive/errored system, or a write-only target. If tenant-level systems must
//     ever be bindable from a workspace-scoped config, that is a GATED widening — never a
//     silent fallback to a broader scope.
//
// VALUES-FREE: every error this module RAISES carries a closed reason, an optional closed rule
// token, and COUNTS. Never a field name from customer data, never a config body, never an identifier,
// never the offending run-input key (which is attacker-chosen text).

const crypto = require('node:crypto')

const {
  CanonicalDomainError,
  deepCloneFrozenCanonical,
  isStrictDenseArray,
  isStrictPlainObject,
  stableCanonicalStringify,
} = require('./gip-canonical-json.cjs')
// The store's OWN content-key function — the definition of the column we compare against.
const { __internals: readSourceConfigStoreInternals } = require('./read-source-config-store.cjs')
// The sanitizer's OWN "keys every projection silently drops" set — imported, never restated,
// so D2.1(2c) cannot drift from payload-redaction.cjs.
const { UNSAFE_PAYLOAD_KEYS } = require('./payload-redaction.cjs')
// The ONE profile-id vocabulary (no second regex, no drift).
const { __internals: profileContractInternals } = require('./gip-profile-certification-contracts.cjs')

const { contentKeyFor } = readSourceConfigStoreInternals
const { PROFILE_ID_PATTERN } = profileContractInternals

// ── Frozen vocabularies (deepEqual-pinned in the suite; both directions must red) ──────
const BINDING_RESOLUTION_ERROR_REASONS = Object.freeze([
  'RESOLVER_DEPENDENCY_INVALID',
  'RESOLVER_INPUT_INVALID',
  'APPROVED_VERSION_UNRESOLVABLE',
  'APPROVED_ROW_BODY_DIVERGENT',
  'APPROVED_BODY_FIELD_MAP_INVALID',
  'CONFIG_CONTENT_KEY_MISMATCH',
  'SYSTEM_RECORD_UNRESOLVABLE',
  'SYSTEM_IDENTITY_NOT_LOSSLESS',
  'ACTION_PROFILE_VERSION_INVALID',
  'ORDERING_KEY_SPEC_INVALID',
  'RESOLUTION_DOMAIN_INVALID',
  'RESOLUTION_NOT_TRUSTED',
])
const BINDING_RESOLUTION_ERROR_REASON_SET = new Set(BINDING_RESOLUTION_ERROR_REASONS)

// Closed rule tokens for ORDERING_KEY_SPEC_INVALID — the R6 schema is assertable
// rule-by-rule instead of inferred from a message string (pattern established by
// assertCertificateCrossDimensionLegal's `{ rule }` details).
const ORDERING_KEY_SPEC_RULES = Object.freeze([
  'ORDERING_KEY_SPEC_SHAPE',
  'ORDERING_KEY_SPEC_EMPTY',
  'ORDERING_KEY_ENTRY_SHAPE',
  'ORDERING_KEY_FIELD_ID_NOT_CANONICAL',
  'ORDERING_KEY_FIELD_ID_DUPLICATE',
  'ORDERING_KEY_DIRECTION_INVALID',
  'ORDERING_KEY_FIELD_ID_UNRESOLVED',
])
const ORDERING_KEY_SPEC_RULE_SET = new Set(ORDERING_KEY_SPEC_RULES)

// Closed rule tokens for SYSTEM_IDENTITY_NOT_LOSSLESS (D2.1 layer 2). Same doctrine as the
// ordering-key rules: each rule is separately assertable and separately red-able.
const SYSTEM_IDENTITY_SOURCE_RULES = Object.freeze([
  'SYSTEM_IDENTITY_CONFIG_SHAPE',
  'SYSTEM_IDENTITY_CONFIG_TOO_DEEP',
  'SYSTEM_IDENTITY_PROJECTED_PROTOTYPE',
  'SYSTEM_IDENTITY_REDACTION_MARKER',
  'SYSTEM_IDENTITY_UNPROJECTABLE_KEY',
  'SYSTEM_IDENTITY_CREDENTIAL_MATERIAL',
])
const SYSTEM_IDENTITY_SOURCE_RULE_SET = new Set(SYSTEM_IDENTITY_SOURCE_RULES)

// The traces sanitizeIntegrationPayload leaves when it DROPS information. SUBSTRINGS, not
// exact values: scrubSecretStringValue splices '[redacted]' INTO a longer value
// ('postgres://u:[redacted]@host', 'Bearer [redacted]'). Over-refusal is deliberate — a
// config whose genuine value contains one of these is refused rather than hashed.
// NOT a hand-maintained mirror: the suite drives the REAL sanitizer over one fixture per
// loss class and asserts this guard refuses each, so a marker change in payload-redaction.cjs
// reds here instead of silently reopening the collision.
const PROJECTION_MARKER_SUBSTRINGS = Object.freeze([
  '[redacted', // key redaction AND every scrubSecretStringValue replacement
  '[truncated]', // '…[truncated]' — maxStringLength cut
  'more items truncated', // '[N more items truncated]' — maxArrayItems cut
  '[max-depth]',
  '[circular]',
  '[omitted]',
])

const ORDERING_KEY_DIRECTIONS = Object.freeze(['ASC', 'DESC'])

// The CLOSED six-field tuple. A resolution carries exactly these keys — no more, no less.
const BINDING_RESOLUTION_FIELDS = Object.freeze([
  'actionProfileVersion',
  'systemContentKey',
  'configContentKey',
  'objectKey',
  'canonicalObjectVersion',
  'orderingKeySpec',
])

// Run input is SCOPE ONLY. `workspaceId` is optional because the store's
// normalizeWorkspaceId maps absent/null/'' to null — requiring the key would diverge from
// the store's own scoping semantics.
const RUN_INPUT_KEYS = Object.freeze(['tenantId', 'workspaceId', 'approvedConfigVersionId'])

// A canonical fieldId is ONE flat identifier: no dot, no quote, no space, no parenthesis,
// no operator, no semicolon, no leading digit. This single pattern is what makes raw SQL,
// expressions, aliases and dotted response paths inexpressible.
const CANONICAL_FIELD_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

const SYSTEM_CONTENT_KEY_DOMAIN = 'gip.b1a.systemContentKey.v1'
const CANONICAL_OBJECT_VERSION_DOMAIN = 'gip.b1a.canonicalObjectVersion.v1'
const READ_CAPABLE_SYSTEM_ROLES = Object.freeze(['source', 'bidirectional'])

class GipBindingResolutionError extends Error {
  constructor(reason, message, details = {}) {
    super(message)
    this.name = 'GipBindingResolutionError'
    this.reason = reason
    this.details = details
  }
}

function fail(reason, message, details = {}) {
  if (!BINDING_RESOLUTION_ERROR_REASON_SET.has(reason)) {
    // COARSE fixed token — never echo the rejected reason value.
    throw new Error(
      'gip-approved-binding-resolver internal: undeclared error reason '
        + '(add it to the frozen BINDING_RESOLUTION_ERROR_REASONS vocabulary)',
    )
  }
  throw new GipBindingResolutionError(reason, message, details)
}

function failSystemIdentityRule(rule, message, details = {}) {
  if (!SYSTEM_IDENTITY_SOURCE_RULE_SET.has(rule)) {
    throw new Error(
      'gip-approved-binding-resolver internal: undeclared system-identity rule '
        + '(add it to the frozen SYSTEM_IDENTITY_SOURCE_RULES vocabulary)',
    )
  }
  fail('SYSTEM_IDENTITY_NOT_LOSSLESS', message, { ...details, rule })
}

function failOrderingKeyRule(rule, message, details = {}) {
  if (!ORDERING_KEY_SPEC_RULE_SET.has(rule)) {
    throw new Error(
      'gip-approved-binding-resolver internal: undeclared ordering-key rule '
        + '(add it to the frozen ORDERING_KEY_SPEC_RULES vocabulary)',
    )
  }
  fail('ORDERING_KEY_SPEC_INVALID', message, { ...details, rule })
}

// ── TRUST = OBJECT IDENTITY (module-private, unforgeable) ──────────────────────────────
// The ONLY way in is to be produced by resolveApprovedBinding below. No public property is
// ever consulted, so a structurally perfect deep-frozen canonical clone of a real
// resolution is still refused.
const trustedBindingResolutions = new WeakSet()

function isTrustedBindingResolution(value) {
  // WeakSet.prototype.has(primitive) returns false rather than throwing.
  return trustedBindingResolutions.has(value)
}

function assertTrustedBindingResolution(resolution) {
  if (!trustedBindingResolutions.has(resolution)) {
    fail('RESOLUTION_NOT_TRUSTED', 'binding resolution was not produced by the approved-binding resolver', {})
  }
  return resolution
}

// ── Derivations (D2/D3) ───────────────────────────────────────────────────────────────
function canonicalSha256(material, reasonOnDomainError) {
  try {
    return crypto.createHash('sha256').update(stableCanonicalStringify(material), 'utf8').digest('hex')
  } catch (error) {
    if (error instanceof CanonicalDomainError) {
      // A record that cannot be canonicalized cannot be bound — fail closed, values-free.
      fail(reasonOnDomainError, 'record is outside the strict canonical JSON domain', {})
    }
    if (error instanceof RangeError) {
      // Defense in depth behind the depth RULE: stableCanonicalStringify recurses, so material
      // this module does not itself depth-check (anything other than the system identity config)
      // could still exhaust the stack. An unclassified RangeError would escape the frozen
      // vocabulary; convert it, so every refusal on this path carries a closed reason.
      fail(reasonOnDomainError, 'record is outside the strict canonical JSON domain', {})
    }
    throw error
  }
}

function requiredIdentityString(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
}

// D2.1 layer (2): a LOSSY PROJECTION MAY NEVER BACK A SYSTEM IDENTITY. Runs BEFORE any
// hashing, on whatever config is about to become identity material — so it protects the
// resolver path AND a direct assembleBindingTuple() call equally. There is no write-time
// system content-key column to compare against (unlike the config plane, R3.2), so this
// detects projection rather than verifying its absence; its rules are exactly the ways
// sanitizeIntegrationPayload can have touched the value (prototype, marker, dropped key).
// Iterative (an explicit stack): a hostile depth must not blow the guard's own frame before it
// can refuse — AND, because the canonical codec downstream is recursive, depth is enforced as a
// RULE here (SYSTEM_IDENTITY_CONFIG_TOO_DEEP) so the refusal is closed rather than a RangeError.
// VALUES-FREE: counts only — never the marker, never the key, never the value.
// The bindable nesting bound. Chosen well below the JS recursion limit that the canonical codec
// (stableCanonicalStringify) hits, so the CLOSED rule above always fires first; and far above any
// plausible connection config, so it never refuses a real system. It is a BINDABILITY bound, not a
// security claim: deeper configs are refused, never silently truncated.
const MAX_SYSTEM_IDENTITY_CONFIG_DEPTH = 64

function assertLosslessSystemIdentityConfig(config) {
  // A config is an OBJECT. isStrictPlainObject accepts a null prototype on purpose, so the
  // projected-record verdict below stays with the prototype rule rather than being masked
  // here as a generic shape error.
  if (!isStrictPlainObject(config)) {
    failSystemIdentityRule('SYSTEM_IDENTITY_CONFIG_SHAPE', 'system identity config is not a config object', { nodeCount: 0 })
  }
  const stack = [{ node: config, depth: 0 }]
  let nodeCount = 0
  while (stack.length > 0) {
    const framed = stack.pop()
    const node = framed.node
    const depth = framed.depth
    nodeCount += 1
    // DEPTH IS A RULE, not an accident (review round 4 regression). Reading identity LOSSLESSLY
    // put unbounded-depth JSONB on a path that ends in the RECURSIVE canonical codec: a hostile
    // depth blew the stack as a RangeError, ESCAPING the frozen vocabulary — fail-closed, but as
    // an unclassified fault a wiring gate would surface as a 500 rather than a closed refusal.
    // The pre-fix lossy read hid this by truncating at depth 6. Refuse here, values-free.
    if (depth > MAX_SYSTEM_IDENTITY_CONFIG_DEPTH) {
      failSystemIdentityRule(
        'SYSTEM_IDENTITY_CONFIG_TOO_DEEP',
        'system identity config nests deeper than the bindable maximum',
        { nodeCount },
      )
    }
    if (typeof node === 'string') {
      for (let index = 0; index < PROJECTION_MARKER_SUBSTRINGS.length; index += 1) {
        if (node.includes(PROJECTION_MARKER_SUBSTRINGS[index])) {
          failSystemIdentityRule(
            'SYSTEM_IDENTITY_REDACTION_MARKER',
            'system identity config carries a redaction/truncation marker',
            { nodeCount },
          )
        }
      }
      continue
    }
    if (node === null || typeof node === 'boolean' || typeof node === 'number') continue
    if (Array.isArray(node)) {
      if (!isStrictDenseArray(node)) {
        failSystemIdentityRule('SYSTEM_IDENTITY_CONFIG_SHAPE', 'system identity config carries a non-canonical array', { nodeCount })
      }
      for (let index = 0; index < node.length; index += 1) stack.push({ node: node[index], depth: depth + 1 })
      continue
    }
    if (typeof node !== 'object') {
      // undefined / function / symbol / bigint — unhashable, and unreachable from a JSONB row.
      failSystemIdentityRule('SYSTEM_IDENTITY_CONFIG_SHAPE', 'system identity config carries an unhashable value', { nodeCount })
    }
    if (Object.getPrototypeOf(node) !== Object.prototype) {
      // sanitizePayloadValue builds EVERY object node with Object.create(null); every raw
      // path (pg's JSON.parse, the registry's `{...value}` spread, a seeded literal) yields
      // Object.prototype. A null/exotic prototype here means the record is a PROJECTION.
      failSystemIdentityRule(
        'SYSTEM_IDENTITY_PROJECTED_PROTOTYPE',
        'system identity config is a projected record, not the stored one',
        { nodeCount },
      )
    }
    const keys = Object.getOwnPropertyNames(node)
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]
      if (UNSAFE_PAYLOAD_KEYS.has(key)) {
        // The ONE loss class a projection leaves no marker for: refuse to bind a config that
        // any projection would silently mangle, rather than mint an identity that a later
        // projection could not reproduce.
        failSystemIdentityRule(
          'SYSTEM_IDENTITY_UNPROJECTABLE_KEY',
          'system identity config carries a key no projection can preserve',
          { nodeCount },
        )
      }
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
        failSystemIdentityRule('SYSTEM_IDENTITY_CONFIG_SHAPE', 'system identity config carries a non-data property', { nodeCount })
      }
      // own-property READ: a legal own '__proto__' data key is refused above, and the domain
      // guarantees enumerable data properties only.
      stack.push({ node: descriptor.value, depth: depth + 1 })
    }
  }
}

function deriveSystemContentKey(systemRecord) {
  if (!isStrictPlainObject(systemRecord)
    || !requiredIdentityString(systemRecord.id)
    || !requiredIdentityString(systemRecord.tenantId)
    || !requiredIdentityString(systemRecord.kind)
    || !requiredIdentityString(systemRecord.role)) {
    fail('SYSTEM_RECORD_UNRESOLVABLE', 'system record is not a usable identity record', {})
  }
  // CREDENTIAL MATERIAL NEVER REACHES THE HASHING PATH. The lossless read carries decrypted
  // credentials; loadSystemRecord narrows them away at the boundary. Enforcing it HERE makes
  // that narrowing load-bearing instead of a comment: drop it and every resolution of a system
  // that HAS credentials fails closed, which a test can see.
  if (Object.prototype.hasOwnProperty.call(systemRecord, 'credentials')) {
    failSystemIdentityRule('SYSTEM_IDENTITY_CREDENTIAL_MATERIAL', 'system identity record carries credential material', {})
  }
  // Endpoint/connection identity — repointing the system invalidates old qualifications.
  // ONLY if what we hash is the STORED config: guard BEFORE hashing (D2.1).
  const config = systemRecord.config ?? {}
  assertLosslessSystemIdentityConfig(config)
  const material = {
    domain: SYSTEM_CONTENT_KEY_DOMAIN,
    systemId: systemRecord.id,
    tenantId: systemRecord.tenantId,
    workspaceId: systemRecord.workspaceId ?? null,
    kind: systemRecord.kind,
    role: systemRecord.role,
    config,
  }
  return `sck1:${canonicalSha256(material, 'SYSTEM_RECORD_UNRESOLVABLE')}`
}

// The declared canonical shape of the object: an ORDERED projection of { source, target }.
// Closed shape — a malformed fieldMap is a closed rejection, never a coerced string.
function normalizeFieldProjection(body) {
  if (body.fieldMap === undefined) return []
  if (!isStrictDenseArray(body.fieldMap)) {
    fail('APPROVED_BODY_FIELD_MAP_INVALID', 'approved body field map is not a dense array', {})
  }
  const projection = []
  for (let index = 0; index < body.fieldMap.length; index += 1) {
    const entry = body.fieldMap[index]
    const entryKeys = isStrictPlainObject(entry) ? Object.keys(entry).sort() : null
    if (entryKeys === null
      || entryKeys.length !== 2 || entryKeys[0] !== 'source' || entryKeys[1] !== 'target'
      || typeof entry.source !== 'string' || entry.source.length === 0
      || typeof entry.target !== 'string' || entry.target.length === 0) {
      fail('APPROVED_BODY_FIELD_MAP_INVALID', 'approved body field map entry is not a { source, target } pair', {
        entryCount: body.fieldMap.length,
      })
    }
    projection.push({ source: entry.source, target: entry.target })
  }
  return projection
}

function deriveCanonicalObjectVersion({ systemContentKey, objectKey, fieldProjection }) {
  const material = {
    domain: CANONICAL_OBJECT_VERSION_DOMAIN,
    systemContentKey,
    objectKey,
    projection: fieldProjection,
  }
  return `cov1:${canonicalSha256(material, 'APPROVED_BODY_FIELD_MAP_INVALID')}`
}

// ── R6 schema ─────────────────────────────────────────────────────────────────────────
// VALIDATE-THEN-ALIAS on purpose: the body's own array is returned. Ownership of the whole
// tuple is taken at ONE choke point (deepCloneFrozenCanonical) so there is a single place
// to audit — see the R2 note in the header.
function normalizeOrderingKeySpec(body, fieldProjection) {
  const spec = body.orderingKeySpec
  if (!isStrictDenseArray(spec)) {
    failOrderingKeyRule('ORDERING_KEY_SPEC_SHAPE', 'ordering key spec must be a dense array', {})
  }
  if (spec.length === 0) {
    failOrderingKeyRule('ORDERING_KEY_SPEC_EMPTY', 'ordering key spec must be non-empty', {})
  }
  const resolvable = new Set()
  for (let index = 0; index < fieldProjection.length; index += 1) resolvable.add(fieldProjection[index].target)
  const seen = new Set()
  for (let index = 0; index < spec.length; index += 1) {
    const entry = spec[index]
    if (!isStrictPlainObject(entry)) {
      failOrderingKeyRule('ORDERING_KEY_ENTRY_SHAPE', 'ordering key entry must be a plain object', { entryCount: spec.length })
    }
    const keys = Object.keys(entry).sort()
    // CLOSED entry: exactly { fieldId, direction }. An extra key is a silent capability.
    if (keys.length !== 2 || keys[0] !== 'direction' || keys[1] !== 'fieldId') {
      failOrderingKeyRule('ORDERING_KEY_ENTRY_SHAPE', 'ordering key entry must carry exactly a fieldId and a direction', { entryCount: spec.length })
    }
    if (typeof entry.fieldId !== 'string' || !CANONICAL_FIELD_ID.test(entry.fieldId)) {
      // Kills raw SQL, expressions, aliases, quoted identifiers and dotted paths BY SYNTAX.
      failOrderingKeyRule('ORDERING_KEY_FIELD_ID_NOT_CANONICAL', 'ordering key field id is not a canonical field identifier', { entryCount: spec.length })
    }
    if (seen.has(entry.fieldId)) {
      failOrderingKeyRule('ORDERING_KEY_FIELD_ID_DUPLICATE', 'ordering key spec repeats a field id', { entryCount: spec.length })
    }
    seen.add(entry.fieldId)
    if (!ORDERING_KEY_DIRECTIONS.includes(entry.direction)) {
      // STRICT CASE (see header): 'asc' is refused, never uppercased.
      failOrderingKeyRule('ORDERING_KEY_DIRECTION_INVALID', 'ordering key direction must be ASC or DESC', { entryCount: spec.length })
    }
    if (!resolvable.has(entry.fieldId)) {
      // Must resolve through the SAME approved version's field mapping.
      failOrderingKeyRule('ORDERING_KEY_FIELD_ID_UNRESOLVED', 'ordering key field id does not resolve in this approved version', { entryCount: spec.length })
    }
  }
  return spec
}

// ── Tuple assembly ────────────────────────────────────────────────────────────────────
// TWO PARAMETERS, both SERVER-side records. The caller's run input is NOT a parameter: an
// override is inexpressible here, not merely rejected (R3.4b). This function also does NOT
// read approvedRow.contentKey — the tuple's configContentKey is recomputed from the body,
// so the stored column never enters the tuple's provenance path.
function assembleBindingTuple(approvedRow, systemRecord) {
  const body = approvedRow.config
  const actionProfileVersion = body.actionProfileVersion
  if (typeof actionProfileVersion !== 'string'
    || actionProfileVersion.length > 128
    || !PROFILE_ID_PATTERN.test(actionProfileVersion)) {
    fail('ACTION_PROFILE_VERSION_INVALID', 'approved body does not declare a valid action profile version', {})
  }
  const objectKey = approvedRow.object
  if (!requiredIdentityString(objectKey)) {
    fail('APPROVED_ROW_BODY_DIVERGENT', 'approved row does not carry a usable object key', {})
  }
  const fieldProjection = normalizeFieldProjection(body)
  const systemContentKey = deriveSystemContentKey(systemRecord)
  return {
    actionProfileVersion,
    systemContentKey,
    configContentKey: recomputeConfigContentKey(body),
    objectKey,
    canonicalObjectVersion: deriveCanonicalObjectVersion({ systemContentKey, objectKey, fieldProjection }),
    orderingKeySpec: normalizeOrderingKeySpec(body, fieldProjection),
  }
}

function recomputeConfigContentKey(body) {
  try {
    return contentKeyFor(body)
  } catch (_error) {
    fail('CONFIG_CONTENT_KEY_MISMATCH', 'approved config body could not be content-keyed', {})
  }
  return undefined // unreachable: fail() always throws
}

// ── Run input (scope only) ────────────────────────────────────────────────────────────
function normalizeRunInput(input) {
  if (!isStrictPlainObject(input)) {
    fail('RESOLVER_INPUT_INVALID', 'run input must be a plain object', { rule: 'RUN_INPUT_SHAPE' })
  }
  const keys = Object.keys(input)
  let rejectedKeyCount = 0
  for (let index = 0; index < keys.length; index += 1) {
    if (!RUN_INPUT_KEYS.includes(keys[index])) rejectedKeyCount += 1
  }
  if (rejectedKeyCount > 0) {
    // COUNT ONLY — the offending key name is attacker-chosen text and never echoed.
    fail('RESOLVER_INPUT_INVALID', 'run input carries keys outside the scope allowlist', {
      rule: 'RUN_INPUT_NOT_ALLOWLISTED',
      rejectedKeyCount,
    })
  }
  if (!requiredIdentityString(input.tenantId)) {
    fail('RESOLVER_INPUT_INVALID', 'run input must carry a tenant scope', { rule: 'RUN_INPUT_SCOPE' })
  }
  if (!requiredIdentityString(input.approvedConfigVersionId)) {
    fail('RESOLVER_INPUT_INVALID', 'run input must carry an approved config version id', { rule: 'RUN_INPUT_SCOPE' })
  }
  const workspaceId = input.workspaceId === undefined || input.workspaceId === null || input.workspaceId === ''
    ? null
    : input.workspaceId
  if (workspaceId !== null && !requiredIdentityString(workspaceId)) {
    fail('RESOLVER_INPUT_INVALID', 'run input workspace scope must be a string when present', { rule: 'RUN_INPUT_SCOPE' })
  }
  return { tenantId: input.tenantId, workspaceId, approvedConfigVersionId: input.approvedConfigVersionId }
}

async function loadApprovedRow(configStore, scope) {
  let row
  try {
    row = await configStore.getForRuntime({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      id: scope.approvedConfigVersionId,
    })
  } catch (_error) {
    // MERGED on purpose (header R3.1): not-found / out-of-scope / not-approved / any other
    // store failure are one closed reason. No cross-tenant existence oracle.
    fail('APPROVED_VERSION_UNRESOLVABLE', 'no approved read-source config version is resolvable in this scope', {})
  }
  if (!isStrictPlainObject(row) || !isStrictPlainObject(row.config) || row.status !== 'approved') {
    // Belt-and-braces: a store double or a future store variant that returns instead of
    // throwing must not slip a non-approved row through.
    fail('APPROVED_VERSION_UNRESOLVABLE', 'no approved read-source config version is resolvable in this scope', {})
  }
  return row
}

async function loadSystemRecord(systemRegistry, scope, systemId) {
  let system
  try {
    // THE LOSSLESS READ (D2.1). `getExternalSystemForAdapter` returns the row's OWN config
    // (rowToAdapterExternalSystem: `config: row.config ?? {}`); `getExternalSystem` returns
    // sanitizeIntegrationPayload(row.config) and MUST NOT be used for identity — hashing that
    // projection was the proven forgery. Swapping this call back is caught by the
    // prototype rule in assertLosslessSystemIdentityConfig, not silently accepted.
    system = await systemRegistry.getExternalSystemForAdapter({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      id: systemId,
    })
  } catch (_error) {
    fail('SYSTEM_RECORD_UNRESOLVABLE', 'no usable system record is resolvable in this scope', {})
  }
  if (!isStrictPlainObject(system)) {
    fail('SYSTEM_RECORD_UNRESOLVABLE', 'no usable system record is resolvable in this scope', {})
  }
  if (system.status !== 'active') {
    // D4: admission gate, not identity (status is deliberately not hashed).
    fail('SYSTEM_RECORD_UNRESOLVABLE', 'system record is not admitted for binding', {})
  }
  if (!READ_CAPABLE_SYSTEM_ROLES.includes(system.role)) {
    // A READ binding may not be taken against a write-only target system.
    fail('SYSTEM_RECORD_UNRESOLVABLE', 'system record is not read-capable', {})
  }
  // NARROW TO IDENTITY, by named reads, at the boundary: the adapter read also carries
  // DECRYPTED credential material, which this module must never hold past this line — not in
  // assembly, not in the digest, not in an error. Nothing outside these keys survives, and
  // deriveSystemContentKey REFUSES a record that still carries them, so this narrowing is
  // ENFORCED rather than asserted (SYSTEM_IDENTITY_CREDENTIAL_MATERIAL).
  return {
    id: system.id,
    tenantId: system.tenantId,
    workspaceId: system.workspaceId ?? null,
    kind: system.kind,
    role: system.role,
    status: system.status,
    config: system.config ?? {},
  }
}

// ── The resolver ──────────────────────────────────────────────────────────────────────
async function resolveApprovedBinding({ configStore, systemRegistry, runInput }) {
  const scope = normalizeRunInput(runInput)
  const row = await loadApprovedRow(configStore, scope)
  const body = row.config

  // STORED-COLUMN DISTRUST (1/2): denormalized columns must agree with the immutable body.
  if (body.object !== row.object || body.systemId !== row.systemId) {
    fail('APPROVED_ROW_BODY_DIVERGENT', 'approved row columns diverge from the immutable config body', {})
  }
  // STORED-COLUMN DISTRUST (2/2): recompute the content key and compare to the column.
  const recomputedContentKey = recomputeConfigContentKey(body)
  if (typeof row.contentKey !== 'string'
    || row.contentKey.length !== recomputedContentKey.length
    || row.contentKey !== recomputedContentKey) {
    fail('CONFIG_CONTENT_KEY_MISMATCH', 'stored content key does not match the immutable config body', {})
  }

  const system = await loadSystemRecord(systemRegistry, scope, body.systemId)
  const draft = assembleBindingTuple(row, system)

  const draftKeys = Object.keys(draft).sort()
  const expectedKeys = [...BINDING_RESOLUTION_FIELDS].sort()
  if (draftKeys.length !== expectedKeys.length || draftKeys.some((key, index) => key !== expectedKeys[index])) {
    fail('RESOLUTION_DOMAIN_INVALID', 'resolution must carry exactly the closed six-field tuple', {
      fieldCount: draftKeys.length,
    })
  }

  // THE ONE OWNERSHIP CHOKE POINT (R2): owned, recursively frozen, strict-canonical clone.
  let owned
  try {
    owned = deepCloneFrozenCanonical(draft)
  } catch (error) {
    if (error instanceof CanonicalDomainError) {
      fail('RESOLUTION_DOMAIN_INVALID', 'resolution is outside the strict canonical JSON domain', {})
    }
    throw error
  }
  trustedBindingResolutions.add(owned)
  return owned
}

// SERVICE FACTORY: dependencies are captured ONCE, server-side. Run data can never carry a
// store or a registry (they are not in RUN_INPUT_KEYS), mirroring the qualification spike's
// P1 fix against duck-typed per-call dependency injection.
function createApprovedBindingResolver({ configStore, systemRegistry } = {}) {
  if (!configStore || typeof configStore.getForRuntime !== 'function') {
    fail('RESOLVER_DEPENDENCY_INVALID', 'an approved read-source config store is required', {})
  }
  // D2.1(1): the UNSANITIZED read is the required capability. A registry that offers only
  // the sanitized `getExternalSystem` is refused HERE — the lossy path is never wired, so it
  // cannot be reached by a later refactor either. Deliberately NOT a capability negotiation
  // ("use the lossless read if present, else fall back"): a duck-typed preference is the same
  // shape as the injection bypass this line exists to prevent.
  if (!systemRegistry || typeof systemRegistry.getExternalSystemForAdapter !== 'function') {
    fail('RESOLVER_DEPENDENCY_INVALID', 'an external system registry with an unsanitized identity read is required', {})
  }
  return Object.freeze({
    resolveApprovedBinding(runInput) {
      return resolveApprovedBinding({ configStore, systemRegistry, runInput })
    },
  })
}

module.exports = {
  BINDING_RESOLUTION_ERROR_REASONS,
  BINDING_RESOLUTION_FIELDS,
  ORDERING_KEY_SPEC_RULES,
  SYSTEM_IDENTITY_SOURCE_RULES,
  ORDERING_KEY_DIRECTIONS,
  GipBindingResolutionError,
  createApprovedBindingResolver,
  assertTrustedBindingResolution,
  isTrustedBindingResolution,
  __internals: {
    fail,
    assembleBindingTuple,
    normalizeOrderingKeySpec,
    normalizeRunInput,
    assertLosslessSystemIdentityConfig,
    deriveSystemContentKey,
    deriveCanonicalObjectVersion,
    normalizeFieldProjection,
    CANONICAL_FIELD_ID,
    RUN_INPUT_KEYS,
  },
}
