# Stock preparation S6-A — Windows runtime parity (2026-08-18)

The on-prem entity/test host for the S6-A SQL Server sealed-snapshot runtime is Windows.
Two POSIX assumptions in `plugins/plugin-integration-core/lib/sealed-export/` made that
runtime unusable there. Both are recorded here with the fix and the operator contract.

## Finding 1 — directory fsync wedges ingestion on the first chunk

`private-ingestion-blob-store.cjs` `syncDirectory()` did `fs.open(dir, 'r')` then
`handle.sync()`. NTFS exposes no directory-fsync primitive: the open succeeds, the sync
raises `EPERM` for every directory, and the `catch` refused with
`SEALED_EXPORT_STAGING_WRITE_FAILED`. It runs *after* the hardlink in `writeChunk()`, so the
chunk was already on disk while the caller was told the write had failed — and the retry
re-entered the same refusal. Every run wedged permanently on chunk 0.

**Fix.** A module-level `DIRECTORY_FSYNC_SUPPORTED = process.platform !== 'win32'` makes
`syncDirectory()` a no-op on win32 and nothing else. Only a *durability* barrier is skipped:
the per-file `handle.sync()` still runs everywhere, and the chunk digest, manifest digest and
`EXISTING_IDENTICAL` byte compare are untouched. On POSIX the module is byte-identical,
fail-closed refusal included. A win32 host loses only crash-consistency of the directory
entry, which re-presents as a missing chunk and is already refused by chunk-set completeness.

## Finding 2 — `chmod` is a silent no-op, so the artifact ACL is absent

`mkdir({ mode: 0o700 })` / `chmod(0o700 | 0o600)` in `private-ingestion-blob-store.cjs`,
`sqlserver-sealed-snapshot-service-core.cjs` and `sqlserver-s2-producer.cjs` succeed on win32
and then do nothing — the mode reads back `0o666`. No `icacls` call exists anywhere in the
repo, so the confidentiality the code asserts is simply absent at runtime on Windows.

**Fix — attested gate, not a silent downgrade.** The chmod calls stay: they remain the POSIX
control. `stock-preparation-runtime-config.cjs` now refuses to boot when the S6-A flag is on
and the platform is win32 unless
`MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED` is exactly
`'true'` (not trimmed, not case-folded — an attestation is an operator act). The refusal is
`SEALED_EXPORT_PROFILE_UNCERTIFIED` with details `{ field: 'win32ArtifactAclAttested' }`.

**Why not a dedicated reason token.** The §10 failure vocabulary was ratified by the owner on
2026-07-27 and frozen at exactly 30 tokens ("no reason may be added, removed or renamed"),
pinned byte-for-byte against
`stock-prep-sealed-export-manifest-capability-spike-20260727.md`. Minting
`SEALED_EXPORT_ARTIFACT_ROOT_MODE_UNENFORCEABLE` needs a fresh owner ruling. The open
safe-detail-token surface names the unmet control instead.

`loadStockPreparationRuntimeConfig` takes a `platform` option defaulting to
`process.platform`, so both branches are testable on any host. The flag remains the outer
gate: a disabled runtime is never asked to attest.

## Follow-ups (not in this change)

1. `scripts/ops/multitable-onprem-deploy-launcher.ps1` must apply
   `icacls <ARTIFACT_ROOT> /inheritance:r /grant:r "<svc>:(OI)(CI)F"` and export the
   attestation env var. Until it does, an attested host is asserted, not enforced.
2. Ask the owner whether a dedicated §10 token is wanted.
3. Unrelated Windows-host observation: `core.autocrlf=true` checkouts fail
   `sealed-export-package-provenance` / `-s5-evidence`, because the pins hash LF bytes.
   Needs a `.gitattributes` `-text` rule or LF-normalising digests.
