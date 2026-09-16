# Local custody: LC-1 through LC-6

Status: owner-ratified development boundary, 2026-09-16. Implementation candidate;
no startup, flags, deployment, customer storage or format-v1 admission authorized.
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
KMS admission remain unchanged. No adapter to the existing application is included.

Reference: https://nodejs.org/api/crypto.html (createCipheriv/createDecipheriv,
setAAD, setAuthTag and final). No new dependency.
