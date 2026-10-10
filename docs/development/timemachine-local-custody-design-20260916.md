# Local custody: LC-1 through LC-6

Status: owner-ratified LC development boundary, 2026-09-16. Implementation candidate;
explicit local admission preserves format-v1 bytes. No startup activation, flags,
deployment or customer storage authorized.
Baseline: `021647c9ef5587a2796eccafafecc426067b63a2`.

The owner explicitly approved LC-1..6: separately identified non-KMS local custody;
keys outside the archive root; encrypted offline backup and separate unlock secret;
rotation retaining old keys; locked startup; synthetic local acceptance only.
This supersedes the Pending status of those six decisions in the earlier proposal,
not its separate NAS/capture/retention/activation boundaries.

## First implementation contract

- Use Node crypto AES-256-GCM, random 12-byte nonce, exact 16-byte authentication tag.
  Recovery secrets are independently generated 32-byte random keys, NOT passwords.
  No password KDF, automatic secret persistence, or implicit unlock is supplied.
- Local backup is a closed, size-bounded JSON envelope with local assurance, version,
  custody UUID, nonce, ciphertext and tag. AEAD authenticates its domain and custody
  UUID. Its plaintext is a binary bounded keyring: count followed by UUID/64-byte
  material entries (independent 32-byte wrapping and MAC keys). Last entry is active.
- A session starts locked, requires the expected custody UUID to unlock, and refuses
  all cryptographic verbs under nonzero/unknown transaction depth. Bad unlock never
  admits partial keys. Lock scrubs owned buffers; JS/OpenSSL may retain internal copies,
  so this is not a physical-memory erasure guarantee.
- Rotation exports a new encrypted backup containing ALL old versions and a fresh
  version. It does not activate it. The caller must durably retain the new package
  before locking and explicitly unlocking it. Failed export cannot change active state.
  Maximum 64 versions; no automatic key retirement/deletion.
- DEK wrap AAD binds local domain, custody UUID, key UUID, generation UUID and wrapped
  UUID. The API exposes distinct local method names and literal assurance; it is NOT
  a `RecoveryArchiveKeyCustodyAdapter` and cannot silently satisfy the KMS interface.
- Local DEK identity hashes a fixed domain plus the actual 32-byte DEK, independent
  of wrapping version/custody UUID, so rewrapping/rotation cannot evade nonce identity.
  It is a local cryptographic digest, NOT KMS attestation or a mathematical bijection.
- Manifest MAC uses the separate per-version MAC key, authenticated local domain,
  custody UUID and key UUID. Verify uses exact-length timing-safe comparison.
- Errors use a fixed code with no provider cause, path, key, identifiers or payload.
  Inputs/outputs do not alias internal keys. No mutable raw keyring is exported.

## Required acceptance and limits

Core tests cover locked state, wrong secret/custody, malformed/oversized/tampered
backup, restore of old/new versions, failed rotation, binding substitutions,
retained-version MAC, stable DEK identity, exact transaction refusal and values-free
errors. A separate process must unwrap a retained DEK using the encrypted backup.
This proves the custody core, not a consistent catalog/object backup of user records.

Future storage composition must publish the encrypted keyring durably and exclusively
outside archive roots, protect offline recovery secrets separately, and exercise an
actual separate-environment catalog/object/custody restore. Anti-rollback freshness
needs external trusted state; possession of an old valid backup is not prevented here.
No root-admin/same-UID compromise, NAS or power-loss claim. Existing format-v1 and
KMS admission remain unchanged. Explicit local admission is described below;
standard startup is not wired or activated.

Reference: https://nodejs.org/api/crypto.html (createCipheriv/createDecipheriv,
setAAD, setAuthTag and final). No new dependency.

## Encrypted package file layer

The explicit store takes existing owner-private local POSIX custody and archive
directories. Neither may contain the other, including canonical ancestor aliases.
It creates neither directory, saves no recovery secret, and never unlocks a session.
Both roots are pinned and revalidated; no NAS or unknown filesystem admission.
Linux admission also reads mountinfo and rejects subdirectory mounts and any
duplicate mount of either selected device, conservatively including legitimate
bind mounts. Missing/unreadable mount metadata refuses. Synthetic mountinfo tests
exercise this policy without mounting anything or changing a root identity.

Each package uses a caller-supplied UUID and immutable filename scoped by custody
UUID. Publication writes a private temporary file, syncs it, links exclusively to
the final name, compares final bytes, and syncs the directory. Same ID/same bytes
replay succeeds; same ID/different bytes refuses without replacing the winner.
The returned receipt binds package ID, exact size and SHA-256. Reading requires
that receipt and rejects unsafe permissions, symlinks, malformed envelopes and
digest/size mismatch. Envelope validation is structural, NOT authentication;
the custody core must still authenticate the package during explicit unlock.

No mutable active-version pointer, overwrite or deletion API is provided. A caller
must retain the receipt and adopt a saved rotation package explicitly. Storage
success does not prove independent offline backup, freshness or full restoration.
Root/path protection assumes no hostile same-UID/root process. Failed publication
may leave an encrypted orphan after filesystem/root failure, but must not return
success or destroy a previous package; cleanup must not traverse a replaced root.
Catalog/object/custody application recovery and startup composition remain pending.

## Explicit assurance admission

Compatibility review at `0d063ab7d2e457314fffabf4c8407e2c2273e4c8` confirms
that local admission can preserve the existing format-v1 wire bytes and validation.
This compatibility contract is implemented by the bounded admission follow-up;
exact implementation and test checkpoints are in the verification report.
LC-1 through LC-6 remain approved; no additional activation authority is inferred.

- Keep the existing KMS adapter type and callers intact. Extract common operations,
  and accept an opaque local capability as a separate discriminated input.
- Mint local capabilities only from a real unlocked session, bound to an explicit
  expected custody UUID supplied out-of-band. Runtime identity must be unforgeable
  by copying fields. Lock/re-unlock or custody replacement must revoke stale admission.
- Use canonical `local-v1:<custody-uuid>:<key-uuid>` key IDs. The existing manifest
  contract accepts opaque nonblank key IDs and authenticates them in AAD/root/MAC.
  Do not add envelope fields or modify domains, canonical ordering or old key IDs.
- Resolve the selected capability only inside the transaction-guarded custody path;
  retain every per-call transaction check, result validation and buffer cleanup.
  Never select or probe a provider from an unverified manifest key ID.
- Production must compare the requested local key with the session's active key.
  Actual-DEK fingerprints stay independent of wrapping version and custody identity.
- Bound source changes to crypto, local custody, application, preview, reader and
  authenticated-manifest modules, plus focused tests. No standard-startup changes.

Required negatives: forged/copied capability, wrong expected custody, locked or
revoked session, noncanonical/local cross-custody key IDs, inactive production key,
transaction refusal and KMS/local mismatch. Required positives: unchanged legacy
KMS tests, real local seal/authenticate/read chain, retained old-key read after
rotation, stable fingerprint and unchanged format-v1 canonical output rules.

Sol high independently reviewed this compatibility plan read-only; it did not run
tests or approve an implementation. This plan does not close full recovery acceptance.
