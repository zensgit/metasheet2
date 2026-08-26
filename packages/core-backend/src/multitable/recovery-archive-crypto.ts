/**
 * Time Machine Phase D2h only: recovery-archive crypto substrate.
 *
 * Parent contract: docs/development/multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md
 * (D-D, D-F, D-H2, §2.1). Boundary: docs/development/multitable-timemachine-phase-d2h-crypto-substrate-boundary-20260826.md
 *
 * This module has NO production caller. It does not build, upload, verify, restore, prune, or
 * expire an archive; it does not open a database transaction, name a KMS vendor, touch the
 * network, or read a flag. It provides four things and nothing else:
 *
 *   1. a narrow key-custody adapter interface (produce/unwrap DEK, KMS-attested opaque DEK
 *      fingerprint, manifest/root MAC + verify) with no vendor and no key material in errors;
 *   2. a hardened adapter wrapper that re-checks transaction depth on every verb, validates every
 *      adapter result at runtime, and normalizes any arbitrary throw into a closed values-free
 *      code (D-F: "No KMS call may run inside a database transaction");
 *   3. AEAD seal/open over a narrow byte seam that D2g's canonicalizer can feed later, with an
 *      exact closed AAD binding and fail-closed refusals; and
 *   4. an orchestration helper that reserves every `(dek_fingerprint, nonce)` pair BEFORE any
 *      encryption or upload, so a duplicate reservation leaves zero ciphertext.
 *
 * Every failure is a closed code. No error carries key material, a DEK, a key id, a wrapped id, a
 * fingerprint, a nonce, plaintext, a section or user value, a host, a provider message, or a
 * `cause` chain (D-M).
 */

import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

import {
  RECOVERY_ARCHIVE_FORMAT_VERSION,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  isLowercaseSha256Hex,
  isPositiveDecimalString,
  type RecoveryArchiveSectionName,
} from "./recovery-archive-contract";

/**
 * Crypto contract version. It is distinct from the manifest `format_version` so a later AEAD or
 * MAC construction change is visible even when the manifest format is unchanged.
 */
export const RECOVERY_ARCHIVE_CRYPTO_CONTRACT_VERSION = 1 as const;

/** Exact closed AEAD algorithm set. Anything else refuses; there is no negotiated default. */
export const RECOVERY_ARCHIVE_AEAD_ALGORITHMS = ["aes-256-gcm"] as const;
export type RecoveryArchiveAeadAlgorithm =
  (typeof RECOVERY_ARCHIVE_AEAD_ALGORITHMS)[number];
export const RECOVERY_ARCHIVE_AEAD_ALGORITHM: RecoveryArchiveAeadAlgorithm =
  "aes-256-gcm";

/** Exact lengths for the one admitted algorithm. Node's own length errors are never surfaced. */
export const RECOVERY_ARCHIVE_AEAD_KEY_BYTES = 32 as const;
export const RECOVERY_ARCHIVE_AEAD_NONCE_BYTES = 12 as const;
export const RECOVERY_ARCHIVE_AEAD_TAG_BYTES = 16 as const;

/**
 * Domain separators. They are part of the authenticated binding, so changing one is a crypto
 * contract change (bump RECOVERY_ARCHIVE_CRYPTO_CONTRACT_VERSION), not a rename.
 */
export const RECOVERY_ARCHIVE_AEAD_AAD_DOMAIN =
  "metasheet.recovery-archive.aead.v1" as const;
export const RECOVERY_ARCHIVE_MANIFEST_MAC_DOMAIN =
  "metasheet.recovery-archive.manifest-mac.v1" as const;
export const RECOVERY_ARCHIVE_DEK_FINGERPRINT_DOMAIN =
  "metasheet.recovery-archive.dek-fingerprint.v1" as const;

/**
 * Provisional `dek_fingerprint` wire shape for `format_version = 1`: 64 lowercase hex characters.
 * D-F requires an opaque KMS-attested one-to-one identity of the UNWRAPPED DEK and deliberately
 * leaves the KMS product open (D1 §9.3), so this shape is the format-v1 admission rule, not a
 * ratified custody design. It is never key material.
 */
export const RECOVERY_ARCHIVE_DEK_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** Canonical lowercase-hex spelling of a 12-byte nonce. Uppercase is refused, never normalized. */
export const RECOVERY_ARCHIVE_NONCE_HEX_PATTERN = /^[0-9a-f]{24}$/;

/**
 * Canonical UTC timestamp: exactly one locked precision (milliseconds) and a literal `Z` (D-A).
 * A second-precision, microsecond, offset, or non-`Z` spelling of the same instant is a different
 * byte string, so admitting more than one spelling would make the MAC binding ambiguous.
 */
export const RECOVERY_ARCHIVE_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Closed DEK-source discriminants. An unknown discriminant refuses; it never falls through. */
export const RECOVERY_ARCHIVE_DEK_SOURCE_KINDS = ["produce", "unwrap"] as const;
export type RecoveryArchiveDekSourceKind =
  (typeof RECOVERY_ARCHIVE_DEK_SOURCE_KINDS)[number];

