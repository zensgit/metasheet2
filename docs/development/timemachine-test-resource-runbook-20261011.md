# Time Machine test resource candidate execution packet

Local candidate only. This packet is reviewable before remote installation,
publication or staging activation. Those actions require the owner decision
described in the resource-adapter design lock. It does not release the native
same-archive two-scenario HOLD or qualify production key custody.

## Frozen dependency and scope

The candidate depends on Draft PR #6314 at
`564ca848dbf17d65c62d3dfa4a87ec5e11820ecf`. Review the publication branch
`codex/tm-resource-adapters-stack-20261011` relative to that frozen dependency;
do not count the dependency diff as new resource implementation. Fresh-main
integration qualification was performed at `98b8d5091f` (integration base
`7f52ce68e9d946771e3cf5625ec723d5f92931be`). Freeze the candidate commit,
tree, runtime and packet digests before a remote window; local green cannot
substitute for its remote CI or deployed identity.

Use the proposed Mac mini as a separate test resource host only after approval.
Assign separate OS service identities and separate private roots for the object
service and OpenBao. Application credentials cannot be root/unseal credentials
or the object-service TLS private key. Confirm that hot database/application
storage and resource storage do not share their failure domain. Distinct folder
names on one app host do not establish this property. Keep the app inaccessible
to customer traffic and use synthetic data throughout.

## Runtime and resource preparation

- Backend client/service: Node 20.20.2, pnpm 10.16.1, existing frozen dependencies;
  the object command runs on a POSIX host with an existing private archive root.
- OpenBao: official 2.7.1 darwin/arm64 release archive SHA-256
  `15625b5f69aee5bb4578b4e76e856a2141647342b0f8e5969a8875b44e0fbf91`;
  binary SHA-256 `50c3588e64271171cc2147bddeace8ec2b6742f94fd3fe53baa60f6d938cda0c`.
  Check target architecture and exact digest before use. Never use dev/in-memory
  mode. Use TLS plus persistent Raft storage and separately owned unlock material.
- Provision owner-only directories (0700), regular credential/config/key files
  (0600, current service UID), certificates with the exact target SAN and expiry,
  and client CA files. The fixture certificate generator is for tests only.
- Restrict listeners/network admission to the approved application identity.
  TLS verification remains enabled. No redirect, proxy discovery or insecure
  fallback is supported. Unknown/timeouts are errors, never absence receipts.
- Generate an independent object-service bearer credential with at least
  256 bits of entropy. OpenBao-issued tokens are opaque; do not substitute an
  invented length requirement. The application identities must be distinct.

Prepare object-service JSON with exactly these keys:

```json
{
  "host": "REPLACE_WITH_APPROVED_BIND_IP",
  "port": 18443,
  "archivePath": "/REPLACE_WITH_PRIVATE_ARCHIVE_ROOT",
  "storeId": "REPLACE_WITH_FROZEN_UUID",
  "maxObjectBytes": 16777216,
  "timeoutMs": 5000,
  "tokenPath": "/REPLACE_WITH_PRIVATE_OBJECT_TOKEN_FILE",
  "certPath": "/REPLACE_WITH_PRIVATE_OBJECT_CERT_FILE",
  "keyPath": "/REPLACE_WITH_PRIVATE_OBJECT_TLS_KEY_FILE"
}
```

Provision the private archive directory before launching. The command writes its
immutable root marker and refuses an incompatible existing store; it does not
create or silently select the archive directory. All seven operations require
authentication and complete binding/result validation, including discard/status.

Configure OpenBao with a private Raft path, explicit API/cluster addresses, a TLS
listener using the approved certificate/key, and the operator-selected seal
arrangement. The local component proof uses a single-node Shamir seal with an
unlock value kept in memory; it is not HA, hardware custody, or a production seal
recommendation. Back up encrypted service state and keep unlock/recovery material
outside that backup and outside the application identity.

Create three distinct `aes256-gcm96` Transit keys named `tm-wrap`,
`tm-fingerprint`, and `tm-manifest`, with `exportable=false` and
`allow_plaintext_backup=false`. The application token gets only this ACL:

```hcl
path "transit/datakey/plaintext/tm-wrap" { capabilities = ["update"] }
path "transit/decrypt/tm-wrap" { capabilities = ["update"] }
path "transit/hmac/tm-fingerprint/sha2-256" { capabilities = ["update"] }
path "transit/hmac/tm-manifest/sha2-256" { capabilities = ["update"] }
path "transit/verify/tm-manifest/sha2-256" { capabilities = ["update"] }
```

Give it no default policy, root, key-management, export, backup, encrypt or rewrap
rights. Keep the fingerprint key/version pinned and retained for the archive's
lifetime. Retain old wrapping/manifest versions needed for recovery. Key deletion
or increasing minimum decryption versions can make retained archives unusable.

