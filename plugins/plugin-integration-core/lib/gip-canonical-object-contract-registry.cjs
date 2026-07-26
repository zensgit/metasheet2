'use strict'

// GIP-D0 B1a — step 1.3: first-party canonical object contract registry +
// version lookup (owner decision γ, ledger §4.0 row γ / §4 step 1.3 / §3.0 B-3).
//
// LATENT: not wired to any runtime, route, scheduler or flag. No caller in
// this tree consults CANONICAL_OBJECT_CONTRACT_REGISTRY yet.
//
// `canonicalObjectVersion` names the version of OUR OWN first-party canonical
// object contract — never a witness of external source-side schema (that is
// source-catalog evidence / BindingQualification / field-mapping proof,
// ledger §3.0 B-3). The prior (HELD, non-ratified) attempt derived this field
// as a pure function of inputs already present elsewhere in the qualification
// tuple (systemContentKey + objectKey + fieldMap) — adding no contract
// identity at all. This module is the registry that closes that: a version is
// either REGISTERED here (first-party, deliberate) or it does not exist.
//
// Ruled design (owner decision γ, ledger §4.0):
//   - first-party only; contracts registered IMMUTABLY by contractId+version;
//     versions APPEND-ONLY — a registered version is never edited or replaced;
//   - NO auto-synthesis from customer config — the failure mode this closes
//     is exactly B-3's "invented locally". STRUCTURAL, not conventional (P3-b
//     fix, review round 2 — the prior shape here was FALSE to this comment:
//     `register` sat on the frozen singleton itself, reachable by ANY module
//     holding the import, at ANY time during a running process, which is
//     exactly the runtime-customer-synthesis mode this decision closes — see
//     the git history of this file for the shape that comment was written
//     against). The fix mirrors gip-connector-kind-registry.cjs's already-
//     audited pattern exactly: entries are supplied ONLY as a fixed array to
//     createCanonicalObjectContractRegistry(entries) at construction time;
//     the returned frozen object exposes ONLY lookup()/size() — there is no
//     register/add/set verb anywhere on it, under any name, pinned by the
//     exact-key-set test. "Append" now means a future, separately-reviewed
//     amendment edits THIS FILE's own CANONICAL_OBJECT_CONTRACT_REGISTRY
//     literal entries array (a real code change, a real review) — never a
//     runtime call from anywhere else in the process;
//   - unregistered => values-free CANONICAL_OBJECT_CONTRACT_UNREGISTERED;
//   - inventory + backfill of existing references BEFORE activation — see
//     assertCanonicalObjectContractRegistryActivationReady below. Per the
//     #4609 amendment (an inventory TOOL is not an inventory RESULT — the
//     probe tooling's CI runs a fake executor with no real database), the
//     concrete reference list this gate needs does not exist yet. The gate
//     therefore requires its caller to name that fact explicitly
//     (inventoryStatus) rather than let an empty array default to "clean" —
//     an omitted/'NOT_RUN' inventory refuses activation exactly like an
//     inventory that found unbacked references; only an explicit COMPLETE
//     status with zero unbacked references reports ready.
//
// This module SHIPS its default registry EMPTY: no contract has been
// registered by anyone yet. Only a future, separately-reviewed amendment may
// extend the literal entries array passed to createCanonicalObjectContractRegistry below.
//
// CLOSED ERROR CONTRACT (owner HARD HOLD #4610, round 7 — adopted explicitly
// here so this module stops being asymmetric with its sibling
// gip-connector-kind-registry.cjs, which already states an equivalent
// contract inline near its own readDeclaredField): every error this module
// throws in response to CALLER-SUPPLIED input — a malformed declaration, a
// hostile getter on a declared field, a hostile Proxy's ownKeys trap during
// enumeration, a hostile array iterator or index accessor on an `entries`
// array — is a GipCanonicalObjectContractError carrying one of the frozen
// CANONICAL_OBJECT_CONTRACT_ERROR_REASONS tokens above, never a raw foreign
// error (class, message, or stack) from whatever object supplied the input —
// with two narrow, measured exceptions, stated honestly in the SCOPE
// paragraph below rather than left as an unqualified "never". Two read paths
// this round closed to make the above true for every OTHER caller-reachable
// route:
// readEntryField (guards `entry.contractId` / `entry.version` / `entry.fields`
// reads — RAW-CONTRACT-ID — and the `Object.keys(rawFields)` ENUMERATION
// itself — RAW-OWN-KEYS, a distinct step from the property read, since a
// Proxy's `ownKeys` trap can throw during enumeration even when the read that
// produced the Proxy succeeded) and readArrayLength/readArrayElement (guards
// the `entries` array's iteration — RAW-CANONICAL-ITERATOR — a genuine array
// with a hostile index accessor or an attacker-assigned `Symbol.iterator`
// passes `Array.isArray` exactly like an ordinary array).
// SCOPE, stated honestly (the same discipline this file already uses for
// LATENT/unreachable paths) — NARROWER than "never a raw foreign error" reads
// on its own, in two ways measured directly, not merely asserted: (1) a
// pathologically deep `fields` value drives `deepCloneFrozenCanonical`
// (gip-canonical-json.cjs) past the JS engine's own call-stack limit; its
// `throw error` re-throw for a non-`CanonicalDomainError` forwards that
// engine-generated `RangeError: Maximum call stack size exceeded` RAW —
// unbranded — out of `createCanonicalObjectContractRegistry`. No attacker
// TEXT escapes this way (the message is engine-authored, not caller-supplied),
// so it is not a values-free leak, but it IS a raw foreign CLASS crossing this
// module's boundary, contradicting "never" read literally; closing it is a
// separate, future fix, not claimed here. (2) RETRACTED (owner P1 #4610, this
// round) — this exception used to read: "fail()'s own internal
// undeclared-reason branch (a bare Error, deliberately NOT a
// GipCanonicalObjectContractError) is reachable directly by ANY caller who
// invokes the exported `__internals.fail('SOME_UNDECLARED_REASON', ...)`
// themselves — `fail` is exported, so 'never on any caller-supplied input' is
// imprecise". `fail` is NO LONGER EXPORTED (see module.exports at the foot of
// this file; the sibling gip-system-identity-read.cjs removed its own for the
// identical reason and records that at its own fail()). That route is gone,
// and the narrowing it justified is WITHDRAWN here rather than silently
// deleted.
//   What replaces it is NOT "this module can no longer be made to author a
// branded error carrying caller text" — that would be the same overclaim one
// namespace deeper, and it is measurably false. `requiredIdentityToken` is
// still on __internals, and it calls fail() with a CALLER-SUPPLIED `field`
// string that lands in BOTH the message and `details.field`: a direct
// `__internals.requiredIdentityToken(42, attackerText)` throws a GENUINELY
// branded GipCanonicalObjectContractError carrying attackerText, having never
// touched `fail` at all. Removing the `fail` export therefore NARROWS
// genuine-brand manufacture; it does not eliminate it — and no
// `instanceof` / private-WeakSet "is this error mine?" test can ever separate
// such an error from a legitimate internal one, because it IS legitimate by
// construction. That is exactly why the defence at every foreign-call
// boundary in this module is UNCONDITIONAL conversion — discard every throw,
// branded or not — and never a brand test. Both shapes are pinned by
// negative controls in this module's test file (the public-class forgery and
// the genuine-brand manufacture), each proven load-bearing by a separate
// neutering mutation. With that narrowing stated, this contract covers every
// OTHER error reachable from this module's EXPORTED surface today. It does
// NOT cover buildInventoryAttestation's own `references` array reads, which
// have the identical unguarded shape — that function is module-private with
// ZERO call sites anywhere in this shipped module (see the LATENT note above
// it), so there is no path, in production or in any test, that could
// exercise a fix there; a future amendment wiring a real caller to it must
// close that same gap before shipping.