export type RecoveryArchiveCryptoErrorCode =
  | "RECOVERY_ARCHIVE_CRYPTO_UNKNOWN_AEAD_ALGORITHM"
  | "RECOVERY_ARCHIVE_CRYPTO_INVALID_KEY_LENGTH"
  | "RECOVERY_ARCHIVE_CRYPTO_INVALID_NONCE_LENGTH"
  | "RECOVERY_ARCHIVE_CRYPTO_INVALID_NONCE_ENCODING"
  | "RECOVERY_ARCHIVE_CRYPTO_INVALID_AUTH_TAG_LENGTH"
  | "RECOVERY_ARCHIVE_CRYPTO_INVALID_CIPHERTEXT"
  | "RECOVERY_ARCHIVE_CRYPTO_AEAD_OPEN_FAILED"
  | "RECOVERY_ARCHIVE_CRYPTO_INVALID_AAD_BINDING"
  | "RECOVERY_ARCHIVE_CRYPTO_INVALID_MAC_BINDING"
  | "RECOVERY_ARCHIVE_CRYPTO_INVALID_TIMESTAMP"
  | "RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_FINGERPRINT"
  | "RECOVERY_ARCHIVE_CRYPTO_PLAINTEXT_DIGEST_MISMATCH"
  | "RECOVERY_ARCHIVE_CRYPTO_INVALID_SECTION_PLAN"
  | "RECOVERY_ARCHIVE_CRYPTO_INCOMPLETE_SNAPSHOT_PLAN"
  | "RECOVERY_ARCHIVE_CRYPTO_DUPLICATE_SECTION"
  | "RECOVERY_ARCHIVE_CRYPTO_DUPLICATE_NONCE_IN_BATCH"
  | "RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_SOURCE"
  | "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION"
  | "RECOVERY_ARCHIVE_CRYPTO_TRANSACTION_DEPTH_UNKNOWN"
  | "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED"
  | "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID"
  | "RECOVERY_ARCHIVE_CRYPTO_RESERVATION_FAILED"
  | "RECOVERY_ARCHIVE_CRYPTO_SEAL_FAILED"
  | "RECOVERY_ARCHIVE_CRYPTO_PROVIDER_FAILED";

/**
 * Values-free failure surface. `message` is the closed code itself and nothing else: no length,
 * offset, identity, key id, wrapped id, fingerprint, nonce, section name, ciphertext, plaintext,
 * host, provider text, or key material ever reaches a caller or a log through this class.
 *
 * There is deliberately NO `cause`: attaching the original throwable would re-export exactly the
 * provider text and host detail this class exists to strip.
 */
export class RecoveryArchiveCryptoError extends Error {
  readonly code: RecoveryArchiveCryptoErrorCode;

  constructor(code: RecoveryArchiveCryptoErrorCode) {
    super(code);
    this.name = "RecoveryArchiveCryptoError";
    this.code = code;
  }
}

function fail(code: RecoveryArchiveCryptoErrorCode): never {
  throw new RecoveryArchiveCryptoError(code);
}

/**
 * Run an external callback (adapter, reservation sink, sealer, provider) and normalize its
 * failure. A `RecoveryArchiveCryptoError` this module already produced survives unchanged; every
 * other throwable - including a non-Error rejection value - becomes the given closed code with no
 * message, no host, no provider text, and no cause.
 */
async function callExternal<T>(
  code: RecoveryArchiveCryptoErrorCode,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RecoveryArchiveCryptoError) throw error;
    throw new RecoveryArchiveCryptoError(code);
  }
}

function callExternalSync<T>(
  code: RecoveryArchiveCryptoErrorCode,
  run: () => T,
): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof RecoveryArchiveCryptoError) throw error;
    throw new RecoveryArchiveCryptoError(code);
  }
}

/**
 * Zero any value that is an exact-length DEK buffer.
 *
 * Scope is deliberately "exact 32-byte Uint8Array" rather than "the field I happened to name":
 * every path that can hold DEK bytes - success, validation failure, adapter throw, reservation
 * refusal, seal failure - routes through this, so a DEK never survives a build in the heap.
 */
export function scrubRecoveryArchiveDek(value: unknown): void {
  if (!isExactDekBytes(value)) return;
  try {
    // Bypass an overridden instance method. A hostile view must not turn best-effort scrubbing into
    // a second values-bearing failure while another closed refusal is already in flight.
    Uint8Array.prototype.fill.call(value, 0);
  } catch {
    // `isExactDekBytes` admits only genuine Uint8Array views, so this is defensive against exotic
    // runtimes rather than a normal path. Scrubbing must never replace the original closed error.
  }
}

/**
 * Exact archive identity carried by both the AEAD AAD and the manifest MAC preimage.
 *
 * The field set is the union of D1 §2.1 step 2 (tenant/anchor identity, which alone is what makes
 * a cross-binding mixup detectable) and the crypto-bearing section descriptor of §2.1 step 3. All
 * fields are mandatory: an absent field must never encode as an empty field, because that silently
 * produces a different security binding.
 */
export interface RecoveryArchiveCryptoBinding {
  formatVersion: number;
  generationId: string;
  workspaceId: string;
  baseId: string;
  sheetId: string;
  anchorOperationId: string;
  /** Decimal integer STRING. A JS number is refused: seq exceeds 2^53 (D-D). */
  anchorSeq: string;
  checkpointId: string;
  keyId: string;
  wrappedDekId: string;
  dekFingerprint: string;
  aeadAlgorithm: RecoveryArchiveAeadAlgorithm;
}

/** Per-section AAD binding = generation binding + the exact section name and plaintext digest. */
export interface RecoveryArchiveSectionAadBinding
  extends RecoveryArchiveCryptoBinding {
  sectionName: RecoveryArchiveSectionName;
  plaintextSha256: string;
}

/**
 * Manifest/root MAC binding (D1 §2.1 step 4). `createdAt` is a literal required field, not
 * optional commentary.
 *
 * `expiresAt` is `string | null`: a never-expiring generation is a live D1 §9.2 horizon option, so
 * "no expiry" must be a first-class bound value rather than an omitted field. It is encoded with a
 * distinct NULL type tag, so no string - including `''`, `'null'`, or any timestamp - can produce
 * the same MAC preimage bytes as an absent expiry.
 */
export interface RecoveryArchiveManifestMacBinding
  extends RecoveryArchiveCryptoBinding {
  rootHash: string;
  createdAt: string;
  expiresAt: string | null;
  sourceVectorHash: string;
}

