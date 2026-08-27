import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  RECOVERY_ARCHIVE_AAD_FIELD_ORDER,
  RECOVERY_ARCHIVE_AEAD_ALGORITHM,
  RECOVERY_ARCHIVE_AEAD_KEY_BYTES,
  RECOVERY_ARCHIVE_AEAD_NONCE_BYTES,
  RECOVERY_ARCHIVE_AEAD_TAG_BYTES,
  RECOVERY_ARCHIVE_CRYPTO_CONTRACT_VERSION,
  RECOVERY_ARCHIVE_DEK_FINGERPRINT_DOMAIN,
  RECOVERY_ARCHIVE_DEK_SOURCE_KINDS,
  RECOVERY_ARCHIVE_FIELD_TAG_NULL,
  RECOVERY_ARCHIVE_FIELD_TAG_STRING,
  RECOVERY_ARCHIVE_MANIFEST_MAC_FIELD_ORDER,
  RecoveryArchiveCryptoError,
  assertKeyCustodyCallOutsideTransaction,
  assertRecoveryArchiveV1SnapshotPlan,
  buildRecoveryArchiveManifestMacPreimage,
  buildRecoveryArchiveSectionAad,
  createTransactionGuardedKeyCustody,
  isRecoveryArchiveUtcTimestamp,
  openRecoveryArchiveSection,
  recoveryArchivePlaintextSha256,
  reserveThenSealRecoveryArchiveSections,
  scrubRecoveryArchiveDek,
  sealRecoveryArchiveSection,
  toRecoveryArchiveNonceHex,
  type RecoveryArchiveCryptoBinding,
  type RecoveryArchiveGenerationDek,
  type RecoveryArchiveKeyCustodyAdapter,
  type RecoveryArchiveManifestMacBinding,
  type RecoveryArchiveSealedSection,
  type RecoveryArchiveSectionAadBinding,
  type RecoveryArchiveSectionPlan,
  type RecoveryArchiveSectionSealInput,
  type RecoveryArchiveTransactionDepthProbe,
} from "../../src/multitable/recovery-archive-crypto";
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from "../../src/multitable/recovery-archive-contract";

const WORKSPACE = "ws_d2h_unit";
const BASE = "base_d2h_unit";
const SHEET = "sheet_d2h_unit";
const CHECKPOINT = "ckpt_d2h_unit";
const KEY_ID = "key_d2h_unit";
const WRAPPED_DEK_ID = "wrapped_d2h_unit";
/** Above 2^53: the anchor seq must survive as an exact decimal STRING, never a JS number. */
const ANCHOR_SEQ = "9007199254741993";
const PLAINTEXT = Buffer.from(
  '{"entity_key":"record/r1","payload":{"a":1}}',
  "utf8",
);
const CREATED_AT = "2026-08-26T00:00:00.000Z";
const EXPIRES_AT = "2027-08-26T00:00:00.000Z";

function fingerprintOfDek(dek: Uint8Array): string {
  return createHmac("sha256", Buffer.from(dek))
    .update(RECOVERY_ARCHIVE_DEK_FINGERPRINT_DOMAIN)
    .digest("hex");
}

/**
 * In-memory key-custody test adapter. It is deliberately NOT a vendor: it exists to exercise the
 * interface shape, the transaction-depth guard, and the result validation. Wrapping is RANDOMIZED
 * so a test can prove the fingerprint tracks the unwrapped DEK rather than the wrapped blob.
 */
function createTestCustody(
  options: {
    dek?: Buffer;
    overrides?: Partial<RecoveryArchiveKeyCustodyAdapter>;
    dekResult?: (issued: RecoveryArchiveGenerationDek) => unknown;
  } = {},
): RecoveryArchiveKeyCustodyAdapter & {
  calls: string[];
  issued: Uint8Array[];
} {
  const dek = options.dek ?? randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
  const calls: string[] = [];
  const issued: Uint8Array[] = [];
  const wrap = (
    wrappedDekId = WRAPPED_DEK_ID,
  ): RecoveryArchiveGenerationDek => {
    // A fresh DEK copy per call: the helper zeroes the buffer it is handed.
    const copy = Buffer.from(dek);
    issued.push(copy);
    return {
      dek: copy,
      wrappedDekId,
      // Randomized envelope: two wraps of one DEK never produce equal bytes.
      wrappedDek: Buffer.concat([randomBytes(16), Buffer.from(dek)]),
    };
  };

  const base: RecoveryArchiveKeyCustodyAdapter = {
    async produceGenerationDek() {
      calls.push("produceGenerationDek");
      const result = wrap();
      return (
        options.dekResult ? options.dekResult(result) : result
      ) as RecoveryArchiveGenerationDek;
    },
    async unwrapGenerationDek(request) {
      calls.push("unwrapGenerationDek");
      const result = wrap(request.wrappedDekId);
      return (
        options.dekResult ? options.dekResult(result) : result
      ) as RecoveryArchiveGenerationDek;
    },
    async deriveDekFingerprint(request) {
      calls.push("deriveDekFingerprint");
      return fingerprintOfDek(request.dek);
    },
    async macManifestRoot(request) {
      calls.push("macManifestRoot");
      return createHmac("sha256", `mac:${request.keyId}`)
        .update(request.preimage)
        .digest();
    },
    async verifyManifestRootMac(request) {
      calls.push("verifyManifestRootMac");
      const expected = createHmac("sha256", `mac:${request.keyId}`)
        .update(request.preimage)
        .digest();
      return Buffer.from(request.mac).equals(expected);
    },
  };
  return { ...base, ...options.overrides, calls, issued };
}

function depthProbe(
  ...depths: number[]
): RecoveryArchiveTransactionDepthProbe & { count: number } {
  let index = 0;
  const probe = {
    get count() {
      return index;
    },
    currentTransactionDepth() {
      const depth = depths[Math.min(index, depths.length - 1)];
      index += 1;
      return depth;
    },
  };
  return probe as RecoveryArchiveTransactionDepthProbe & { count: number };
}

function binding(
  overrides: Partial<RecoveryArchiveSectionAadBinding> = {},
): RecoveryArchiveSectionAadBinding {
  return {
    formatVersion: 1,
    generationId: randomUUID(),
    workspaceId: WORKSPACE,
    baseId: BASE,
    sheetId: SHEET,
    anchorOperationId: randomUUID(),
    anchorSeq: ANCHOR_SEQ,
    checkpointId: CHECKPOINT,
    keyId: KEY_ID,
    wrappedDekId: WRAPPED_DEK_ID,
    dekFingerprint: "a".repeat(64),
    aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
    sectionName: "records",
    plaintextSha256: recoveryArchivePlaintextSha256(PLAINTEXT),
    ...overrides,
  };
}

function generationBinding(
  overrides: Partial<
    Omit<RecoveryArchiveCryptoBinding, "dekFingerprint" | "wrappedDekId">
  > = {},
): Omit<RecoveryArchiveCryptoBinding, "dekFingerprint" | "wrappedDekId"> {
  return {
    formatVersion: 1,
    generationId: randomUUID(),
    workspaceId: WORKSPACE,
    baseId: BASE,
    sheetId: SHEET,
    anchorOperationId: randomUUID(),
    anchorSeq: ANCHOR_SEQ,
    checkpointId: CHECKPOINT,
    keyId: KEY_ID,
    aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
    ...overrides,
  };
}

/** A complete format-v1 archive_snapshot plan: all ten sections, exact order, one nonce each. */
function fullSnapshotSections(): RecoveryArchiveSectionPlan[] {
  return RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName) => ({
    sectionName,
    plaintext: Buffer.from(`{"section":"${sectionName}"}`, "utf8"),
    nonce: randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES),
  }));
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryArchiveCryptoError);
    return (error as RecoveryArchiveCryptoError).code;
  }
  throw new Error("expected_recovery_archive_crypto_refusal");
}

async function asyncCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryArchiveCryptoError);
    return (error as RecoveryArchiveCryptoError).code;
  }
  throw new Error("expected_recovery_archive_crypto_refusal");
}

async function capture(
  run: () => Promise<unknown>,
): Promise<RecoveryArchiveCryptoError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryArchiveCryptoError);
    return error as RecoveryArchiveCryptoError;
  }
  throw new Error("expected_recovery_archive_crypto_refusal");
}