const { deepCloneFrozenCanonical, CanonicalDomainError } = require('./gip-canonical-json.cjs')

const CANONICAL_OBJECT_CONTRACT_ERROR_REASONS = Object.freeze([
  'CANONICAL_OBJECT_CONTRACT_UNREGISTERED',
  'CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID',
  'CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE',
  'CANONICAL_OBJECT_CONTRACT_ACTIVATION_BLOCKED',
  'CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT',
  'CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED',
])
const ERROR_REASON_SET = new Set(CANONICAL_OBJECT_CONTRACT_ERROR_REASONS)

class GipCanonicalObjectContractError extends Error {
  constructor(reason, message, details = {}) {
    super(message)
    this.name = 'GipCanonicalObjectContractError'
    this.reason = reason
    this.details = details
  }
}

// P1 FIX (owner #4610 — part 3 of the ruled fix, mirroring
// gip-system-identity-read.cjs's identical removal): `fail` is NOT exported,
// not at the top level and not under __internals. Exporting it handed any
// require()-holding caller — including the very actors this module must not
// trust (a hostile `registry.lookup`, a hostile getter on a declaration) — a
// primitive for manufacturing a GENUINELY branded GipCanonicalObjectContractError
// carrying arbitrary message/details. It had ZERO callers outside this file
// (`grep -rn "__internals\.fail" plugins/ apps/ packages/` finds no call site
// for this module), so the export bought nothing and cost a forge primitive.
// See the module header's retracted SCOPE exception (2) for why removing it
// NARROWS but does not eliminate genuine-brand manufacture, and why the
// load-bearing defence is unconditional conversion rather than a brand test.
function fail(reason, message, details = {}) {
  if (!ERROR_REASON_SET.has(reason)) {
    throw new Error(
      'gip-canonical-object-contract-registry internal: undeclared error reason '
        + '(add it to the frozen CANONICAL_OBJECT_CONTRACT_ERROR_REASONS vocabulary)',
    )
  }
  throw new GipCanonicalObjectContractError(reason, message, details)
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// RETRACTION (P3 fix, post-round-8 review of #4610): this comment used to
// read "printable ASCII is code point 0x20-0x7e; anything below 0x20 or
// exactly 0x7f (DEL) is a control character" — FALSE as a description of
// what this function accepts. Measured directly against the code as it
// stands: 0x85 (NEL), 0xa0 (NBSP), U+2028 (LINE SEPARATOR) and U+200b (ZWSP)
// are all ACCEPTED by hasControlCharacter — none of the four is in
// 0x20-0x7e, and none of them is flagged. "Printable ASCII 0x20-0x7e" was
// never an allow-list this code enforced; it was aspirational text that
// drifted from the code underneath it. The TRUE invariant, measured: this
// function rejects ONLY the C0 control range (code points 0x00-0x1f) and DEL
// (0x7f) — every OTHER code point, including non-ASCII and non-printable
// Unicode above 0x7e, passes through undetected. Control-char check via
// explicit char-code comparison (never a regex escape literal).
//
// TRIM INTERACTION (documented here because it changes what a CALLER sees,
// even though it happens one level up, in requiredIdentityToken below):
// `String.prototype.trim()` strips ECMAScript's own WhiteSpace/LineTerminator
// sets BEFORE this function ever runs. NBSP (0xa0) and LINE SEPARATOR
// (U+2028) are both in those sets, so a token composed SOLELY of one of them
// trims to '' and is refused by requiredIdentityToken's non-empty check —
// not by hasControlCharacter, which never sees it. NEL (0x85) and ZWSP
// (U+200b) are NOT in ECMAScript's WhiteSpace/LineTerminator sets (despite
// the "space" in ZWSP's name) — a token composed solely of either survives
// trim() unchanged and is accepted whole. All four survive untouched, and
// are therefore accepted, when they appear BETWEEN other characters in an
// otherwise-valid token (trim only strips leading/trailing runs) — see this
// module's test file for both shapes measured directly.
//
// P1 FIX (owner HARD HOLD #4610, round 8 — closing a review-round-7 false
// claim): round 7's own commit message asserted "Spot-checked the two
// remaining __internals keys (requiredIdentityToken, hasControlCharacter):
// both gate on `typeof value !== 'string'` before touching the value" — FALSE
// for hasControlCharacter, which had NO type gate of its own: its only
// caller, requiredIdentityToken, gates on `typeof value !== 'string'` BEFORE
// calling it, but hasControlCharacter is ALSO on __internals (exported
// directly, reachable by any require()-holding caller, exactly the surface
// round 7's own "CLOSED ERROR CONTRACT" header commits to guarding) and was
// exercised with a bare `text.length`/`text.charCodeAt` — a hostile non-string
// argument such as `{ length: { valueOf() { throw ... } } }` threw a raw,
// unbranded error straight out of this function; a plain non-string
// primitive (e.g. `42`) silently returned `false` with no gate at all,
// which is not an escape but is not a validated contract either. Adding the
// SAME gate its caller already applies makes the module's own two callers
// symmetric and, applied here too, makes hasControlCharacter closed under
// hostile input on its own terms, not merely by accident of always being
// called after another function's check.
function hasControlCharacter(text) {
  if (typeof text !== 'string') {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'hasControlCharacter requires a string input', {})
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

// P1 FIX (owner HARD HOLD #4610, round 7 — RAW-CONTRACT-ID / a fourth,
// closely-coupled `fields` read of the identical class): mirrors
// gip-connector-kind-registry.cjs's readDeclaredField exactly. A plain data
// property never throws on read; a hostile GETTER on `entry.contractId`,
// `entry.version`, or `entry.fields` can — and unguarded, the raw foreign
// error it throws would escape this module verbatim, breaking
// normalizeContractEntry's own contract that every error it throws is a
// GipCanonicalObjectContractError (see the module header's "closed error
// contract" paragraph). Every foreign throw crossing this read is
// unconditionally discarded and replaced with this module's own fixed,
// values-free reason. Module-private — not exported, not under __internals
// (the exact-key-set test below pins __internals's key set).
function readEntryField(entry, field) {
  try {
    return entry[field]
  } catch {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', `${field} could not be read from the declaration`, { field })
  }
}

// P1 FIX (owner HARD HOLD #4610, round 7 — RAW-CANONICAL-ITERATOR, and the
// same fix applied to the pre-existing array reads in this module): the SAME
// class of hole as readEntryField above, one mechanism deeper. An ARRAY's
// `.length` own-property read and its indexed element reads are ordinary
// `[[Get]]` operations exactly like `entry[field]` — `Array.isArray` is true
// for a Proxy WRAPPING a real array target (the spec's IsArray walks the
// proxy target chain without invoking any trap), so a Proxy with a hostile
// `get` trap passes `Array.isArray` and then throws raw the moment `.length`
// or an index is actually read through it. `for...of` additionally invokes
// the iterator protocol / Symbol.iterator — itself overridable as an own
// property on a genuine array without breaking Array.isArray, and without
// tripping the own-property-symbol check `isStrictPlainObject`/
// `isStrictDenseArray` run on `fields` values elsewhere in this file (this
// `entries` array is validated only by `Array.isArray`, not by the strict
// canonical-JSON codec). These two helpers are the guarded read path for
// `entries` in createCanonicalObjectContractRegistry — the one array this
// shipped module actually iterates over caller/first-party-authored input
// today. (buildInventoryAttestation's own `references` array has the
// identical unguarded-iteration shape and is NOT fixed here: that function
// is module-private with ZERO call sites anywhere in this shipped module —
// see the LATENT note above it — so there is no path, in production or in
// any test, that could ever reach it; a change there would be unverifiable
// by construction, not merely untested. A future amendment that wires a real
// caller to buildInventoryAttestation must apply this SAME fix to its
// `references` reads before that wiring ships.) Module-private, not
// exported, not under __internals — mirrors readEntryField's placement
// exactly.
function readArrayLength(array, field) {
  let length
  try {
    length = array.length
  } catch {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', `${field} length could not be read from the declaration`, { field })
  }
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > Number.MAX_SAFE_INTEGER) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', `${field} must have a valid array length`, { field })
  }
  return length
}