/** Unwrapped generation DEK plus the opaque wrapped-blob handle. Never logged, never returned. */
export interface RecoveryArchiveGenerationDek {
  dek: Uint8Array;
  wrappedDekId: string;
  wrappedDek: Uint8Array;
}

/**
 * Narrow key-custody adapter. No concrete vendor is named here and none may be inferred: D1 §9.3
 * leaves the KMS/key-custody product an open owner decision.
 *
 * Every verb is async and MUST be unreachable from inside a database transaction. Callers do not
 * get that property by convention - they get it from `createTransactionGuardedKeyCustody`, which
 * every orchestration helper in this module applies internally.
 */
export interface RecoveryArchiveKeyCustodyAdapter {
  /** Mint a fresh generation DEK under `keyId` and return it wrapped. */
  produceGenerationDek(request: {
    keyId: string;
    generationId: string;
  }): Promise<RecoveryArchiveGenerationDek>;

  /** Unwrap a previously wrapped generation DEK. The returned wrapped id must be the requested one. */
  unwrapGenerationDek(request: {
    keyId: string;
    generationId: string;
    wrappedDekId: string;
    wrappedDek: Uint8Array;
  }): Promise<RecoveryArchiveGenerationDek>;

  /**
   * Domain-separated, KMS-attested, one-to-one opaque identity of the ACTUAL UNWRAPPED DEK.
   *
   * D-F: hashing only the wrapped ciphertext is NOT sufficient, because randomized re-wrapping
   * would hide reuse of the same DEK and defeat the nonce-uniqueness registry.
   */
  deriveDekFingerprint(request: {
    keyId: string;
    dek: Uint8Array;
  }): Promise<string>;

  /** MAC/sign the canonical manifest/root preimage with a key the object store does not hold. */
  macManifestRoot(request: {
    keyId: string;
    preimage: Uint8Array;
  }): Promise<Uint8Array>;

  /** Verify a manifest/root MAC. Returns false on mismatch; it does not throw a values-bearing error. */
  verifyManifestRootMac(request: {
    keyId: string;
    preimage: Uint8Array;
    mac: Uint8Array;
  }): Promise<boolean>;
}

/**
 * Database transaction-depth probe. Depth 0 means "no database transaction is open on the
 * connection this build is using". Anything else, or an unreadable depth, refuses.
 */
export interface RecoveryArchiveTransactionDepthProbe {
  currentTransactionDepth(): number;
}

/**
 * Fail-closed depth assertion. An unreadable depth (throw, non-integer, negative) is refused as
 * hard as a nonzero depth: "I could not tell" is never permission to call KMS under a lock.
 */
export function assertKeyCustodyCallOutsideTransaction(
  probe: RecoveryArchiveTransactionDepthProbe,
): void {
  let depth: unknown;
  try {
    depth = probe.currentTransactionDepth();
  } catch {
    fail("RECOVERY_ARCHIVE_CRYPTO_TRANSACTION_DEPTH_UNKNOWN");
  }
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0) {
    fail("RECOVERY_ARCHIVE_CRYPTO_TRANSACTION_DEPTH_UNKNOWN");
  }
  if (depth > 0) {
    fail("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION");
  }
}

/** Exact-length DEK bytes. `Buffer` satisfies this; a string, array, or wrong length does not. */
function isExactDekBytes(value: unknown): value is Uint8Array {
  try {
    return (
      value instanceof Uint8Array &&
      ArrayBuffer.isView(value) &&
      value.byteLength === RECOVERY_ARCHIVE_AEAD_KEY_BYTES
    );
  } catch {
    return false;
  }
}

function isNonEmptyBytes(value: unknown): value is Uint8Array {
  try {
    return (
      value instanceof Uint8Array &&
      ArrayBuffer.isView(value) &&
      value.byteLength > 0
    );
  } catch {
    return false;
  }
}

/**
 * Validate a DEK result from an untrusted adapter, scrubbing whatever key bytes it did return
 * before refusing. A partially valid result is still a refusal: there is no repair path.
 */
function assertGenerationDekResult(
  result: unknown,
  expectedWrappedDekId: string | null,
): RecoveryArchiveGenerationDek {
  let dek: unknown;
  try {
    if (result === null || typeof result !== "object") {
      fail("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID");
    }

    // The adapter is an external boundary. Read each own DATA property exactly once and return a
    // plain snapshot. Accessors are rejected without invocation; a Proxy reflection failure is
    // normalized below. Reading `dek` first lets every later validation failure scrub key bytes.
    const dekDescriptor = Object.getOwnPropertyDescriptor(result, "dek");
    if (!dekDescriptor || !("value" in dekDescriptor)) {
      fail("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID");
    }
    dek = dekDescriptor.value;

    const wrappedDekIdDescriptor = Object.getOwnPropertyDescriptor(
      result,
      "wrappedDekId",
    );
    const wrappedDekDescriptor = Object.getOwnPropertyDescriptor(
      result,
      "wrappedDek",
    );
    if (
      !wrappedDekIdDescriptor ||
      !("value" in wrappedDekIdDescriptor) ||
      !wrappedDekDescriptor ||
      !("value" in wrappedDekDescriptor)
    ) {
      fail("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID");
    }

    const wrappedDekId = wrappedDekIdDescriptor.value;
    const wrappedDek = wrappedDekDescriptor.value;
    if (
      !isExactDekBytes(dek) ||
      !isBoundIdentity(wrappedDekId) ||
      !isNonEmptyBytes(wrappedDek) ||
      (expectedWrappedDekId !== null && wrappedDekId !== expectedWrappedDekId)
    ) {
      fail("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID");
    }

    return { dek, wrappedDekId, wrappedDek };
  } catch (error) {
    scrubRecoveryArchiveDek(dek);
    if (error instanceof RecoveryArchiveCryptoError) throw error;
    fail("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID");
  }
}