OpenBao 2.7's documented rewrap endpoint does not carry `associated_data`; the
actual component request refused an AAD-bound blob. The rotation proof uses an
explicit operator encrypt control with the same DEK and binding. The application
does not acquire encrypt rights or implement archive rewrapping. Do not replace
wrapped metadata inside an existing archive: its ciphertext and manifest bindings
must remain consistent. New generations may use the latest wrapping version;
old generations retain their original wrapped blob.

Source: [OpenBao Transit API](https://openbao.org/docs/api/secret/transit/).

## Application packet and launch

Application JSON has exactly `objectStore`, `keyCustody`, `policy`, and `worker`.
These are private file references, not credential values:

```json
{
  "objectStore": {
    "url": "https://REPLACE_WITH_APPROVED_OBJECT_ORIGIN",
    "tokenPath": "/REPLACE_WITH_PRIVATE_OBJECT_CLIENT_TOKEN_FILE",
    "caPath": "/REPLACE_WITH_PRIVATE_OBJECT_CA_FILE",
    "timeoutMs": 5000,
    "storeId": "REPLACE_WITH_THE_SAME_FROZEN_UUID",
    "maxObjectBytes": 16777216
  },
  "keyCustody": {
    "url": "https://REPLACE_WITH_APPROVED_CUSTODY_ORIGIN",
    "tokenPath": "/REPLACE_WITH_PRIVATE_SCOPED_CUSTODY_TOKEN_FILE",
    "caPath": "/REPLACE_WITH_PRIVATE_CUSTODY_CA_FILE",
    "timeoutMs": 5000,
    "keyId": "REPLACE_WITH_FROZEN_LOGICAL_KEY_ID",
    "wrappingKey": "tm-wrap",
    "fingerprintKey": "tm-fingerprint",
    "fingerprintKeyVersion": 1,
    "manifestKey": "tm-manifest",
    "manifestKeyVersion": 1
  },
  "policy": {
    "auditedReplayHorizonMs": 60000,
    "asyncResumeHorizonMs": 600000,
    "workerIntervalMs": 1000
  },
  "worker": {
    "leaseMs": 60000,
    "replayHorizonMs": 60000,
    "sweepLimit": 100,
    "maxChunksPerRun": 20
  }
}
```

Numbers above are synthetic component recommendations, not staging retention
ratification. Freeze the reviewed window policy before activation. For manual
capture add the existing `policy.manualCapture` (`keyId`, `keyRowVersion`,
`leaseSeconds`, `expiresAfterSeconds`) and `policy.manualCaptureLimits`
(`maxBytes`, `timeoutMs`); bind them to the real synthetic key registry row.
Omitting them does not authorize capture. Do not invent registry entries or use
another tenant's identity.

Run from the frozen backend directory with its pinned Node/dependencies:

```sh
node --import tsx scripts/start-recovery-object-service.mts "$TM_OBJECT_PRIVATE_CONFIG"
node --import tsx scripts/start-recovery-remote.mts "$TM_APPLICATION_PRIVATE_CONFIG"
```

The second command also needs the existing application database/JWT configuration
and the owner-approved exact-literal archive/writer flags. No new environment
flag is introduced. Do not set shared flags from this packet. The canonical
default startup is unchanged; absent/non-exact flags refuse before reading any
resource path. Record only fixed codes, counts, source digests and private file
references in the acceptance receipt.

## Component verification and rollback

Before a staging window, run the focused workflow step (five complete unit files
plus both resource typechecks). The explicit software-KMS component can be run
without an application, database or TM flag:

```sh
node --import tsx scripts/verify-recovery-openbao.mts "$TM_VERIFIED_BAO_BINARY"
```

It creates and cleans only its own ephemeral TLS/Raft service, verifies mint and
generation-bound unwrap, pinned actual-DEK identity after wrapping/fingerprint
rotation, old/new MAC verification, denied token export/backup, and restoration
from encrypted state after removing the original. It does not execute the held
native APFS archive driver or prove remote resource durability.

For resource backup, stop the owned object process with SIGTERM and wait for a
successful exit; stop the owned OpenBao process normally and confirm completion.
Quiesce before copying complete private persistent roots. Do not call Transit
plaintext key backup/export APIs. Bind digests and the store/key IDs in a private
receipt. Test restoration into a distinct owned root with the same store ID and
separately retained unlock material before relying on it. A timeout/nonzero
drain keeps the backup unqualified; never force-kill unrelated processes or delete
unverified state.

Rollback order: stop/drain only the owned TM application, restore the captured
application flags/configuration and approved runtime identity, confirm the OFF
HTTP/SQL parity receipt, then stop/drain the owned resource services. Retain
encrypted archives, encrypted KMS state and separate recovery material until the
owner accepts their retirement. No production, customer-data or external-system
write is part of this packet. Native two-scenario and staging/rollback acceptance
remain separate outstanding gates.