function readArrayElement(array, index, field) {
  try {
    return array[index]
  } catch {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', `${field} element could not be read from the declaration`, { field })
  }
}

// RETRACTION (P3 fix, post-round-8 review of #4610): the rejection message
// below used to read "must be a non-empty, <=128 printable-char token" —
// the SAME "printable" overclaim retracted above hasControlCharacter, at the
// caller-visible surface this time. Corrected to name the actual gates this
// function applies, in the order it applies them: type, then trim, then
// non-empty, then length, then hasControlCharacter's C0/DEL check (see that
// function's comment for what trim() does to whitespace-only tokens before
// this check ever runs).
function requiredIdentityToken(value, field) {
  if (typeof value !== 'string') {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', `${field} must be a string`, { field })
  }
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 128 || hasControlCharacter(trimmed)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', `${field} must be a non-empty, <=128-character token after trimming, with no C0 control characters (0x00-0x1f) or DEL (0x7f)`, { field })
  }
  return trimmed
}

// TRUST is OBJECT IDENTITY (module-private WeakSet) — same unforgeable pattern
// as the probe-strategy and connector-kind registries.
// P2 FIX (review round 3): this WeakSet is NOT re-exported via __internals —
// matches gip-binding-qualification-spike.cjs's precedent (it does not
// export its own trustedProbeStrategyRegistries either) and
// gip-connector-kind-registry.cjs's sibling fix in this same round.
// Exporting it would have let ANY require()-holding caller do
// `__internals.trustedContractRegistries.add(fakeRegistry)`, turning a
// duck-typed forgery into something assertTrustedRegistry accepts — after
// which `registry.lookup(...)` above becomes attacker-controlled and could
// throw arbitrary text straight out of resolveCanonicalObjectContractVersion
// — "unforgeable" above is true only because this stays private.
// PRECISION FIX (owner #4610, this round): this note used to name BOTH
// resolveCanonicalObjectContractVersion AND
// assertCanonicalObjectContractRegistryActivationReady as places that
// "neither wraps that call in a discarding catch". That is now HALF FALSE and
// is corrected rather than left to rot: the activation path reaches
// registry.lookup only through computeActivationReadiness, which DOES wrap it
// in an unconditional discarding catch (see its own P1 note below), so only
// resolveCanonicalObjectContractVersion still calls lookup unwrapped. That
// remaining call is reached only AFTER assertTrustedRegistry, so the callee
// is always the genuine module-built closure, whose sole throw path is this
// module's own requiredIdentityToken with FIXED field literals — no
// caller-supplied text. It is not a leak today; it is load-bearing only while
// this WeakSet stays private, which is what this note exists to say.
//
// P1-1 FIX (owner HARD HOLD #4610 — the SAME finding as
// gip-connector-kind-registry.cjs's sibling module, mirrored here exactly):
// round 3's fix above closed only the `.add(fake)` door; the front door was
// still open, because createCanonicalObjectContractRegistry — this module's
// exported factory — unconditionally added every registry it built to this
// WeakSet. Any importer could call it directly and receive back a "trusted"
// object with no source edit at all. Fixed the same way as the sibling
// module: createCanonicalObjectContractRegistry below now only builds a
// registry object; trust is granted in EXACTLY one place,
// buildTrustedCanonicalObjectContractRegistry, which is NEVER exported —
// not at the top level, not under __internals (still reachable via
// require() by any importer, so a trust-granting constructor there is the
// identical hole one namespace deeper). Its only caller is the literal
// invocation that builds CANONICAL_OBJECT_CONTRACT_REGISTRY at module load,
// below.
const trustedContractRegistries = new WeakSet()