/**
 * Harden a key-custody adapter. Every verb, on every call:
 *
 *   1. re-checks transaction depth (per call, never once at entry);
 *   2. normalizes any arbitrary adapter throw into a closed values-free code; and
 *   3. validates the adapter's RESULT at runtime, because a wrong-length DEK, a blank wrapped id,
 *      an empty wrapped blob, or a mismatched unwrap id are all silent corruption otherwise.
 *
 * The orchestration helper applies this internally and never holds the raw adapter, so a caller
 * cannot opt out by passing an unwrapped one.
 */
export function createTransactionGuardedKeyCustody(
  adapter: RecoveryArchiveKeyCustodyAdapter,
  probe: RecoveryArchiveTransactionDepthProbe,
): RecoveryArchiveKeyCustodyAdapter {
  return {
    async produceGenerationDek(request) {
      assertKeyCustodyCallOutsideTransaction(probe);
      const result = await callExternal(
        "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED",
        () => adapter.produceGenerationDek(request),
      );
      return assertGenerationDekResult(result, null);
    },
    async unwrapGenerationDek(request) {
      assertKeyCustodyCallOutsideTransaction(probe);
      const expectedWrappedDekId = callExternalSync(
        "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID",
        () => request.wrappedDekId,
      );
      const result = await callExternal(
        "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED",
        () => adapter.unwrapGenerationDek(request),
      );
      return assertGenerationDekResult(result, expectedWrappedDekId);
    },
    async deriveDekFingerprint(request) {
      assertKeyCustodyCallOutsideTransaction(probe);
      const fingerprint = await callExternal(
        "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED",
        () => adapter.deriveDekFingerprint(request),
      );
      if (!isRecoveryArchiveDekFingerprint(fingerprint)) {
        fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_FINGERPRINT");
      }
      return fingerprint;
    },
    async macManifestRoot(request) {
      assertKeyCustodyCallOutsideTransaction(probe);
      const mac = await callExternal(
        "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED",
        () => adapter.macManifestRoot(request),
      );
      if (!isNonEmptyBytes(mac)) {
        fail("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID");
      }
      return mac;
    },
    async verifyManifestRootMac(request) {
      assertKeyCustodyCallOutsideTransaction(probe);
      const verdict = await callExternal(
        "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED",
        () => adapter.verifyManifestRootMac(request),
      );
      // A non-boolean verdict is refused rather than coerced: `'false'` and `0` are both truthy or
      // falsy by accident, and either coercion silently decides an authenticity question.
      if (typeof verdict !== "boolean")
        fail("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID");
      return verdict;
    },
  };
}

/**
 * Exact ordered AAD field list. Order is part of the binding; reordering is a contract change.
 * Kept as data so a test can assert the encoded field count mechanically instead of by eye.
 */
export const RECOVERY_ARCHIVE_AAD_FIELD_ORDER = [
  "format_version",
  "archive_generation_id",
  "workspace_id",
  "base_id",
  "sheet_id",
  "anchor_operation_id",
  "anchor_seq",
  "checkpoint_id",
  "section_name",
  "aead_algorithm",
  "key_id",
  "wrapped_dek_id",
  "dek_fingerprint",
  "plaintext_sha256",
] as const;

/** Exact ordered manifest/root MAC preimage field list (D1 §2.1 step 4). */
export const RECOVERY_ARCHIVE_MANIFEST_MAC_FIELD_ORDER = [
  "root_hash",
  "format_version",
  "archive_generation_id",
  "workspace_id",
  "base_id",
  "sheet_id",
  "anchor_operation_id",
  "anchor_seq",
  "checkpoint_id",
  "created_at",
  "expires_at",
  "source_vector_hash",
  "aead_algorithm",
  "key_id",
  "wrapped_dek_id",
  "dek_fingerprint",
] as const;

/** Field type tags. A NULL field is not "the empty string": the tag byte itself differs. */
export const RECOVERY_ARCHIVE_FIELD_TAG_NULL = 0x00;
export const RECOVERY_ARCHIVE_FIELD_TAG_STRING = 0x01;

type RecoveryArchiveBindingField = string | null;

/**
 * Length-prefixed, type-tagged canonical byte encoding.
 *
 * Deliberately NOT JSON: D2g owns manifest canonicalization (RFC 8785 JCS) and this module must
 * not fork a second canonicalizer. Each field is `tag(1) || length(4, big-endian) || bytes`, so
 * the encoding is unambiguous without a delimiter a value could contain, and a NULL field is
 * unreachable by ANY string because the tag byte separates the two domains.
 */
function encodeBindingFields(
  domain: string,
  fields: readonly RecoveryArchiveBindingField[],
): Buffer {
  const parts: Buffer[] = [
    encodeField(domain),
    encodeField(String(RECOVERY_ARCHIVE_CRYPTO_CONTRACT_VERSION)),
    uint32(fields.length),
  ];
  for (const field of fields) parts.push(encodeField(field));
  return Buffer.concat(parts);
}

function encodeField(field: RecoveryArchiveBindingField): Buffer {
  if (field === null) {
    return Buffer.concat([
      Buffer.from([RECOVERY_ARCHIVE_FIELD_TAG_NULL]),
      uint32(0),
    ]);
  }
  const bytes = Buffer.from(field, "utf8");
  return Buffer.concat([
    Buffer.from([RECOVERY_ARCHIVE_FIELD_TAG_STRING]),
    uint32(bytes.length),
    bytes,
  ]);
}

function uint32(value: number): Buffer {
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(value, 0);
  return prefix;
}

/** Non-empty identity token: a blank or whitespace-only id is refused, never encoded as empty. */
function isBoundIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Canonical UTC timestamp with exactly millisecond precision. The regex fixes the spelling and the
 * round trip through `Date` rejects an impossible instant (month 13, day 32, hour 24) that matches
 * the shape.
 */
export function isRecoveryArchiveUtcTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !RECOVERY_ARCHIVE_UTC_TIMESTAMP_PATTERN.test(value)
  )
    return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function assertRecoveryArchiveUtcTimestamp(
  value: unknown,
): asserts value is string {
  if (!isRecoveryArchiveUtcTimestamp(value))
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_TIMESTAMP");
}

function isRecoveryArchiveAeadAlgorithm(
  value: unknown,
): value is RecoveryArchiveAeadAlgorithm {
  return (
    typeof value === "string" &&
    (RECOVERY_ARCHIVE_AEAD_ALGORITHMS as readonly string[]).includes(value)
  );
}

function isRecoveryArchiveSectionName(
  value: unknown,
): value is RecoveryArchiveSectionName {
  return (
    typeof value === "string" &&
    (RECOVERY_ARCHIVE_V1_SECTION_NAMES as readonly string[]).includes(value)
  );
}

/** Opaque KMS-attested DEK identity, format-v1 shape. Never key material. */
export function isRecoveryArchiveDekFingerprint(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    RECOVERY_ARCHIVE_DEK_FINGERPRINT_PATTERN.test(value)
  );
}

export function assertRecoveryArchiveDekFingerprint(
  value: unknown,
): asserts value is string {
  if (!isRecoveryArchiveDekFingerprint(value)) {
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_FINGERPRINT");
  }
}

/**
 * Canonical lowercase-hex spelling of an exact-length nonce.
 *
 * A non-canonical spelling is REFUSED rather than normalized: if two spellings of one nonce could
 * both be admitted, the durable `(dek_fingerprint, nonce)` registry would store them as two rows
 * and a real reuse would go undetected.
 */
export function toRecoveryArchiveNonceHex(nonce: Uint8Array): string {
  if (
    !(nonce instanceof Uint8Array) ||
    nonce.byteLength !== RECOVERY_ARCHIVE_AEAD_NONCE_BYTES
  ) {
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_NONCE_LENGTH");
  }
  return Buffer.from(nonce).toString("hex");
}

export function assertRecoveryArchiveNonceHex(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !RECOVERY_ARCHIVE_NONCE_HEX_PATTERN.test(value)
  ) {
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_NONCE_ENCODING");
  }
}

function assertCryptoBinding(
  binding: RecoveryArchiveCryptoBinding,
  code: RecoveryArchiveCryptoErrorCode,
): void {
  if (
    binding === null ||
    typeof binding !== "object" ||
    binding.formatVersion !== RECOVERY_ARCHIVE_FORMAT_VERSION ||
    !isBoundIdentity(binding.generationId) ||
    !isBoundIdentity(binding.workspaceId) ||
    !isBoundIdentity(binding.baseId) ||
    !isBoundIdentity(binding.sheetId) ||
    !isBoundIdentity(binding.anchorOperationId) ||
    !isPositiveDecimalString(binding.anchorSeq) ||
    !isBoundIdentity(binding.checkpointId) ||
    !isBoundIdentity(binding.keyId) ||
    !isBoundIdentity(binding.wrappedDekId) ||
    !isRecoveryArchiveDekFingerprint(binding.dekFingerprint) ||
    !isRecoveryArchiveAeadAlgorithm(binding.aeadAlgorithm)
  ) {
    fail(code);
  }
}

/**
 * Build the exact AEAD associated data for one section object.
 *
 * Binding it to `plaintext_sha256` means a manifest whose section hash was rewritten can no longer
 * open its own ciphertext: the tampered-manifest refusal of §2.1 then surfaces as an AEAD tag
 * failure rather than a hash comparison. A D2 verifier must not depend on telling those apart.
 */
export function buildRecoveryArchiveSectionAad(
  binding: RecoveryArchiveSectionAadBinding,
): Buffer {
  assertCryptoBinding(binding, "RECOVERY_ARCHIVE_CRYPTO_INVALID_AAD_BINDING");
  if (
    !isRecoveryArchiveSectionName(binding.sectionName) ||
    !isLowercaseSha256Hex(binding.plaintextSha256)
  ) {
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_AAD_BINDING");
  }

  return encodeBindingFields(RECOVERY_ARCHIVE_AEAD_AAD_DOMAIN, [
    String(binding.formatVersion),
    binding.generationId,
    binding.workspaceId,
    binding.baseId,
    binding.sheetId,
    binding.anchorOperationId,
    binding.anchorSeq,
    binding.checkpointId,
    binding.sectionName,
    binding.aeadAlgorithm,
    binding.keyId,
    binding.wrappedDekId,
    binding.dekFingerprint,
    binding.plaintextSha256,
  ]);
}

/**
 * Build the manifest/root MAC preimage: domain separator + stored `root_hash` + the same binding
 * metadata as the canonical body, including the literal `created_at` field (D1 §2.1 step 4).
 *
 * The canonical manifest BODY and its `root_hash` are produced by the D2g canonicalizer. This
 * function takes the already-computed `root_hash` as a narrow input; it never serializes a
 * manifest and never re-derives a hash.
 */
export function buildRecoveryArchiveManifestMacPreimage(
  binding: RecoveryArchiveManifestMacBinding,
): Buffer {
  assertCryptoBinding(binding, "RECOVERY_ARCHIVE_CRYPTO_INVALID_MAC_BINDING");
  if (
    !isLowercaseSha256Hex(binding.rootHash) ||
    !isLowercaseSha256Hex(binding.sourceVectorHash)
  ) {
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_MAC_BINDING");
  }
  // `createdAt` is required; `expiresAt` is required-or-explicitly-null. `undefined` is neither,
  // so a forgotten field can never be read as "never expires".
  assertRecoveryArchiveUtcTimestamp(binding.createdAt);
  if (binding.expiresAt !== null)
    assertRecoveryArchiveUtcTimestamp(binding.expiresAt);
  if (!("expiresAt" in binding))
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_MAC_BINDING");

  return encodeBindingFields(RECOVERY_ARCHIVE_MANIFEST_MAC_DOMAIN, [
    binding.rootHash,
    String(binding.formatVersion),
    binding.generationId,
    binding.workspaceId,
    binding.baseId,
    binding.sheetId,
    binding.anchorOperationId,
    binding.anchorSeq,
    binding.checkpointId,
    binding.createdAt,
    binding.expiresAt,
    binding.sourceVectorHash,
    binding.aeadAlgorithm,
    binding.keyId,
    binding.wrappedDekId,
    binding.dekFingerprint,
  ]);
}