describe("Phase D2h AEAD seal/open", () => {
  test("round trips the exact plaintext bytes under the exact AAD binding", () => {
    const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const nonce = randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES);
    const aad = binding();

    const sealed = sealRecoveryArchiveSection({
      binding: aad,
      dek,
      nonce,
      plaintext: PLAINTEXT,
    });

    expect(sealed.aeadAlgorithm).toBe("aes-256-gcm");
    expect(sealed.authTag).toHaveLength(RECOVERY_ARCHIVE_AEAD_TAG_BYTES);
    expect(sealed.nonce).toHaveLength(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES);
    expect(sealed.ciphertext.equals(PLAINTEXT)).toBe(false);

    const opened = openRecoveryArchiveSection({
      binding: aad,
      dek,
      nonce,
      ciphertext: sealed.ciphertext,
      authTag: sealed.authTag,
    });
    expect(opened.equals(PLAINTEXT)).toBe(true);
  });

  test("a different key refuses without recovering bytes", () => {
    const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const nonce = randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES);
    const aad = binding();
    const sealed = sealRecoveryArchiveSection({
      binding: aad,
      dek,
      nonce,
      plaintext: PLAINTEXT,
    });

    expect(
      codeOf(() =>
        openRecoveryArchiveSection({
          binding: aad,
          dek: randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES),
          nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_AEAD_OPEN_FAILED");
  });

  test("tampered auth tag, ciphertext, or nonce each refuse", () => {
    const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const nonce = randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES);
    const aad = binding();
    const sealed = sealRecoveryArchiveSection({
      binding: aad,
      dek,
      nonce,
      plaintext: PLAINTEXT,
    });

    const flippedTag = Buffer.from(sealed.authTag);
    flippedTag[0] ^= 0x01;
    const flippedCiphertext = Buffer.from(sealed.ciphertext);
    flippedCiphertext[0] ^= 0x01;
    const flippedNonce = Buffer.from(nonce);
    flippedNonce[0] ^= 0x01;

    for (const variant of [
      { ciphertext: sealed.ciphertext, authTag: flippedTag, nonce },
      { ciphertext: flippedCiphertext, authTag: sealed.authTag, nonce },
      {
        ciphertext: sealed.ciphertext,
        authTag: sealed.authTag,
        nonce: flippedNonce,
      },
    ]) {
      expect(
        codeOf(() =>
          openRecoveryArchiveSection({ binding: aad, dek, ...variant }),
        ),
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_AEAD_OPEN_FAILED");
    }
  });

  test("truncated ciphertext refuses (accidental corruption pair)", () => {
    const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const nonce = randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES);
    const aad = binding();
    const sealed = sealRecoveryArchiveSection({
      binding: aad,
      dek,
      nonce,
      plaintext: PLAINTEXT,
    });

    expect(
      codeOf(() =>
        openRecoveryArchiveSection({
          binding: aad,
          dek,
          nonce,
          ciphertext: sealed.ciphertext.subarray(
            0,
            sealed.ciphertext.length - 1,
          ),
          authTag: sealed.authTag,
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_AEAD_OPEN_FAILED");
  });

  test("every AAD field is load bearing: changing any one refuses the open", () => {
    const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const nonce = randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES);
    const aad = binding();
    const sealed = sealRecoveryArchiveSection({
      binding: aad,
      dek,
      nonce,
      plaintext: PLAINTEXT,
    });

    const mutations: Array<Partial<RecoveryArchiveSectionAadBinding>> = [
      { generationId: randomUUID() },
      { workspaceId: `${WORKSPACE}_other` },
      { baseId: `${BASE}_other` },
      { sheetId: `${SHEET}_other` },
      { anchorOperationId: randomUUID() },
      { anchorSeq: "9007199254741994" },
      { checkpointId: `${CHECKPOINT}_other` },
      { keyId: `${KEY_ID}_other` },
      { wrappedDekId: `${WRAPPED_DEK_ID}_other` },
      { dekFingerprint: "b".repeat(64) },
      { sectionName: "links" },
      { plaintextSha256: "c".repeat(64) },
    ];

    for (const mutation of mutations) {
      expect(
        codeOf(() =>
          openRecoveryArchiveSection({
            binding: { ...aad, ...mutation },
            dek,
            nonce,
            ciphertext: sealed.ciphertext,
            authTag: sealed.authTag,
          }),
        ),
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_AEAD_OPEN_FAILED");
    }
    // Positive control: the unmutated binding still opens, so the loop above is not passing
    // because every open is broken.
    expect(
      openRecoveryArchiveSection({
        binding: aad,
        dek,
        nonce,
        ciphertext: sealed.ciphertext,
        authTag: sealed.authTag,
      }).equals(PLAINTEXT),
    ).toBe(true);
  });

  test("unknown algorithm refuses on both seal and open", () => {
    const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const nonce = randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES);
    // `aes-256-cbc` is a real Node cipher and is NOT AEAD: it must be refused by the closed set,
    // not merely fail later for lack of an auth tag.
    const rogue = binding({
      aeadAlgorithm:
        "aes-256-cbc" as unknown as typeof RECOVERY_ARCHIVE_AEAD_ALGORITHM,
    });

    expect(
      codeOf(() =>
        sealRecoveryArchiveSection({
          binding: rogue,
          dek,
          nonce,
          plaintext: PLAINTEXT,
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_UNKNOWN_AEAD_ALGORITHM");
    expect(
      codeOf(() =>
        openRecoveryArchiveSection({
          binding: rogue,
          dek,
          nonce,
          ciphertext: Buffer.alloc(8),
          authTag: Buffer.alloc(RECOVERY_ARCHIVE_AEAD_TAG_BYTES),
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_UNKNOWN_AEAD_ALGORITHM");
  });

  test("malformed key, nonce, and tag lengths refuse with this module codes", () => {
    const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const nonce = randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES);
    const aad = binding();
    const sealed = sealRecoveryArchiveSection({
      binding: aad,
      dek,
      nonce,
      plaintext: PLAINTEXT,
    });

    expect(
      codeOf(() =>
        sealRecoveryArchiveSection({
          binding: aad,
          dek: randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES - 1),
          nonce,
          plaintext: PLAINTEXT,
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_KEY_LENGTH");
    expect(
      codeOf(() =>
        sealRecoveryArchiveSection({
          binding: aad,
          dek,
          nonce: randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES + 1),
          plaintext: PLAINTEXT,
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_NONCE_LENGTH");
    expect(
      codeOf(() =>
        openRecoveryArchiveSection({
          binding: aad,
          dek,
          nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag.subarray(
            0,
            RECOVERY_ARCHIVE_AEAD_TAG_BYTES - 1,
          ),
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_AUTH_TAG_LENGTH");
  });

  test("a plaintext digest that does not describe these bytes refuses before sealing", () => {
    expect(
      codeOf(() =>
        sealRecoveryArchiveSection({
          binding: binding({ plaintextSha256: "d".repeat(64) }),
          dek: randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES),
          nonce: randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES),
          plaintext: PLAINTEXT,
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_PLAINTEXT_DIGEST_MISMATCH");
  });

  test("an incomplete or blank binding refuses instead of encoding an empty field", () => {
    for (const mutation of [
      { workspaceId: "" },
      { workspaceId: "   " },
      { baseId: undefined as unknown as string },
      { sheetId: null as unknown as string },
      { checkpointId: "" },
      { keyId: "" },
      { wrappedDekId: "" },
      { anchorOperationId: "" },
      { generationId: "" },
      { dekFingerprint: "A".repeat(64) },
      { dekFingerprint: "a".repeat(63) },
      { formatVersion: 2 },
      { sectionName: "not_a_section" as never },
      { plaintextSha256: "not-a-hash" },
    ]) {
      expect(
        codeOf(() => buildRecoveryArchiveSectionAad(binding(mutation))),
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_AAD_BINDING");
    }
  });

  test("anchor seq is an exact decimal string; a JS number spelling refuses", () => {
    expect(
      codeOf(() =>
        buildRecoveryArchiveSectionAad(
          binding({ anchorSeq: 9007199254741993 as unknown as string }),
        ),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_AAD_BINDING");
    // Number(ANCHOR_SEQ) rounds to ...1992: the string form must survive the AAD unchanged.
    expect(String(Number(ANCHOR_SEQ))).not.toBe(ANCHOR_SEQ);
    expect(
      buildRecoveryArchiveSectionAad(binding()).includes(
        Buffer.from(ANCHOR_SEQ),
      ),
    ).toBe(true);
    expect(
      buildRecoveryArchiveSectionAad(binding()).includes(
        Buffer.from(String(Number(ANCHOR_SEQ))),
      ),
    ).toBe(false);
  });

  test("the AAD encoding is tagged, length prefixed, domain separated, and exactly ordered", () => {
    const aad = buildRecoveryArchiveSectionAad(binding());
    const reader = fieldReader(aad);
    expect(reader.read()).toEqual({
      tag: RECOVERY_ARCHIVE_FIELD_TAG_STRING,
      value: "metasheet.recovery-archive.aead.v1",
    });
    expect(reader.read().value).toBe(
      String(RECOVERY_ARCHIVE_CRYPTO_CONTRACT_VERSION),
    );
    const count = reader.count();
    expect(count).toBe(RECOVERY_ARCHIVE_AAD_FIELD_ORDER.length);
    expect(RECOVERY_ARCHIVE_AAD_FIELD_ORDER).toHaveLength(14);

    const values = Array.from({ length: count }, () => reader.read());
    expect(reader.atEnd()).toBe(true);
    // Every AAD field is a string: the AAD has no nullable member.
    expect(
      values.every((field) => field.tag === RECOVERY_ARCHIVE_FIELD_TAG_STRING),
    ).toBe(true);
    expect(
      values[RECOVERY_ARCHIVE_AAD_FIELD_ORDER.indexOf("anchor_seq")].value,
    ).toBe(ANCHOR_SEQ);
    expect(
      values[RECOVERY_ARCHIVE_AAD_FIELD_ORDER.indexOf("section_name")].value,
    ).toBe("records");
  });
});

function fieldReader(buffer: Buffer) {
  let offset = 0;
  return {
    read() {
      const tag = buffer.readUInt8(offset);
      offset += 1;
      const length = buffer.readUInt32BE(offset);
      offset += 4;
      const value =
        tag === RECOVERY_ARCHIVE_FIELD_TAG_NULL
          ? null
          : buffer.subarray(offset, offset + length).toString("utf8");
      offset += length;
      return { tag, value };
    },
    count() {
      const value = buffer.readUInt32BE(offset);
      offset += 4;
      return value;
    },
    atEnd() {
      return offset === buffer.length;
    },
  };
}

describe("Phase D2h manifest/root MAC binding", () => {
  const macBinding = (
    overrides: Partial<RecoveryArchiveManifestMacBinding> = {},
  ): RecoveryArchiveManifestMacBinding => ({
    ...(binding() as RecoveryArchiveCryptoBinding),
    rootHash: "1".repeat(64),
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    sourceVectorHash: "2".repeat(64),
    ...overrides,
  });

  test("the preimage binds created_at and every identity field, in order", () => {
    const preimage = buildRecoveryArchiveManifestMacPreimage(macBinding());
    const reader = fieldReader(preimage);
    expect(reader.read().value).toBe(
      "metasheet.recovery-archive.manifest-mac.v1",
    );
    expect(reader.read().value).toBe(
      String(RECOVERY_ARCHIVE_CRYPTO_CONTRACT_VERSION),
    );
    const count = reader.count();
    expect(count).toBe(RECOVERY_ARCHIVE_MANIFEST_MAC_FIELD_ORDER.length);

    const values = Array.from({ length: count }, () => reader.read());
    expect(reader.atEnd()).toBe(true);
    expect(
      values[RECOVERY_ARCHIVE_MANIFEST_MAC_FIELD_ORDER.indexOf("created_at")]
        .value,
    ).toBe(CREATED_AT);
    expect(
      values[RECOVERY_ARCHIVE_MANIFEST_MAC_FIELD_ORDER.indexOf("root_hash")]
        .value,
    ).toBe("1".repeat(64));
  });

  test("a null expiry is a first-class bound value with its own type tag", () => {
    const preimage = buildRecoveryArchiveManifestMacPreimage(
      macBinding({ expiresAt: null }),
    );
    const reader = fieldReader(preimage);
    reader.read();
    reader.read();
    const count = reader.count();
    const values = Array.from({ length: count }, () => reader.read());
    const expiry =
      values[RECOVERY_ARCHIVE_MANIFEST_MAC_FIELD_ORDER.indexOf("expires_at")];

    expect(expiry.tag).toBe(RECOVERY_ARCHIVE_FIELD_TAG_NULL);
    expect(expiry.value).toBeNull();
    // Every other field is still a string, so the null tag is not a global encoding change.
    expect(
      values.filter((field) => field.tag === RECOVERY_ARCHIVE_FIELD_TAG_NULL),
    ).toHaveLength(1);
  });

  test("NO string can forge the null-expiry preimage", () => {
    const nullPreimage = buildRecoveryArchiveManifestMacPreimage(
      macBinding({ expiresAt: null }),
    );
    // The empty string and the literal text "null" are the two spellings a tagless length-prefixed
    // encoding would collide with; both must produce different bytes.
    for (const spelling of ["", "null", "NULL", " "]) {
      const stringPreimage = (() => {
        try {
          return buildRecoveryArchiveManifestMacPreimage(
            macBinding({ expiresAt: spelling }),
          );
        } catch {
          // A non-canonical timestamp is refused outright, which is an even stronger separation.
          return null;
        }
      })();
      if (stringPreimage !== null)
        expect(stringPreimage.equals(nullPreimage)).toBe(false);
    }
    // And a real timestamp differs from null too.
    expect(
      buildRecoveryArchiveManifestMacPreimage(
        macBinding({ expiresAt: EXPIRES_AT }),
      ).equals(nullPreimage),
    ).toBe(false);
  });

  test("a MAC over a null expiry does not verify against a string expiry", async () => {
    const custody = createTestCustody();
    const neverExpires = macBinding({ expiresAt: null });
    const mac = await custody.macManifestRoot({
      keyId: neverExpires.keyId,
      preimage: buildRecoveryArchiveManifestMacPreimage(neverExpires),
    });

    await expect(
      custody.verifyManifestRootMac({
        keyId: neverExpires.keyId,
        preimage: buildRecoveryArchiveManifestMacPreimage(neverExpires),
        mac,
      }),
    ).resolves.toBe(true);
    await expect(
      custody.verifyManifestRootMac({
        keyId: neverExpires.keyId,
        preimage: buildRecoveryArchiveManifestMacPreimage(
          macBinding({ ...neverExpires, expiresAt: EXPIRES_AT }),
        ),
        mac,
      }),
    ).resolves.toBe(false);
  });

  test("timestamps are canonical UTC with exactly millisecond precision", () => {
    expect(isRecoveryArchiveUtcTimestamp(CREATED_AT)).toBe(true);
    for (const spelling of [
      "2026-08-26T00:00:00Z", // second precision
      "2026-08-26T00:00:00.000000Z", // microseconds
      "2026-08-26T00:00:00.000+00:00", // offset instead of Z
      "2026-08-26T00:00:00.000", // no zone
      "2026-08-26 00:00:00.000Z", // space separator
      "2026-13-26T00:00:00.000Z", // impossible month, correct shape
      "2026-02-30T00:00:00.000Z", // impossible day, correct shape
      "2026-08-26T24:00:00.000Z", // impossible hour, correct shape
      // Expanded-year ISO instants: these round trip exactly through `Date`, so ONLY the fixed
      // four-digit-year spelling refuses them. Without this arm the regex is dead weight.
      "+010000-01-01T00:00:00.000Z",
      "+275760-09-13T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z",
    ]) {
      expect(isRecoveryArchiveUtcTimestamp(spelling), spelling).toBe(false);
      expect(
        codeOf(() =>
          buildRecoveryArchiveManifestMacPreimage(
            macBinding({ createdAt: spelling }),
          ),
        ),
        spelling,
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_TIMESTAMP");
      expect(
        codeOf(() =>
          buildRecoveryArchiveManifestMacPreimage(
            macBinding({ expiresAt: spelling }),
          ),
        ),
        spelling,
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_TIMESTAMP");
    }
  });

  test('an undefined expiry is not read as "never expires"', () => {
    expect(
      codeOf(() =>
        buildRecoveryArchiveManifestMacPreimage(
          macBinding({ expiresAt: undefined as unknown as string }),
        ),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_TIMESTAMP");
    expect(
      codeOf(() =>
        buildRecoveryArchiveManifestMacPreimage(
          macBinding({ createdAt: undefined as unknown as string }),
        ),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_TIMESTAMP");
  });

  test("a missing root hash or source vector hash refuses", () => {
    for (const mutation of [
      { rootHash: "nope" },
      { sourceVectorHash: "F".repeat(64) },
    ]) {
      expect(
        codeOf(() =>
          buildRecoveryArchiveManifestMacPreimage(macBinding(mutation)),
        ),
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_MAC_BINDING");
    }
  });

  test("a MAC over one root does not verify against a different binding", async () => {
    const custody = createTestCustody();
    const bound = macBinding();
    const mac = await custody.macManifestRoot({
      keyId: bound.keyId,
      preimage: buildRecoveryArchiveManifestMacPreimage(bound),
    });
    await expect(
      custody.verifyManifestRootMac({
        keyId: bound.keyId,
        preimage: buildRecoveryArchiveManifestMacPreimage(bound),
        mac,
      }),
    ).resolves.toBe(true);
    await expect(
      custody.verifyManifestRootMac({
        keyId: bound.keyId,
        preimage: buildRecoveryArchiveManifestMacPreimage(
          macBinding({ ...bound, rootHash: "3".repeat(64) }),
        ),
        mac,
      }),
    ).resolves.toBe(false);
  });
});

describe("Phase D2h key-custody transaction-depth guard", () => {
  test("depth zero passes; any nonzero depth or unreadable depth refuses", () => {
    expect(() =>
      assertKeyCustodyCallOutsideTransaction(depthProbe(0)),
    ).not.toThrow();
    expect(
      codeOf(() => assertKeyCustodyCallOutsideTransaction(depthProbe(1))),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION");
    for (const bad of [
      { currentTransactionDepth: () => Number.NaN },
      { currentTransactionDepth: () => -1 },
      { currentTransactionDepth: () => 1.5 },
      { currentTransactionDepth: () => undefined as unknown as number },
      {
        currentTransactionDepth: () => {
          throw new Error("probe unavailable");
        },
      },
    ]) {
      expect(codeOf(() => assertKeyCustodyCallOutsideTransaction(bad))).toBe(
        "RECOVERY_ARCHIVE_CRYPTO_TRANSACTION_DEPTH_UNKNOWN",
      );
    }
  });

  test("every wrapped verb refuses inside a transaction and reaches the adapter zero times", async () => {
    const custody = createTestCustody();
    const guarded = createTransactionGuardedKeyCustody(custody, {
      currentTransactionDepth: () => 1,
    });

    for (const call of [
      () =>
        guarded.produceGenerationDek({
          keyId: KEY_ID,
          generationId: randomUUID(),
        }),
      () =>
        guarded.unwrapGenerationDek({
          keyId: KEY_ID,
          generationId: randomUUID(),
          wrappedDekId: WRAPPED_DEK_ID,
          wrappedDek: Buffer.alloc(48),
        }),
      () =>
        guarded.deriveDekFingerprint({ keyId: KEY_ID, dek: Buffer.alloc(32) }),
      () =>
        guarded.macManifestRoot({ keyId: KEY_ID, preimage: Buffer.alloc(8) }),
      () =>
        guarded.verifyManifestRootMac({
          keyId: KEY_ID,
          preimage: Buffer.alloc(8),
          mac: Buffer.alloc(32),
        }),
    ]) {
      expect(await asyncCodeOf(call)).toBe(
        "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION",
      );
    }
    expect(custody.calls).toEqual([]);
  });

  test("the guard is per call, not entry only: depth opening mid build still refuses", async () => {
    const custody = createTestCustody();
    const sealCalls: RecoveryArchiveSectionSealInput[] = [];

    // entry 0, produceGenerationDek 0, deriveDekFingerprint 1. An entry-only guard would let the
    // second and third verbs through.
    const code = await asyncCodeOf(() =>
      reserveThenSealRecoveryArchiveSections({
        binding: generationBinding(),
        keyCustody: custody,
        transactionDepth: depthProbe(0, 0, 1),
        dekSource: { kind: "produce" },
        sections: fullSnapshotSections(),
        reserveNonces: async () => {
          throw new Error("reservation must never be reached");
        },
        sealSection: (input) => {
          sealCalls.push(input);
          return sealRecoveryArchiveSection(input);
        },
      }),
    );

    expect(code).toBe(
      "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION",
    );
    expect(custody.calls).toEqual(["produceGenerationDek"]);
    expect(sealCalls).toHaveLength(0);
  });

  test("an already-open transaction refuses at entry, before any adapter call", async () => {
    const custody = createTestCustody();
    let reserveCalls = 0;
    expect(
      await asyncCodeOf(() =>
        reserveThenSealRecoveryArchiveSections({
          binding: generationBinding(),
          keyCustody: custody,
          transactionDepth: depthProbe(1),
          dekSource: { kind: "produce" },
          sections: fullSnapshotSections(),
          reserveNonces: async () => {
            reserveCalls += 1;
          },
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION");
    expect(custody.calls).toEqual([]);
    expect(reserveCalls).toBe(0);
  });

  test("a transaction left open BY the reservation sink refuses before any encryption", async () => {
    const custody = createTestCustody();
    const sealCalls: RecoveryArchiveSectionSealInput[] = [];
    let reserveCalls = 0;

    // entry 0, produce 0, derive 0, then the post-reservation check sees a transaction the sink
    // opened and never closed.
    expect(
      await asyncCodeOf(() =>
        reserveThenSealRecoveryArchiveSections({
          binding: generationBinding(),
          keyCustody: custody,
          transactionDepth: depthProbe(0, 0, 0, 1),
          dekSource: { kind: "produce" },
          sections: fullSnapshotSections(),
          reserveNonces: async () => {
            reserveCalls += 1;
          },
          sealSection: (input) => {
            sealCalls.push(input);
            return sealRecoveryArchiveSection(input);
          },
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION");
    expect(reserveCalls).toBe(1);
    expect(sealCalls).toHaveLength(0);
  });

  test("a transaction opened before upload refuses before the provider callback", async () => {
    const custody = createTestCustody();
    const uploads: RecoveryArchiveSealedSection[] = [];
    // entry, produce, derive, post-reservation all 0; the first pre-upload check sees 1.
    expect(
      await asyncCodeOf(() =>
        reserveThenSealRecoveryArchiveSections({
          binding: generationBinding(),
          keyCustody: custody,
          transactionDepth: depthProbe(0, 0, 0, 0, 1),
          dekSource: { kind: "produce" },
          sections: fullSnapshotSections(),
          reserveNonces: async () => {},
          uploadSealedSection: async (sealed) => {
            uploads.push(sealed);
          },
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION");
    expect(uploads).toHaveLength(0);
  });
});

describe("Phase D2h adapter result validation and throw normalization", () => {
  test("a wrong-length DEK, blank wrapped id, or empty wrapped blob refuses", async () => {
    for (const corrupt of [
      (issued: RecoveryArchiveGenerationDek) => ({
        ...issued,
        dek: randomBytes(31),
      }),
      (issued: RecoveryArchiveGenerationDek) => ({
        ...issued,
        dek: randomBytes(33),
      }),
      (issued: RecoveryArchiveGenerationDek) => ({
        ...issued,
        dek: Buffer.from(issued.dek).toString("hex") as unknown as Uint8Array,
      }),
      (issued: RecoveryArchiveGenerationDek) => ({
        ...issued,
        wrappedDekId: "  ",
      }),
      (issued: RecoveryArchiveGenerationDek) => ({
        ...issued,
        wrappedDek: Buffer.alloc(0),
      }),
      (issued: RecoveryArchiveGenerationDek) => ({
        ...issued,
        wrappedDek: "not-bytes" as unknown as Uint8Array,
      }),
      () => null,
      () => undefined,
      () => "a string result",
    ]) {
      const custody = createTestCustody({ dekResult: corrupt });
      expect(
        await asyncCodeOf(() =>
          reserveThenSealRecoveryArchiveSections({
            binding: generationBinding(),
            keyCustody: custody,
            transactionDepth: depthProbe(0),
            dekSource: { kind: "produce" },
            sections: fullSnapshotSections(),
            reserveNonces: async () => {},
          }),
        ),
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID");
    }
  });

  test("an unwrap that returns a DIFFERENT wrapped id refuses", async () => {
    const custody = createTestCustody({
      dekResult: (issued) => ({
        ...issued,
        wrappedDekId: `${issued.wrappedDekId}_swapped`,
      }),
    });
    expect(
      await asyncCodeOf(() =>
        reserveThenSealRecoveryArchiveSections({
          binding: generationBinding(),
          keyCustody: custody,
          transactionDepth: depthProbe(0),
          dekSource: {
            kind: "unwrap",
            wrappedDekId: WRAPPED_DEK_ID,
            wrappedDek: Buffer.alloc(48, 7),
          },
          sections: fullSnapshotSections(),
          reserveNonces: async () => {},
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID");

    // Positive control: the same unwrap succeeds when the adapter honours the requested id.
    const honest = createTestCustody();
    await expect(
      reserveThenSealRecoveryArchiveSections({
        binding: generationBinding(),
        keyCustody: honest,
        transactionDepth: depthProbe(0),
        dekSource: {
          kind: "unwrap",
          wrappedDekId: WRAPPED_DEK_ID,
          wrappedDek: Buffer.alloc(48, 7),
        },
        sections: fullSnapshotSections(),
        reserveNonces: async () => {},
      }),
    ).resolves.toBeTruthy();
    expect(honest.calls[0]).toBe("unwrapGenerationDek");
  });

  test("adapter result accessors are never invoked and cannot export provider text", async () => {
    const issuedDek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    let getterCalls = 0;
    const guarded = createTransactionGuardedKeyCustody(
      createTestCustody({
        overrides: {
          async produceGenerationDek() {
            return {
              get dek() {
                getterCalls += 1;
                throw new Error("provider-secret-host.example");
              },
              wrappedDekId: WRAPPED_DEK_ID,
              wrappedDek: Buffer.alloc(48, 7),
            } as unknown as RecoveryArchiveGenerationDek;
          },
        },
      }),
      depthProbe(0),
    );

    const error = await capture(() =>
      guarded.produceGenerationDek({
        keyId: KEY_ID,
        generationId: randomUUID(),
      }),
    );
    expect(error).toBeInstanceOf(RecoveryArchiveCryptoError);
    expect(error.message).toBe(
      "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID",
    );
    expect(error.message).not.toContain("provider-secret-host.example");
    expect(getterCalls).toBe(0);
    // The unused local is a positive control that this test is not accidentally observing scrub
    // side effects on bytes the adapter never actually returned.
    expect(issuedDek).toHaveLength(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
  });

  test("a Proxy reflection failure after exposing a DEK is closed and scrubs those bytes", async () => {
    const issuedDek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const target = {
      dek: issuedDek,
      wrappedDekId: WRAPPED_DEK_ID,
      wrappedDek: Buffer.alloc(48, 7),
    };
    const result = new Proxy(target, {
      getOwnPropertyDescriptor(value, property) {
        if (property === "wrappedDekId")
          throw new Error("provider-secret-host.example");
        return Reflect.getOwnPropertyDescriptor(value, property);
      },
    });
    const guarded = createTransactionGuardedKeyCustody(
      createTestCustody({
        overrides: {
          async produceGenerationDek() {
            return result;
          },
        },
      }),
      depthProbe(0),
    );

    const error = await capture(() =>
      guarded.produceGenerationDek({
        keyId: KEY_ID,
        generationId: randomUUID(),
      }),
    );
    expect(error.message).toBe(
      "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID",
    );
    expect(error.message).not.toContain("provider-secret-host.example");
    expect(
      Buffer.from(issuedDek).equals(
        Buffer.alloc(RECOVERY_ARCHIVE_AEAD_KEY_BYTES),
      ),
    ).toBe(true);
  });

  test("a typed-looking Proxy reflection failure is replaced with the result-invalid code", async () => {
    const issuedDek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const hostile = new RecoveryArchiveCryptoError(
      "RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_FINGERPRINT",
    );
    hostile.message = "provider-secret-host.example";
    const result = new Proxy(
      {
        dek: issuedDek,
        wrappedDekId: WRAPPED_DEK_ID,
        wrappedDek: Buffer.alloc(48, 7),
      },
      {
        getOwnPropertyDescriptor(value, property) {
          if (property === "wrappedDekId") throw hostile;
          return Reflect.getOwnPropertyDescriptor(value, property);
        },
      },
    );
    const guarded = createTransactionGuardedKeyCustody(
      createTestCustody({
        overrides: {
          async produceGenerationDek() {
            return result;
          },
        },
      }),
      depthProbe(0),
    );

    const error = await capture(() =>
      guarded.produceGenerationDek({
        keyId: KEY_ID,
        generationId: randomUUID(),
      }),
    );
    expect(error).not.toBe(hostile);
    expect(error.code).toBe(
      "RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID",
    );
    expect(error.message).toBe(error.code);
    expect(error.message).not.toContain("provider-secret-host.example");
    expect(
      Buffer.from(issuedDek).equals(
        Buffer.alloc(RECOVERY_ARCHIVE_AEAD_KEY_BYTES),
      ),
    ).toBe(true);
  });

  test("adapter results are snapshotted once instead of being re-read after validation", async () => {
    const issuedDek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const wrappedDek = Buffer.alloc(48, 7);
    const expectedDek = Buffer.from(issuedDek);
    const expectedWrappedDek = Buffer.from(wrappedDek);
    const result = { dek: issuedDek, wrappedDekId: WRAPPED_DEK_ID, wrappedDek };
    const guarded = createTransactionGuardedKeyCustody(
      createTestCustody({
        overrides: {
          async produceGenerationDek() {
            return result;
          },
        },
      }),
      depthProbe(0),
    );

    const snapshot = await guarded.produceGenerationDek({
      keyId: KEY_ID,
      generationId: randomUUID(),
    });
    result.wrappedDekId = "mutated-after-return";
    issuedDek.fill(9);
    wrappedDek.fill(8);
    result.wrappedDek = Buffer.alloc(0);
    expect(snapshot.dek).not.toBe(issuedDek);
    expect(snapshot.wrappedDek).not.toBe(wrappedDek);
    expect(Buffer.from(snapshot.dek)).toEqual(expectedDek);
    expect(snapshot.wrappedDekId).toBe(WRAPPED_DEK_ID);
    expect(Buffer.from(snapshot.wrappedDek)).toEqual(expectedWrappedDek);
  });

  test("a non-boolean MAC verdict and an empty MAC refuse", async () => {
    const guarded = createTransactionGuardedKeyCustody(
      createTestCustody({
        overrides: {
          async verifyManifestRootMac() {
            return "true" as unknown as boolean;
          },
          async macManifestRoot() {
            return Buffer.alloc(0);
          },
        },
      }),
      depthProbe(0),
    );
    expect(
      await asyncCodeOf(() =>
        guarded.verifyManifestRootMac({
          keyId: KEY_ID,
          preimage: Buffer.alloc(8),
          mac: Buffer.alloc(32),
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID");
    expect(
      await asyncCodeOf(() =>
        guarded.macManifestRoot({ keyId: KEY_ID, preimage: Buffer.alloc(8) }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_RESULT_INVALID");
  });

  test("arbitrary adapter, reservation, seal, and provider throws become closed codes", async () => {
    const thrown = [
      new Error("kms.internal.example:5671 refused: key arn:aws:kms:secret"),
      "a bare string rejection",
      null,
      { statusCode: 503, host: "vault.internal.example" },
    ];

    for (const raw of thrown) {
      // adapter
      expect(
        await asyncCodeOf(() =>
          reserveThenSealRecoveryArchiveSections({
            binding: generationBinding(),
            keyCustody: createTestCustody({
              overrides: {
                async produceGenerationDek() {
                  throw raw;
                },
              },
            }),
            transactionDepth: depthProbe(0),
            dekSource: { kind: "produce" },
            sections: fullSnapshotSections(),
            reserveNonces: async () => {},
          }),
        ),
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED");

      // reservation sink
      expect(
        await asyncCodeOf(() =>
          reserveThenSealRecoveryArchiveSections({
            binding: generationBinding(),
            keyCustody: createTestCustody(),
            transactionDepth: depthProbe(0),
            dekSource: { kind: "produce" },
            sections: fullSnapshotSections(),
            reserveNonces: async () => {
              throw raw;
            },
          }),
        ),
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_RESERVATION_FAILED");

      // sealer
      expect(
        await asyncCodeOf(() =>
          reserveThenSealRecoveryArchiveSections({
            binding: generationBinding(),
            keyCustody: createTestCustody(),
            transactionDepth: depthProbe(0),
            dekSource: { kind: "produce" },
            sections: fullSnapshotSections(),
            reserveNonces: async () => {},
            sealSection: () => {
              throw raw;
            },
          }),
        ),
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_SEAL_FAILED");

      // provider
      expect(
        await asyncCodeOf(() =>
          reserveThenSealRecoveryArchiveSections({
            binding: generationBinding(),
            keyCustody: createTestCustody(),
            transactionDepth: depthProbe(0),
            dekSource: { kind: "produce" },
            sections: fullSnapshotSections(),
            reserveNonces: async () => {},
            uploadSealedSection: async () => {
              throw raw;
            },
          }),
        ),
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_PROVIDER_FAILED");
    }
  });

  test("an externally thrown typed error is replaced instead of being trusted", async () => {
    const typed = new RecoveryArchiveCryptoError(
      "RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_FINGERPRINT",
    );
    typed.message = "kms.internal.example leaked provider text";
    const error = await capture(() =>
      reserveThenSealRecoveryArchiveSections({
        binding: generationBinding(),
        keyCustody: createTestCustody(),
        transactionDepth: depthProbe(0),
        dekSource: { kind: "produce" },
        sections: fullSnapshotSections(),
        reserveNonces: async () => {
          throw typed;
        },
      }),
    );
    expect(error).not.toBe(typed);
    expect(error.code).toBe("RECOVERY_ARCHIVE_CRYPTO_RESERVATION_FAILED");
    expect(error.message).toBe(error.code);
    expect(error.message).not.toContain("kms.internal.example");
  });

  test("no failure carries a cause, a host, a provider message, or any bound value", async () => {
    const generation = generationBinding();
    const sections = fullSnapshotSections();
    const secretish = [
      generation.keyId,
      generation.workspaceId,
      generation.baseId,
      generation.sheetId,
      generation.generationId,
      generation.checkpointId,
      generation.anchorOperationId,
      WRAPPED_DEK_ID,
      "vault.internal.example",
      "arn:aws:kms:secret",
      "records",
      toRecoveryArchiveNonceHex(sections[0].nonce),
      sections[0].plaintext.toString("utf8"),
    ];

    const error = await capture(() =>
      reserveThenSealRecoveryArchiveSections({
        binding: generation,
        keyCustody: createTestCustody({
          overrides: {
            async produceGenerationDek() {
              throw new Error(
                `vault.internal.example refused key ${generation.keyId} arn:aws:kms:secret`,
              );
            },
          },
        }),
        transactionDepth: depthProbe(0),
        dekSource: { kind: "produce" },
        sections,
        reserveNonces: async () => {},
      }),
    );

    expect(error.message).toBe("RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_FAILED");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect("cause" in error).toBe(false);
    const rendered = `${error.name} ${error.message} ${JSON.stringify(Object.getOwnPropertyNames(error))} ${error.stack ?? ""}`;
    for (const value of secretish) expect(rendered, value).not.toContain(value);
  });

  test("AEAD refusals are values free too", () => {
    const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const nonce = randomBytes(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES);
    const aad = binding();
    const sealed = sealRecoveryArchiveSection({
      binding: aad,
      dek,
      nonce,
      plaintext: PLAINTEXT,
    });

    let captured: RecoveryArchiveCryptoError | null = null;
    try {
      openRecoveryArchiveSection({
        binding: aad,
        dek: randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES),
        nonce,
        ciphertext: sealed.ciphertext,
        authTag: sealed.authTag,
      });
    } catch (error) {
      captured = error as RecoveryArchiveCryptoError;
    }

    expect(captured).toBeInstanceOf(RecoveryArchiveCryptoError);
    expect(captured?.message).toBe("RECOVERY_ARCHIVE_CRYPTO_AEAD_OPEN_FAILED");
    expect("cause" in (captured as object)).toBe(false);
    const rendered = `${captured?.name} ${captured?.message} ${captured?.stack ?? ""}`;
    for (const secret of [
      dek.toString("hex"),
      nonce.toString("hex"),
      PLAINTEXT.toString("utf8"),
      aad.workspaceId,
      aad.baseId,
      aad.sheetId,
      aad.generationId,
      aad.dekFingerprint,
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });
});

describe("Phase D2h DEK scrubbing", () => {
  test("scrubRecoveryArchiveDek zeroes exactly 32-byte views and leaves others alone", () => {
    const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    scrubRecoveryArchiveDek(dek);
    expect(dek.equals(Buffer.alloc(RECOVERY_ARCHIVE_AEAD_KEY_BYTES))).toBe(
      true,
    );

    const notADek = Buffer.alloc(31, 9);
    scrubRecoveryArchiveDek(notADek);
    expect(notADek.equals(Buffer.alloc(31, 9))).toBe(true);
    // Non-views are ignored rather than throwing: scrubbing runs on every failure path.
    expect(() => scrubRecoveryArchiveDek(undefined)).not.toThrow();
    expect(() => scrubRecoveryArchiveDek("deadbeef")).not.toThrow();
  });

  test("the issued DEK is zeroed on success and on EVERY failure path", async () => {
    const zeroed = Buffer.alloc(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);

    const paths: Array<
      [string, () => Promise<unknown>, ReturnType<typeof createTestCustody>]
    > = [];
    const push = (
      label: string,
      build: (
        custody: ReturnType<typeof createTestCustody>,
      ) => Promise<unknown>,
      custody = createTestCustody(),
    ) => paths.push([label, () => build(custody), custody]);

    push("success", (custody) =>
      reserveThenSealRecoveryArchiveSections({
        binding: generationBinding(),
        keyCustody: custody,
        transactionDepth: depthProbe(0),
        dekSource: { kind: "produce" },
        sections: fullSnapshotSections(),
        reserveNonces: async () => {},
        uploadSealedSection: async () => {},
      }),
    );
    push("reservation refused", (custody) =>
      reserveThenSealRecoveryArchiveSections({
        binding: generationBinding(),
        keyCustody: custody,
        transactionDepth: depthProbe(0),
        dekSource: { kind: "produce" },
        sections: fullSnapshotSections(),
        reserveNonces: async () => {
          throw new Error("conflict");
        },
      }),
    );
    push("seal failed", (custody) =>
      reserveThenSealRecoveryArchiveSections({
        binding: generationBinding(),
        keyCustody: custody,
        transactionDepth: depthProbe(0),
        dekSource: { kind: "produce" },
        sections: fullSnapshotSections(),
        reserveNonces: async () => {},
        sealSection: () => {
          throw new Error("seal exploded");
        },
      }),
    );
    push("provider failed", (custody) =>
      reserveThenSealRecoveryArchiveSections({
        binding: generationBinding(),
        keyCustody: custody,
        transactionDepth: depthProbe(0),
        dekSource: { kind: "produce" },
        sections: fullSnapshotSections(),
        reserveNonces: async () => {},
        uploadSealedSection: async () => {
          throw new Error("provider exploded");
        },
      }),
    );
    push("depth opened before encryption", (custody) =>
      reserveThenSealRecoveryArchiveSections({
        binding: generationBinding(),
        keyCustody: custody,
        transactionDepth: depthProbe(0, 0, 0, 1),
        dekSource: { kind: "produce" },
        sections: fullSnapshotSections(),
        reserveNonces: async () => {},
      }),
    );
    push(
      "fingerprint refused",
      (custody) =>
        reserveThenSealRecoveryArchiveSections({
          binding: generationBinding(),
          keyCustody: custody,
          transactionDepth: depthProbe(0),
          dekSource: { kind: "produce" },
          sections: fullSnapshotSections(),
          reserveNonces: async () => {},
        }),
      createTestCustody({
        overrides: {
          async deriveDekFingerprint() {
            return "not-opaque";
          },
        },
      }),
    );

    for (const [label, run, custody] of paths) {
      await run().catch(() => undefined);
      expect(custody.issued.length, label).toBeGreaterThan(0);
      for (const issued of custody.issued) {
        expect(Buffer.from(issued).equals(zeroed), label).toBe(true);
      }
    }
  });

  test("an invalid adapter result has its key bytes scrubbed before the refusal", async () => {
    const leaked: Uint8Array[] = [];
    const custody = createTestCustody({
      dekResult: (issued) => {
        leaked.push(issued.dek);
        return { ...issued, wrappedDekId: "" };
      },
    });
    await reserveThenSealRecoveryArchiveSections({
      binding: generationBinding(),
      keyCustody: custody,
      transactionDepth: depthProbe(0),
      dekSource: { kind: "produce" },
      sections: fullSnapshotSections(),
      reserveNonces: async () => {},
    }).catch(() => undefined);

    expect(leaked).toHaveLength(1);
    expect(
      Buffer.from(leaked[0]).equals(
        Buffer.alloc(RECOVERY_ARCHIVE_AEAD_KEY_BYTES),
      ),
    ).toBe(true);
  });
});

describe("Phase D2h archive_snapshot v1 section plan", () => {
  test("a complete plan is exactly the ten contract sections in the contract order", () => {
    expect(RECOVERY_ARCHIVE_V1_SECTION_NAMES).toHaveLength(10);
    expect(() =>
      assertRecoveryArchiveV1SnapshotPlan(fullSnapshotSections()),
    ).not.toThrow();
  });

  test("a short, long, reordered, or substituted plan refuses", () => {
    const complete = fullSnapshotSections();
    const cases: Array<[string, RecoveryArchiveSectionPlan[]]> = [
      ["missing one", complete.slice(0, 9)],
      ["missing the last", complete.slice(0, -1)],
      ["empty", []],
      [
        "reordered",
        (() => {
          const swapped = fullSnapshotSections();
          const [first, second] = [swapped[0], swapped[1]];
          swapped[0] = second;
          swapped[1] = first;
          return swapped;
        })(),
      ],
      ["reversed", [...fullSnapshotSections()].reverse()],
    ];
    for (const [label, plan] of cases) {
      expect(
        codeOf(() => assertRecoveryArchiveV1SnapshotPlan(plan)),
        label,
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_INCOMPLETE_SNAPSHOT_PLAN");
    }
  });

  test("the orchestration helper refuses a partial snapshot before any adapter call", async () => {
    const custody = createTestCustody();
    let reserveCalls = 0;
    expect(
      await asyncCodeOf(() =>
        reserveThenSealRecoveryArchiveSections({
          binding: generationBinding(),
          keyCustody: custody,
          transactionDepth: depthProbe(0),
          dekSource: { kind: "produce" },
          sections: fullSnapshotSections().slice(0, 3),
          reserveNonces: async () => {
            reserveCalls += 1;
          },
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_INCOMPLETE_SNAPSHOT_PLAN");
    expect(custody.calls).toEqual([]);
    expect(reserveCalls).toBe(0);
  });

  test("every section gets its own nonce and its own reservation row", async () => {
    const custody = createTestCustody();
    let reserved: readonly { sectionName: string; nonceHex: string }[] = [];
    const result = await reserveThenSealRecoveryArchiveSections({
      binding: generationBinding(),
      keyCustody: custody,
      transactionDepth: depthProbe(0),
      dekSource: { kind: "produce" },
      sections: fullSnapshotSections(),
      reserveNonces: async (rows) => {
        reserved = rows;
      },
    });

    expect(reserved).toHaveLength(10);
    expect(reserved.map((row) => row.sectionName)).toEqual([
      ...RECOVERY_ARCHIVE_V1_SECTION_NAMES,
    ]);
    expect(new Set(reserved.map((row) => row.nonceHex)).size).toBe(10);
    expect(result.sealedSections).toHaveLength(10);
    expect(result.sealedSections.map((section) => section.sectionName)).toEqual(
      [...RECOVERY_ARCHIVE_V1_SECTION_NAMES],
    );
  });
});

describe("Phase D2h DEK source discriminant", () => {
  test("the discriminant set is closed", () => {
    expect([...RECOVERY_ARCHIVE_DEK_SOURCE_KINDS]).toEqual([
      "produce",
      "unwrap",
    ]);
  });

  test("an unknown or malformed discriminant refuses instead of falling through to unwrap", async () => {
    for (const dekSource of [
      { kind: "rotate" },
      { kind: "" },
      { kind: "PRODUCE" },
      { kind: undefined },
      {},
      null,
      "produce",
      { kind: "unwrap" }, // missing wrapped fields
      { kind: "unwrap", wrappedDekId: "   ", wrappedDek: Buffer.alloc(4) },
      {
        kind: "unwrap",
        wrappedDekId: WRAPPED_DEK_ID,
        wrappedDek: Buffer.alloc(0),
      },
      { kind: "unwrap", wrappedDekId: WRAPPED_DEK_ID, wrappedDek: "not-bytes" },
    ]) {
      const custody = createTestCustody();
      expect(
        await asyncCodeOf(() =>
          reserveThenSealRecoveryArchiveSections({
            binding: generationBinding(),
            keyCustody: custody,
            transactionDepth: depthProbe(0),
            dekSource: dekSource as never,
            sections: fullSnapshotSections(),
            reserveNonces: async () => {},
          }),
        ),
      ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_SOURCE");
      // The decisive part: it did NOT quietly take the unwrap branch.
      expect(custody.calls).toEqual([]);
    }
  });

  test("both admitted discriminants reach their own adapter verb", async () => {
    const produce = createTestCustody();
    await reserveThenSealRecoveryArchiveSections({
      binding: generationBinding(),
      keyCustody: produce,
      transactionDepth: depthProbe(0),
      dekSource: { kind: "produce" },
      sections: fullSnapshotSections(),
      reserveNonces: async () => {},
    });
    expect(produce.calls[0]).toBe("produceGenerationDek");

    const unwrap = createTestCustody();
    await reserveThenSealRecoveryArchiveSections({
      binding: generationBinding(),
      keyCustody: unwrap,
      transactionDepth: depthProbe(0),
      dekSource: {
        kind: "unwrap",
        wrappedDekId: WRAPPED_DEK_ID,
        wrappedDek: Buffer.alloc(48, 3),
      },
      sections: fullSnapshotSections(),
      reserveNonces: async () => {},
    });
    expect(unwrap.calls[0]).toBe("unwrapGenerationDek");
  });
});

describe("Phase D2h reservation before encryption and upload", () => {
  function harness() {
    const sealCalls: RecoveryArchiveSectionSealInput[] = [];
    const uploadCalls: RecoveryArchiveSealedSection[] = [];
    const order: string[] = [];
    return {
      sealCalls,
      uploadCalls,
      order,
      sealSection: (input: RecoveryArchiveSectionSealInput) => {
        order.push("seal");
        sealCalls.push(input);
        return sealRecoveryArchiveSection(input);
      },
      uploadSealedSection: async (sealed: RecoveryArchiveSealedSection) => {
        order.push("upload");
        uploadCalls.push(sealed);
      },
    };
  }

  test("POSITIVE CONTROL: a successful reservation seals and uploads every section, reservation first", async () => {
    const custody = createTestCustody();
    const spy = harness();
    const plan = fullSnapshotSections();
    const binding = generationBinding();

    const result = await reserveThenSealRecoveryArchiveSections({
      binding,
      keyCustody: custody,
      transactionDepth: depthProbe(0),
      dekSource: { kind: "produce" },
      sections: plan,
      reserveNonces: async (reservations) => {
        spy.order.push("reserve");
        expect(reservations).toHaveLength(10);
        expect(
          new Set(reservations.map((row) => row.dekFingerprint)).size,
        ).toBe(1);
      },
      sealSection: spy.sealSection,
      uploadSealedSection: spy.uploadSealedSection,
    });

    expect(spy.sealCalls).toHaveLength(10);
    expect(spy.uploadCalls).toHaveLength(10);
    expect(spy.order).toEqual([
      "reserve",
      ...Array(10).fill("seal"),
      ...Array(10).fill("upload"),
    ]);
    expect(result.reservations.map((row) => row.nonceHex)).toEqual(
      plan.map((section) => toRecoveryArchiveNonceHex(section.nonce)),
    );
    expect(result.dekFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.binding).toEqual({
      ...binding,
      wrappedDekId: result.wrappedDekId,
      dekFingerprint: result.dekFingerprint,
    });
    expect(Object.isFrozen(result.binding)).toBe(true);
  });

  test("snapshots one stable binding before any async adapter call", async () => {
    const mutableBinding = generationBinding();
    const expectedBinding = { ...mutableBinding };
    const custody = createTestCustody();
    const pending = reserveThenSealRecoveryArchiveSections({
      binding: mutableBinding,
      keyCustody: custody,
      transactionDepth: depthProbe(0),
      dekSource: { kind: "produce" },
      sections: fullSnapshotSections(),
      reserveNonces: async () => {},
    });

    mutableBinding.keyId = "mutated-after-first-await";
    mutableBinding.generationId = randomUUID();
    const result = await pending;

    expect(result.binding.keyId).toBe(expectedBinding.keyId);
    expect(result.binding.generationId).toBe(expectedBinding.generationId);
  });

  test("refuses binding accessors without invoking them or reaching key custody", async () => {
    const hostileBinding = generationBinding() as Record<string, unknown>;
    let getterReads = 0;
    Object.defineProperty(hostileBinding, "keyId", {
      enumerable: true,
      get() {
        getterReads += 1;
        return `hostile-key-${getterReads}`;
      },
    });
    const custody = createTestCustody();

    expect(
      await asyncCodeOf(() =>
        reserveThenSealRecoveryArchiveSections({
          binding: hostileBinding as never,
          keyCustody: custody,
          transactionDepth: depthProbe(0),
          dekSource: { kind: "produce" },
          sections: fullSnapshotSections(),
          reserveNonces: async () => {},
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_AAD_BINDING");
    expect(getterReads).toBe(0);
    expect(custody.calls).toEqual([]);
  });

  test("fingerprinting cannot mutate the DEK later used for reservation and sealing", async () => {
    const originalDek = Buffer.alloc(RECOVERY_ARCHIVE_AEAD_KEY_BYTES, 0x11);
    let adapterOwnedDek: Uint8Array | undefined;
    let fingerprintView: Uint8Array | undefined;
    const custody = createTestCustody({
      dek: originalDek,
      dekResult: (issued) => {
        adapterOwnedDek = issued.dek;
        return issued;
      },
      overrides: {
        async deriveDekFingerprint(request) {
          fingerprintView = request.dek;
          const fingerprint = fingerprintOfDek(request.dek);
          adapterOwnedDek?.fill(0x22);
          request.dek.fill(0x33);
          return fingerprint;
        },
      },
    });
    const sealDeks: Buffer[] = [];
    let reservedFingerprint = "";

    const result = await reserveThenSealRecoveryArchiveSections({
      binding: generationBinding(),
      keyCustody: custody,
      transactionDepth: depthProbe(0),
      dekSource: { kind: "produce" },
      sections: fullSnapshotSections(),
      reserveNonces: async (reservations) => {
        reservedFingerprint = reservations[0]?.dekFingerprint ?? "";
      },
      sealSection: (input) => {
        sealDeks.push(Buffer.from(input.dek));
        return sealRecoveryArchiveSection(input);
      },
    });

    const expectedFingerprint = fingerprintOfDek(originalDek);
    expect(result.dekFingerprint).toBe(expectedFingerprint);
    expect(reservedFingerprint).toBe(expectedFingerprint);
    expect(sealDeks).toHaveLength(RECOVERY_ARCHIVE_V1_SECTION_NAMES.length);
    for (const sealedDek of sealDeks) expect(sealedDek).toEqual(originalDek);
    expect(fingerprintView).toBeDefined();
    expect(Buffer.from(fingerprintView ?? [])).toEqual(
      Buffer.alloc(RECOVERY_ARCHIVE_AEAD_KEY_BYTES),
    );
  });

  test("a refused (duplicate) reservation leaves zero seal calls, zero uploads, zero ciphertext", async () => {
    const custody = createTestCustody();
    const spy = harness();

    expect(
      await asyncCodeOf(() =>
        reserveThenSealRecoveryArchiveSections({
          binding: generationBinding(),
          keyCustody: custody,
          transactionDepth: depthProbe(0),
          dekSource: { kind: "produce" },
          sections: fullSnapshotSections(),
          reserveNonces: async () => {
            spy.order.push("reserve");
            // Shape of the durable registry refusal, as the SQL primitive raises it.
            throw new Error("recovery_archive_nonce_reservation_conflict");
          },
          sealSection: spy.sealSection,
          uploadSealedSection: spy.uploadSealedSection,
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_RESERVATION_FAILED");

    expect(spy.sealCalls).toEqual([]);
    expect(spy.uploadCalls).toEqual([]);
    expect(spy.order).toEqual(["reserve"]);
    // No manifest MAC was minted for a build that produced no ciphertext.
    expect(custody.calls).toEqual([
      "produceGenerationDek",
      "deriveDekFingerprint",
    ]);
  });

  test("the same nonce twice inside one generation refuses before any adapter call", async () => {
    const custody = createTestCustody();
    const spy = harness();
    const plan = fullSnapshotSections();
    plan[1] = { ...plan[1], nonce: Buffer.from(plan[0].nonce) };

    expect(
      await asyncCodeOf(() =>
        reserveThenSealRecoveryArchiveSections({
          binding: generationBinding(),
          keyCustody: custody,
          transactionDepth: depthProbe(0),
          dekSource: { kind: "produce" },
          sections: plan,
          reserveNonces: async () => {
            spy.order.push("reserve");
          },
          sealSection: spy.sealSection,
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_DUPLICATE_NONCE_IN_BATCH");
    expect(custody.calls).toEqual([]);
    expect(spy.order).toEqual([]);
  });

  test("a malformed section plan refuses before any adapter call", async () => {
    const custody = createTestCustody();
    const withFirst = (patch: Partial<RecoveryArchiveSectionPlan>) => {
      const plan = fullSnapshotSections();
      plan[0] = { ...plan[0], ...patch } as RecoveryArchiveSectionPlan;
      return plan;
    };

    for (const [plan, expected] of [
      [[], "RECOVERY_ARCHIVE_CRYPTO_INVALID_SECTION_PLAN"],
      [
        withFirst({ sectionName: "nope" as never }),
        "RECOVERY_ARCHIVE_CRYPTO_INVALID_SECTION_PLAN",
      ],
      [
        withFirst({ nonce: randomBytes(11) }),
        "RECOVERY_ARCHIVE_CRYPTO_INVALID_NONCE_LENGTH",
      ],
      [
        withFirst({ plaintext: "not-bytes" as unknown as Uint8Array }),
        "RECOVERY_ARCHIVE_CRYPTO_INVALID_SECTION_PLAN",
      ],
      [
        (() => {
          const plan = fullSnapshotSections();
          plan[1] = { ...plan[1], sectionName: plan[0].sectionName };
          return plan;
        })(),
        "RECOVERY_ARCHIVE_CRYPTO_DUPLICATE_SECTION",
      ],
    ] as const) {
      expect(
        await asyncCodeOf(() =>
          reserveThenSealRecoveryArchiveSections({
            binding: generationBinding(),
            keyCustody: custody,
            transactionDepth: depthProbe(0),
            dekSource: { kind: "produce" },
            sections: plan as never,
            reserveNonces: async () => {},
          }),
        ),
      ).toBe(expected);
    }
    expect(custody.calls).toEqual([]);
  });

  test("a fingerprint that is not the format-v1 opaque shape refuses before reservation", async () => {
    let reserveCalls = 0;
    expect(
      await asyncCodeOf(() =>
        reserveThenSealRecoveryArchiveSections({
          binding: generationBinding(),
          keyCustody: createTestCustody({
            overrides: {
              async deriveDekFingerprint() {
                return "not-an-opaque-fingerprint";
              },
            },
          }),
          transactionDepth: depthProbe(0),
          dekSource: { kind: "produce" },
          sections: fullSnapshotSections(),
          reserveNonces: async () => {
            reserveCalls += 1;
          },
        }),
      ),
    ).toBe("RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_FINGERPRINT");
    expect(reserveCalls).toBe(0);
  });
});

describe("Phase D2h DEK fingerprint authority", () => {
  test("a randomized wrapped blob cannot be the fingerprint authority", async () => {
    const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const custody = createTestCustody({ dek });

    const first = await custody.produceGenerationDek({
      keyId: KEY_ID,
      generationId: randomUUID(),
    });
    const second = await custody.produceGenerationDek({
      keyId: KEY_ID,
      generationId: randomUUID(),
    });

    // Same DEK, two wraps: the wrapped bytes differ, so a wrapped-blob hash is a different value
    // each time and would hide the reuse.
    expect(
      Buffer.from(first.wrappedDek).equals(Buffer.from(second.wrappedDek)),
    ).toBe(false);
    const wrappedHash = (blob: Uint8Array) =>
      createHash("sha256").update(blob).digest("hex");
    expect(wrappedHash(first.wrappedDek)).not.toBe(
      wrappedHash(second.wrappedDek),
    );

    // The contract-conforming fingerprint is derived from the UNWRAPPED DEK and is stable, so the
    // registry sees one identity and can detect the reuse.
    const firstFingerprint = await custody.deriveDekFingerprint({
      keyId: KEY_ID,
      dek: first.dek,
    });
    const secondFingerprint = await custody.deriveDekFingerprint({
      keyId: KEY_ID,
      dek: second.dek,
    });
    expect(firstFingerprint).toBe(secondFingerprint);
    expect(firstFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // And a genuinely different DEK yields a different identity, so the check is not constant.
    expect(
      await custody.deriveDekFingerprint({
        keyId: KEY_ID,
        dek: randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES),
      }),
    ).not.toBe(firstFingerprint);
  });

  test("two builds on the same DEK reserve under one fingerprint, so a repeated nonce collides", async () => {
    const dek = randomBytes(RECOVERY_ARCHIVE_AEAD_KEY_BYTES);
    const custody = createTestCustody({ dek });
    const sharedPlan = fullSnapshotSections();
    const reserved = new Set<string>();
    const reserveNonces = async (
      rows: readonly { dekFingerprint: string; nonceHex: string }[],
    ): Promise<void> => {
      for (const row of rows) {
        const key = `${row.dekFingerprint}:${row.nonceHex}`;
        if (reserved.has(key))
          throw new Error("recovery_archive_nonce_reservation_conflict");
        reserved.add(key);
      }
    };

    const build = () =>
      reserveThenSealRecoveryArchiveSections({
        binding: generationBinding(),
        keyCustody: custody,
        transactionDepth: depthProbe(0),
        dekSource: { kind: "produce" },
        sections: sharedPlan.map((section) => ({
          ...section,
          nonce: Buffer.from(section.nonce),
        })),
        reserveNonces,
      });

    await expect(build()).resolves.toBeTruthy();
    expect(await asyncCodeOf(build)).toBe(
      "RECOVERY_ARCHIVE_CRYPTO_RESERVATION_FAILED",
    );
  });
});