// P1-3 FIX (owner HARD HOLD #4610): assertCanonicalObjectContractRegistryActivationReady
// used to accept a PLAIN, caller-supplied object as inventoryReport — a
// caller could simply write `{ inventoryStatus: 'COMPLETE', references: [] }`
// and get `ready: true` back. "A tool is not a result" (this line's own
// ratified discipline, #4609's ⟲OD2 amendment) applies just as much to a
// caller-asserted STRING as to a caller-asserted tool run: a string is not
// evidence either. TRUST is, again, object identity — an inventory report is
// "attested" only if it was built by buildInventoryAttestation below, which
// is NEVER exported anywhere (not even __internals: unlike a pure function,
// this constructor's mere output identity confers a security property a
// later gate trusts, exactly the class of thing P1-1 above says must never
// be reachable via require()). Nothing in this shipped module calls it —
// there is no real inventory scanner in this repo yet (LATENT slice, no
// wiring) — so assertCanonicalObjectContractRegistryActivationReady refuses
// EVERY caller today, unconditionally. A future, separately-reviewed
// amendment that wires a genuine server-side inventory scan must call
// buildInventoryAttestation from a line added to THIS FILE — never from a
// runtime call anywhere else in the process.
const trustedInventoryAttestations = new WeakSet()

function assertTrustedRegistry(registry) {
  if (!trustedContractRegistries.has(registry)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'a trusted canonical-object-contract registry (from createCanonicalObjectContractRegistry) is required', { field: 'registry' })
  }
}