/**
 * Narrow byte seam for D2g. `plaintext` is whatever canonical bytes the D2g canonicalizer emits
 * for this section; this module hashes and seals them and never parses or re-serializes them.
 */
export interface RecoveryArchiveSectionSealInput {
  binding: RecoveryArchiveSectionAadBinding;
  dek: Uint8Array;
  nonce: Uint8Array;
  plaintext: Uint8Array;
}

export interface RecoveryArchiveSealedSection {
  sectionName: RecoveryArchiveSectionName;
  aeadAlgorithm: RecoveryArchiveAeadAlgorithm;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  plaintextSha256: string;
}

/** Lowercase-hex SHA-256 of the exact bytes handed in. */
export function recoveryArchivePlaintextSha256(plaintext: Uint8Array): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function assertAeadMaterial(input: {
  algorithm: unknown;
  dek: Uint8Array;
  nonce: Uint8Array;
}): void {
  if (!isRecoveryArchiveAeadAlgorithm(input.algorithm)) {
    fail("RECOVERY_ARCHIVE_CRYPTO_UNKNOWN_AEAD_ALGORITHM");
  }
  if (!isExactDekBytes(input.dek))
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_KEY_LENGTH");
  if (
    !(input.nonce instanceof Uint8Array) ||
    input.nonce.byteLength !== RECOVERY_ARCHIVE_AEAD_NONCE_BYTES
  ) {
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_NONCE_LENGTH");
  }
}

/**
 * AEAD-seal one section object.
 *
 * Lengths are validated against this module's exact constants BEFORE node crypto is touched, so a
 * caller never receives Node's own error text (which is not a closed code and can carry a length).
 * `setAAD` precedes `update` on both seal and open.
 */
export function sealRecoveryArchiveSection(
  input: RecoveryArchiveSectionSealInput,
): RecoveryArchiveSealedSection {
  // Algorithm and key/nonce shape are checked BEFORE the AAD is built, so an unknown algorithm
  // surfaces as its own code instead of being folded into a generic binding refusal.
  assertAeadMaterial({
    algorithm: input.binding.aeadAlgorithm,
    dek: input.dek,
    nonce: input.nonce,
  });
  const aad = buildRecoveryArchiveSectionAad(input.binding);

  // The digest is inside the AAD, so a caller-supplied digest that does not describe these exact
  // bytes would mint an object that can never be opened against its own manifest descriptor.
  if (
    recoveryArchivePlaintextSha256(input.plaintext) !==
    input.binding.plaintextSha256
  ) {
    fail("RECOVERY_ARCHIVE_CRYPTO_PLAINTEXT_DIGEST_MISMATCH");
  }

  const cipher = createCipheriv(
    input.binding.aeadAlgorithm,
    Buffer.from(input.dek.buffer, input.dek.byteOffset, input.dek.byteLength),
    Buffer.from(
      input.nonce.buffer,
      input.nonce.byteOffset,
      input.nonce.byteLength,
    ),
    { authTagLength: RECOVERY_ARCHIVE_AEAD_TAG_BYTES },
  );
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(input.plaintext)),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    sectionName: input.binding.sectionName,
    aeadAlgorithm: input.binding.aeadAlgorithm,
    nonce: Buffer.from(input.nonce),
    ciphertext,
    authTag,
    plaintextSha256: input.binding.plaintextSha256,
  };
}

export interface RecoveryArchiveSectionOpenInput {
  binding: RecoveryArchiveSectionAadBinding;
  dek: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}

/**
 * AEAD-open one section object. Auth-tag failure, a wrong key, a wrong or tampered AAD, tampered
 * ciphertext, a malformed length, and an unknown algorithm all refuse with a closed code and no
 * recovered bytes. Verify order is D1 §2.1: open first, hash only what opened.
 */
export function openRecoveryArchiveSection(
  input: RecoveryArchiveSectionOpenInput,
): Buffer {
  assertAeadMaterial({
    algorithm: input.binding.aeadAlgorithm,
    dek: input.dek,
    nonce: input.nonce,
  });
  const aad = buildRecoveryArchiveSectionAad(input.binding);
  if (
    !(input.authTag instanceof Uint8Array) ||
    input.authTag.byteLength !== RECOVERY_ARCHIVE_AEAD_TAG_BYTES
  ) {
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_AUTH_TAG_LENGTH");
  }
  if (!(input.ciphertext instanceof Uint8Array)) {
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_CIPHERTEXT");
  }

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(
      input.binding.aeadAlgorithm,
      Buffer.from(input.dek.buffer, input.dek.byteOffset, input.dek.byteLength),
      Buffer.from(
        input.nonce.buffer,
        input.nonce.byteOffset,
        input.nonce.byteLength,
      ),
      { authTagLength: RECOVERY_ARCHIVE_AEAD_TAG_BYTES },
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(input.authTag));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext)),
      decipher.final(),
    ]);
  } catch {
    // Node's own message is deliberately discarded: it is not a closed code.
    fail("RECOVERY_ARCHIVE_CRYPTO_AEAD_OPEN_FAILED");
  }

  if (
    recoveryArchivePlaintextSha256(plaintext) !== input.binding.plaintextSha256
  ) {
    // Unreachable while the digest is inside the AAD; kept so removing it from the AAD cannot
    // silently drop the plaintext-hash check as well.
    fail("RECOVERY_ARCHIVE_CRYPTO_PLAINTEXT_DIGEST_MISMATCH");
  }
  return plaintext;
}