// Normalizes and validates ONE contract-version entry. `fields` is validated
// only for shape here (a non-empty plain object) — GIP-D0 §4's field-level
// requirement vocabulary (ALL_ROWS_REQUIRED / NON_EMPTY_WHEN_PRESENT /
// OPTIONAL, standardization rules, closed-vocabulary mapping, identity-key
// uniqueness) is a further specification this registry's mechanics do not
// build — out of scope for step 1.3, which is the identity+version+lookup+
// activation-gate mechanism, not the field-contract content model.
function normalizeContractEntry(entry) {
  if (!isPlainObject(entry)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'a contract registration must be a plain object', {})
  }
  // P1 FIX (owner HARD HOLD #4610, round 7 — RAW-CONTRACT-ID): `entry.contractId`
  // and `entry.version` used to be read DIRECTLY, unguarded — a hostile GETTER
  // on either property throws raw straight out of this function (and out of
  // createCanonicalObjectContractRegistry above it), verbatim, attacker text
  // and all. readEntryField (see its comment above) is the SAME guarded-read
  // shape gip-connector-kind-registry.cjs's readDeclaredField already uses for
  // every one of ITS declaration fields — this module was asymmetric with its
  // sibling until now.
  const contractId = requiredIdentityToken(readEntryField(entry, 'contractId'), 'contractId')
  const version = requiredIdentityToken(readEntryField(entry, 'version'), 'version')
  // P3 FIX (owner HARD HOLD #4610 residual, round 6) — TOCTOU on entry.fields:
  // this used to read `entry.fields` THREE separate times (the isPlainObject
  // check, the Object.keys().length check, and deepCloneFrozenCanonical
  // below) — fine for an ordinary data property, but a GETTER can return a
  // DIFFERENT value on each read. A getter returning `{a:1}` on its first
  // two reads and `{}` on its third passes the non-empty check using the
  // first two reads and then clones the THIRD (empty) read — registering an
  // EMPTY `fields` past the very guard meant to refuse it. Reading the
  // property ONCE into a local closes the window: every check below and the
  // clone all observe the identical value. round 7: that single read now also
  // goes through readEntryField (same reasoning as contractId/version just
  // above — a hostile getter on `fields` itself was STILL a raw-escape route
  // even after the TOCTOU fix, since the single read stayed unguarded).
  const rawFields = readEntryField(entry, 'fields')
  if (!isPlainObject(rawFields)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'fields must be a non-empty plain object', { field: 'fields' })
  }
  // P1 FIX (owner HARD HOLD #4610, round 7 — RAW-OWN-KEYS): `Object.keys(rawFields)`
  // used to run UNGUARDED right after the isPlainObject check above. A Proxy
  // whose TARGET is a plain object (never an array) passes isPlainObject
  // cleanly — `typeof proxy === 'object'` and `Array.isArray(proxy)` both
  // resolve against the proxy's target without invoking a trap — but
  // `Object.keys(proxy)` DOES invoke the proxy's `ownKeys` trap, and a hostile
  // trap can throw during that enumeration itself. Guarding the property
  // *read* (`entry.fields` above) is therefore not enough — the *enumeration*
  // of the read value must be guarded too, separately. Kept strictly AFTER
  // the isPlainObject short-circuit (not folded back into one `||`
  // expression) so `fields: null` / `fields: undefined` / `fields: []` still
  // hit the ORIGINAL "must be a non-empty plain object" reason via
  // short-circuit, never a spurious "could not be enumerated".
  let fieldKeyCount
  try {
    fieldKeyCount = Object.keys(rawFields).length
  } catch {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'fields could not be enumerated', { field: 'fields' })
  }
  if (fieldKeyCount === 0) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'fields must be a non-empty plain object', { field: 'fields' })
  }
  // P2 FIX (owner HARD HOLD #4610): `fields: Object.freeze({ ...entry.fields })`
  // was only a SHALLOW copy + SHALLOW freeze — Object.freeze only locks the
  // top-level property bindings; any object/array VALUE inside `fields`
  // stayed the identical reference the caller passed in. A caller that kept
  // a reference to a nested structure could mutate it after registration and
  // the registered version's content would change — owner measured
  // `nestedFrozen: false`, `registeredVersionChanged: true`, defeating
  // "immutable registration, append-only versions". Fixed using the
  // primitive this line already ratified for exactly this domain (§3.1 ⟲R2):
  // deepCloneFrozenCanonical (gip-canonical-json.cjs) — an OWNED clone in the
  // strict canonical-JSON domain, recursively frozen, so no reference the
  // caller retains can ever reach the registered copy.
  let fields
  try {
    fields = deepCloneFrozenCanonical(rawFields)
  } catch (error) {
    if (error instanceof CanonicalDomainError) {
      fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'fields must stay in the strict canonical JSON domain', { field: 'fields' })
    }
    throw error
  }
  return Object.freeze({ contractId, version, fields })
}