/** One durable `(dek_fingerprint, nonce)` reservation, bound to its generation and section. */
export interface RecoveryArchiveNonceReservation {
  dekFingerprint: string;
  nonceHex: string;
  generationId: string;
  sectionName: RecoveryArchiveSectionName;
  aeadAlgorithm: RecoveryArchiveAeadAlgorithm;
  formatVersion: number;
}

/**
 * Durable reservation seam. The implementation belongs to the D2 archive runtime, which is not
 * built here; this module only guarantees WHEN it is called. It must insert every pair atomically
 * and reject the whole batch if any pair already exists under the same DEK fingerprint, or if the
 * generation already reserved that section.
 */
export type RecoveryArchiveNonceReservationSink = (
  reservations: readonly RecoveryArchiveNonceReservation[],
) => Promise<void>;

/** Per-section plan. `plaintext` is the D2g canonical byte seam; `nonce` is caller-generated. */
export interface RecoveryArchiveSectionPlan {
  sectionName: RecoveryArchiveSectionName;
  plaintext: Uint8Array;
  nonce: Uint8Array;
}

export type RecoveryArchiveDekSource =
  | { kind: "produce" }
  | { kind: "unwrap"; wrappedDekId: string; wrappedDek: Uint8Array };

/**
 * A complete `archive_snapshot` format-v1 section plan: exactly the ten contract sections, in the
 * exact D-D order, each with its own nonce.
 *
 * D-D: "Zero-row sections are present with `row_count='0'`; omission, duplication, an unknown
 * section, or a different order refuses." A partial plan is therefore not a smaller archive, it is
 * an archive that cannot be a full-sheet recovery point, so this helper refuses it outright rather
 * than sealing a snapshot that only looks complete.
 */
export function assertRecoveryArchiveV1SnapshotPlan(
  sections: readonly RecoveryArchiveSectionPlan[],
): void {
  if (!Array.isArray(sections))
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_SECTION_PLAN");
  if (sections.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length) {
    fail("RECOVERY_ARCHIVE_CRYPTO_INCOMPLETE_SNAPSHOT_PLAN");
  }
  for (
    let index = 0;
    index < RECOVERY_ARCHIVE_V1_SECTION_NAMES.length;
    index += 1
  ) {
    if (
      sections[index]?.sectionName !== RECOVERY_ARCHIVE_V1_SECTION_NAMES[index]
    ) {
      fail("RECOVERY_ARCHIVE_CRYPTO_INCOMPLETE_SNAPSHOT_PLAN");
    }
  }
}

function assertDekSource(source: unknown): RecoveryArchiveDekSource {
  if (source === null || typeof source !== "object") {
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_SOURCE");
  }
  const kind = (source as { kind?: unknown }).kind;
  if (
    typeof kind !== "string" ||
    !(RECOVERY_ARCHIVE_DEK_SOURCE_KINDS as readonly string[]).includes(kind)
  ) {
    // An unknown discriminant refuses. It must never fall through to the unwrap branch, which is
    // what an `x === 'produce' ? … : …` ternary would silently do.
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_SOURCE");
  }
  if (kind === "unwrap") {
    const unwrap = source as { wrappedDekId?: unknown; wrappedDek?: unknown };
    if (
      !isBoundIdentity(unwrap.wrappedDekId) ||
      !(unwrap.wrappedDek instanceof Uint8Array) ||
      unwrap.wrappedDek.byteLength === 0
    ) {
      fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_SOURCE");
    }
  }
  return source as RecoveryArchiveDekSource;
}

export interface RecoveryArchiveReserveThenSealInput {
  /** Generation binding WITHOUT key material identity: the fingerprint is derived, not supplied. */
  binding: Omit<
    RecoveryArchiveCryptoBinding,
    "dekFingerprint" | "wrappedDekId"
  >;
  /** The RAW adapter. This helper wraps it internally and never calls it unwrapped. */
  keyCustody: RecoveryArchiveKeyCustodyAdapter;
  transactionDepth: RecoveryArchiveTransactionDepthProbe;
  dekSource: RecoveryArchiveDekSource;
  /** Exactly the ten format-v1 sections, in the exact contract order, one nonce each. */
  sections: readonly RecoveryArchiveSectionPlan[];
  reserveNonces: RecoveryArchiveNonceReservationSink;
  /** Test seam. Defaults to this module's AEAD sealer; a spy proves zero calls on refusal. */
  sealSection?: (
    input: RecoveryArchiveSectionSealInput,
  ) => RecoveryArchiveSealedSection;
  /**
   * Object-store upload seam. D2h implements NO object store: this is a caller-supplied callback
   * only, so a spy can prove upload is never reached before a successful reservation.
   */
  uploadSealedSection?: (sealed: RecoveryArchiveSealedSection) => Promise<void>;
}

export interface RecoveryArchiveReserveThenSealResult {
  dekFingerprint: string;
  wrappedDekId: string;
  reservations: readonly RecoveryArchiveNonceReservation[];
  sealedSections: readonly RecoveryArchiveSealedSection[];
}

/**
 * D-H2 object-capture / crypto-reservation ordering, as a testable helper.
 *
 * Exact order, and the whole point of the helper: obtain the DEK and its KMS-attested fingerprint
 * OUTSIDE every database transaction, then durably reserve EVERY `(dek_fingerprint, nonce)` pair,
 * and only after that reservation commits may any byte be encrypted or uploaded. A duplicate or
 * failed reservation abandons the build with zero ciphertext and zero upload.
 *
 * Transaction depth is re-checked at entry, after the reservation returns and before the first
 * encryption, and before every provider callback - not only inside the KMS wrapper - because the
 * reservation sink is itself the thing most likely to have left a transaction open.
 *
 * This is not the archive runtime caller: it opens no transaction, writes no catalog row, reads
 * no flag, and stores nothing.
 */