// Builds a registry object (lookup()/size()) from a fixed, first-party
// entries array — the SAME structural shape as
// gip-connector-kind-registry.cjs's createConnectorKindRegistry (P3-b fix,
// review round 2). `entries` MAY be empty (and the shipped default below IS
// empty). Every entry is validated and inserted HERE, at construction, and
// never again: the returned object exposes no verb that could add, edit, or
// replace an entry after this function returns — "append-only" now means a
// caller passes a LONGER entries array to a NEW call of this function (a
// source-level, reviewed change), never a runtime method call against an
// already-built registry. P1-1 FIX (owner HARD HOLD #4610): calling this
// function grants NO trust — see the fix note above trustedContractRegistries.
function createCanonicalObjectContractRegistry(entries) {
  if (!Array.isArray(entries)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'entries must be an array', { field: 'entries' })
  }
  // Two-level Map (contractId -> version -> frozen entry) rather than a
  // single joined string key — no separator character is needed at all, so
  // there is no join-collision surface between (contractId, version) pairs
  // to reason about.
  //
  // P1 FIX (owner HARD HOLD #4610, round 7 — RAW-CANONICAL-ITERATOR): this
  // used to be `for (const raw of entries)` — the array ITERATOR is
  // attacker-reachable exactly like a single element read (a hostile
  // accessor at one index, or a hostile `Symbol.iterator` assigned as an own
  // property of a genuine array — neither breaks `Array.isArray` above), and
  // an unguarded `for...of` lets that raw throw escape this module verbatim.
  // Replaced with the guarded-length + guarded-per-index-read shape
  // (readArrayLength/readArrayElement above) — deliberately a length+index
  // loop, NEVER the iterator protocol, so a hostile Symbol.iterator is
  // structurally unreachable, not merely caught. The loop BODY
  // (normalizeContractEntry + the immutability check below) stays OUTSIDE
  // any try/catch — wrapping the body too would re-label this module's OWN
  // branded errors (e.g. CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE) as if
  // they were foreign reads, collapsing reason discrimination.
  const entriesLength = readArrayLength(entries, 'entries')
  const byContractId = new Map()
  for (let index = 0; index < entriesLength; index += 1) {
    const raw = readArrayElement(entries, index, 'entries')
    const normalized = normalizeContractEntry(raw)
    let versions = byContractId.get(normalized.contractId)
    if (versions && versions.has(normalized.version)) {
      // Immutable: a version is NEVER edited or replaced, even with
      // byte-identical content — re-declaring the same (contractId, version)
      // within one entries array is itself the defect this refuses, not
      // just a duplicate.
      fail('CANONICAL_OBJECT_CONTRACT_VERSION_IMMUTABLE', 'a registered contract version cannot be re-registered or edited', { field: 'version' })
    }
    if (!versions) {
      versions = new Map()
      byContractId.set(normalized.contractId, versions)
    }
    versions.set(normalized.version, normalized)
  }

  function lookup(contractId, version) {
    const normalizedContractId = requiredIdentityToken(contractId, 'contractId')
    const normalizedVersion = requiredIdentityToken(version, 'version')
    const versions = byContractId.get(normalizedContractId)
    if (!versions) return null
    return versions.get(normalizedVersion) || null
  }

  // Frozen object exposes EXACTLY these keys — pinned by the exact-key-set
  // test the same way the qualification prober's residual-1 predicate (and
  // the connector-kind registry's own resolve()/size() pin) are pinned, so a
  // future change cannot quietly add a synthesize/register/auto-register
  // verb under a different name.
  return Object.freeze({
    lookup,
    size() {
      let total = 0
      for (const versions of byContractId.values()) total += versions.size
      return total
    },
  })
}