export async function reserveThenSealRecoveryArchiveSections(
  input: RecoveryArchiveReserveThenSealInput,
): Promise<RecoveryArchiveReserveThenSealResult> {
  const sections = input.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_SECTION_PLAN");
  }

  const seenSections = new Set<string>();
  const seenNonces = new Set<string>();
  const plans: Array<{
    sectionName: RecoveryArchiveSectionName;
    plaintext: Uint8Array;
    nonce: Uint8Array;
    nonceHex: string;
    plaintextSha256: string;
  }> = [];

  for (const section of sections) {
    if (
      section === null ||
      typeof section !== "object" ||
      !isRecoveryArchiveSectionName(section.sectionName) ||
      !(section.plaintext instanceof Uint8Array) ||
      !(section.nonce instanceof Uint8Array)
    ) {
      fail("RECOVERY_ARCHIVE_CRYPTO_INVALID_SECTION_PLAN");
    }
    if (seenSections.has(section.sectionName))
      fail("RECOVERY_ARCHIVE_CRYPTO_DUPLICATE_SECTION");
    seenSections.add(section.sectionName);

    // toRecoveryArchiveNonceHex refuses a wrong-length nonce before it can reach the registry.
    const nonceHex = toRecoveryArchiveNonceHex(section.nonce);
    if (seenNonces.has(nonceHex)) {
      // One DEK is used for the whole generation, so an in-batch repeat is same-DEK nonce reuse.
      fail("RECOVERY_ARCHIVE_CRYPTO_DUPLICATE_NONCE_IN_BATCH");
    }
    seenNonces.add(nonceHex);

    plans.push({
      sectionName: section.sectionName,
      plaintext: section.plaintext,
      nonce: section.nonce,
      nonceHex,
      plaintextSha256: recoveryArchivePlaintextSha256(section.plaintext),
    });
  }

  // A format-v1 archive_snapshot is all ten sections in order, one nonce each - never a subset.
  assertRecoveryArchiveV1SnapshotPlan(plans);
  const dekSource = assertDekSource(input.dekSource);

  // Entry check: refuse before a single KMS verb if a transaction is already open.
  assertKeyCustodyCallOutsideTransaction(input.transactionDepth);

  const custody = createTransactionGuardedKeyCustody(
    input.keyCustody,
    input.transactionDepth,
  );
  const sealSection = input.sealSection ?? sealRecoveryArchiveSection;

  let generationDek: RecoveryArchiveGenerationDek | null = null;
  try {
    generationDek =
      dekSource.kind === "produce"
        ? await custody.produceGenerationDek({
            keyId: input.binding.keyId,
            generationId: input.binding.generationId,
          })
        : await custody.unwrapGenerationDek({
            keyId: input.binding.keyId,
            generationId: input.binding.generationId,
            wrappedDekId: dekSource.wrappedDekId,
            wrappedDek: dekSource.wrappedDek,
          });

    const dekFingerprint = await custody.deriveDekFingerprint({
      keyId: input.binding.keyId,
      dek: generationDek.dek,
    });

    const reservations: RecoveryArchiveNonceReservation[] = plans.map(
      (plan) => ({
        dekFingerprint,
        nonceHex: plan.nonceHex,
        generationId: input.binding.generationId,
        sectionName: plan.sectionName,
        aeadAlgorithm: input.binding.aeadAlgorithm,
        formatVersion: input.binding.formatVersion,
      }),
    );

    // THE ORDERING GUARANTEE. Nothing below this line may move above it: reservation is durable
    // before the first byte is encrypted, so a refusal leaves no ciphertext to reuse a nonce with.
    await callExternal("RECOVERY_ARCHIVE_CRYPTO_RESERVATION_FAILED", () =>
      input.reserveNonces(reservations),
    );

    // Post-reservation, pre-encryption check: the reservation sink is a database caller and is the
    // most likely place for a transaction to have been left open.
    assertKeyCustodyCallOutsideTransaction(input.transactionDepth);

    const sealedSections: RecoveryArchiveSealedSection[] = [];
    for (const plan of plans) {
      sealedSections.push(
        callExternalSync("RECOVERY_ARCHIVE_CRYPTO_SEAL_FAILED", () =>
          sealSection({
            binding: {
              ...input.binding,
              dekFingerprint,
              wrappedDekId: (generationDek as RecoveryArchiveGenerationDek)
                .wrappedDekId,
              sectionName: plan.sectionName,
              plaintextSha256: plan.plaintextSha256,
            },
            dek: (generationDek as RecoveryArchiveGenerationDek).dek,
            nonce: plan.nonce,
            plaintext: plan.plaintext,
          }),
        ),
      );
    }

    if (input.uploadSealedSection) {
      for (const sealed of sealedSections) {
        // Provider callbacks are network I/O: D-F forbids them under a database transaction just
        // as firmly as it forbids KMS calls there.
        assertKeyCustodyCallOutsideTransaction(input.transactionDepth);
        await callExternal("RECOVERY_ARCHIVE_CRYPTO_PROVIDER_FAILED", () =>
          (
            input.uploadSealedSection as (
              s: RecoveryArchiveSealedSection,
            ) => Promise<void>
          )(sealed),
        );
      }
    }

    return {
      dekFingerprint,
      wrappedDekId: generationDek.wrappedDekId,
      reservations,
      sealedSections,
    };
  } finally {
    // Every exit - success, refusal, adapter throw, reservation refusal, seal or provider failure.
    scrubRecoveryArchiveDek(generationDek?.dek);
  }
}