// MODULE-PRIVATE. Never exported, under any name, anywhere. The ONLY place
// that grants trust — see the P1-1 fix note above trustedContractRegistries.
function buildTrustedCanonicalObjectContractRegistry(entries) {
  const registry = createCanonicalObjectContractRegistry(entries)
  trustedContractRegistries.add(registry)
  return registry
}

// The ONE fail-closed lookup entry point. Never echoes the rejected
// contractId/version into the error.
function resolveCanonicalObjectContractVersion(registry, contractId, version) {
  assertTrustedRegistry(registry)
  const found = registry.lookup(contractId, version)
  if (!found) {
    fail('CANONICAL_OBJECT_CONTRACT_UNREGISTERED', 'canonical object contract version is not registered', {})
  }
  return found
}

// The first-party registry itself — SHIPS EMPTY. Only a future, separately-
// reviewed amendment may extend this literal entries array (owner decision γ
// requires the backfill/reference inventory to come from a
// privately-authorized real run that has not happened — #4609's ⟲OD2
// amendment: an inventory TOOL is not an inventory RESULT). There is no
// runtime register() call that could add to this instance once built. Built
// via buildTrustedCanonicalObjectContractRegistry (module-private, P1-1 fix)
// — this is the ONE trusted registry instance that will ever exist.
const CANONICAL_OBJECT_CONTRACT_REGISTRY = buildTrustedCanonicalObjectContractRegistry([])

// MODULE-PRIVATE. Never exported, under any name, anywhere. The ONLY place
// that grants attestation trust — see the P1-3 fix note above
// trustedInventoryAttestations. Nothing in this shipped module calls this
// today (no real inventory scanner exists yet) — see that note for the full
// account of why that is the honest, correct state, not a gap.
function buildInventoryAttestation({ inventoryStatus, references }) {
  if (inventoryStatus !== 'COMPLETE' && inventoryStatus !== 'NOT_RUN') {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'inventoryStatus must be COMPLETE or NOT_RUN', { field: 'inventoryStatus' })
  }
  if (!Array.isArray(references)) {
    fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'references must be an array', { field: 'references' })
  }
  for (const reference of references) {
    if (!isPlainObject(reference)) {
      fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'each reference must be a plain object', { field: 'references' })
    }
    requiredIdentityToken(reference.contractId, 'contractId')
    requiredIdentityToken(reference.version, 'version')
  }
  const attestation = Object.freeze({
    inventoryStatus,
    references: Object.freeze(references.map((reference) => Object.freeze({ contractId: reference.contractId, version: reference.version }))),
  })
  trustedInventoryAttestations.add(attestation)
  return attestation
}

function assertTrustedInventoryAttestation(inventoryReport) {
  // WeakSet.has(primitive) returns false (never throws) — null/plain objects/
  // strings all fail here too, before any of their fields are ever read.
  if (!trustedInventoryAttestations.has(inventoryReport)) {
    fail('CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED', 'inventoryReport must be server-attested evidence (from buildInventoryAttestation), a caller-supplied object is not evidence', {})
  }
}

// Pure mechanism: given an ALREADY-TRUSTED registry and an ALREADY-VALIDATED
// references array, computes backed/unbacked counts and reports readiness.
// Confers no trust of its own (like computeSystemContentKey in the sibling
// gip-system-identity-read.cjs module) — safe to expose for mechanism
// testing via __internals, unlike buildInventoryAttestation above.
//
// P1 FIX (owner HARD HOLD #4610, round 7 — same class the module header's
// "CLOSED ERROR CONTRACT" paragraph now commits to for the whole EXPORTED
// surface, __internals included): this function IS reachable from outside
// the module (via __internals — this file's own test file already calls it
// directly), so its reads must be guarded exactly like every other entry
// point, not merely "pure mechanism, trust assumed". Three foreign-call
// sites: the `references` array's ITERATION (readArrayLength/readArrayElement
// — the same RAW-*-ITERATOR class as createCanonicalObjectContractRegistry's
// `entries` loop), each reference's `contractId`/`version` PROPERTY READS
// (readEntryField — the same RAW-CONTRACT-ID class as normalizeContractEntry
// above), and `registry.lookup(...)` itself, which is an attacker-suppliable
// FUNCTION if the caller passes a duck-typed registry object (this function
// takes no trust check on `registry` — that is the CALLER's job, per this
// comment's own "ALREADY-TRUSTED" precondition — but "the caller is supposed
// to have checked" does not stop a raw throw from a caller who didn't).
//
// P1 FIX (adversarial residual after #4610 head): the round-7 catch used to
// re-throw unchanged when the caught error was ALREADY a
// GipCanonicalObjectContractError, reasoning that lookup()'s own
// requiredIdentityToken validation legitimately throws that type. That
// reasoning is the SAME brand-exemption class gip-system-identity-read.cjs
// round 3 deleted entirely: GipCanonicalObjectContractError is a PUBLIC
// constructor (exported on module.exports), so a hostile registry.lookup can
// `throw new GipCanonicalObjectContractError(reason, attackerMessage,
// attackerDetails)` — optionally with `.cause` chained — and the exemption
// forwards attacker text VERBATIM (message/details/cause/stack). A TypeError
// from the same lookup was already converted; the branded form was the hole
// the TypeError-only probe missed. Fix: validate contractId/version HERE via
// requiredIdentityToken (module-authored, values-free) BEFORE calling
// lookup, then discard EVERY throw from lookup unconditionally and replace
// it with this module's fixed reason. After pre-validation, a genuine
// createCanonicalObjectContractRegistry lookup cannot throw for token shape
// (its own requiredIdentityToken would accept the same values) — it only
// returns found/null — so the "legitimate branded rethrow" case no longer
// needs to cross this catch at all.
function computeActivationReadiness(registry, references) {
  const referencesLength = readArrayLength(references, 'references')
  let backedCount = 0
  let unbackedCount = 0
  for (let index = 0; index < referencesLength; index += 1) {
    const reference = readArrayElement(references, index, 'references')
    // Pre-validate BEFORE lookup so a malformed token fails with THIS
    // module's own requiredIdentityToken error (field: contractId|version),
    // never by rethrowing whatever registry.lookup chose to throw.
    const contractId = requiredIdentityToken(readEntryField(reference, 'contractId'), 'contractId')
    const version = requiredIdentityToken(readEntryField(reference, 'version'), 'version')
    let found
    try {
      found = registry.lookup(contractId, version)
    } catch {
      // Unconditional discard — no brand exemption. See the P1 fix note above.
      fail('CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID', 'registry.lookup could not be evaluated', { field: 'registry' })
    }
    if (found) backedCount += 1
    else unbackedCount += 1
  }
  if (unbackedCount > 0) {
    fail('CANONICAL_OBJECT_CONTRACT_ACTIVATION_BLOCKED', 'canonical object contract registry has unbacked references; activation refused until backfill completes', {
      unbackedCount,
      backedCount,
      totalReferences: referencesLength,
    })
  }
  return Object.freeze({ ready: true, backedCount, totalReferences: referencesLength })
}

// ---------------------------------------------------------------------------
// Activation gate (owner decision γ: "inventory and backfill existing
// references BEFORE activation"). This module performs NO inventory itself
// and reads no database — it consumes a report and refuses to call the state
// "ready" unless that report is (a) genuinely server-attested evidence — not
// a caller-supplied string, however plausible-looking (P1-3 fix, owner HARD
// HOLD #4610: "a tool is not a result" applies to a caller-asserted STATUS
// STRING exactly as much as to a caller-asserted tool run) — AND (b)
// affirmatively claims a completed inventory with zero unbacked references.
//
// An attestation whose inventoryStatus is NOT_RUN (or a caller object that
// isn't an attestation at all) refuses with a reason — the caller-object
// case with CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED (not evidence),
// the genuinely-attested-but-NOT_RUN case with the pre-existing
// CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT (evidence says nothing has run)
// — two DISTINCT reasons for two DISTINCT failure modes, so neither door can
// quietly cover for the other going missing.
//
// HONESTY NOTE (state this plainly, do not let the frozen vocabulary imply
// more than is true): CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT is
// CURRENTLY UNREACHABLE. Reaching it requires a genuinely-attested object
// whose inventoryStatus is NOT_RUN, and buildInventoryAttestation — the only
// function that can produce a trusted attestation at all — has ZERO call
// sites anywhere in this shipped module (see the LATENT fix note above it),
// so its own validation logic has never executed once, in production or in
// any test. The reason token stays in the frozen vocabulary because the
// SHAPE is correct and load-bearing the moment a future amendment adds a
// real caller — but until then, only CANONICAL_OBJECT_CONTRACT_INVENTORY_UNATTESTED
// is reachable from outside this module.
function assertCanonicalObjectContractRegistryActivationReady(registry, inventoryReport) {
  assertTrustedRegistry(registry)
  assertTrustedInventoryAttestation(inventoryReport)
  if (inventoryReport.inventoryStatus !== 'COMPLETE') {
    fail('CANONICAL_OBJECT_CONTRACT_INVENTORY_ABSENT', 'no completed canonical-object-contract reference inventory has been supplied; activation refused', {})
  }
  return computeActivationReadiness(registry, inventoryReport.references)
}

module.exports = {
  createCanonicalObjectContractRegistry,
  resolveCanonicalObjectContractVersion,
  assertCanonicalObjectContractRegistryActivationReady,
  CANONICAL_OBJECT_CONTRACT_REGISTRY,
  GipCanonicalObjectContractError,
  CANONICAL_OBJECT_CONTRACT_ERROR_REASONS,
  __internals: {
    // `fail` is deliberately ABSENT — see the P1 note above fail() itself and
    // the retracted SCOPE exception (2) in the module header. Pinned by the
    // exact-key-set test, so re-adding it reds.
    requiredIdentityToken,
    hasControlCharacter,
    normalizeContractEntry,
    computeActivationReadiness,
  },
}
