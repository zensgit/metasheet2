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

## Follow-up 1 — DONE: the deploy path now enforces the ACL it attests

`scripts/ops/multitable-onprem-s6a-artifact-root-acl.ps1` applies the ACL, re-reads it,
and writes the attestation only when the re-read proves the control is in place. The
attestation is therefore no longer an operator assertion.

**Where it runs, and why not in the launcher.** The launcher is deliberately env-free —
it extracts the archive and hands off before any `app.env` is read — so it cannot know
the artifact root or the flag. `multitable-onprem-apply-package.ps1` already loads the
same `app.env` PM2 sources (`Import-AppEnvFile`) and already invokes the PM2 start
helper, so the step lives there, between the overlay and the restart. The launcher gains
only the pass-through switch.

**Flag-driven, not an opt-in switch.** Because the apply helper *does* have a notion of
the flag, the step is gated on
`MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED` being `true` in that same
`app.env` (trim + lower-case, matching `featureEnabled()`). A host that never enables
S6-A is not touched at all: no directory is created, no ACL is applied, and its `app.env`
is left byte-identical. An opt-in switch was rejected because the host that most needs
the ACL is exactly the host that already declared the flag, and a switch an operator
forgets is a silently unenforced control. `-S6aArtifactRootAcl off` (on both the launcher
and the apply helper, default `auto`) is the escape hatch; it skips the step, which leaves
the runtime refused rather than booting unenforced.

**Contract.**

- Artifact root comes from `MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ARTIFACT_ROOT`
  in that same file — the value the runtime itself resolves — and must be drive-qualified
  or UNC, control-character free, and untrimmed-clean (`requiredText` / `path.isAbsolute`
  parity). Created with `New-Item` when absent.
- Service account is the identity running the apply helper, which is the identity that
  starts PM2 and therefore owns the node process; there is no separate service-user
  config to read. If it cannot be derived, the step fails closed with
  `S6A_ARTIFACT_ROOT_ACL_SERVICE_ACCOUNT_UNKNOWN` **before** icacls runs and no
  attestation is written.
- `icacls <root> /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *<service-sid>:(OI)(CI)F`
  plus `*S-1-5-32-544:(OI)(CI)F` when the run is elevated. Well-known SIDs, not display
  names: the on-prem hosts are not guaranteed to be English and
  `BUILTIN\Administrators` / `NT AUTHORITY\SYSTEM` are localized.
- Verification is an independent re-read via `Get-Acl` with SID-typed access rules:
  inheritance protected, no inherited ACE, no ACE for Everyone / Authenticated Users /
  `BUILTIN\Users` / `BUILTIN\Guests`, and a full-control `(OI)(CI)` ACE for both the
  service account and SYSTEM. Only then is
  `MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED=true`
  written into `app.env` and into the process env.
- On any failure the attestation is never written, **and a pre-existing one is retracted**
  from `app.env`, so a host attested by an earlier deploy cannot stay attested after its
  ACL drifts. The apply helper then throws `S6A_ARTIFACT_ROOT_ACL_ATTESTATION_FAILED`
  before the restart.
- Output is four values-free lines and nothing else — no path, no SID, no account name,
  and icacls' own output is captured and discarded:
  `s6aArtifactRootAclApplied=YES|NO`, `s6aArtifactRootAclVerified=PASS|FAIL|SKIP`,
  `s6aWin32ArtifactAclAttested=YES|NO`, `s6aArtifactRootAclReason=<TOKEN>`. `SKIP` is the
  documented third verified value for "the step did not run".
- Idempotent: `/inheritance:r /grant:r` is a replace, and `app.env` is rewritten only when
  the attestation line is not already exactly right, so a re-run leaves the ACL and the
  file byte-identical.

**Not edited: the S6-A on-prem runbook.**
`docs/operations/stock-preparation-s6a-sqlserver-onprem-runbook-20260731.md` is
digest-pinned as `runtimeFiles.s6aOnpremRunbook` in
`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`,
so its §6 "set the runtime-only environment" list still omits the attestation variable.
That is correct as written — the operator no longer sets it by hand; the apply helper
does, and only after proving the ACL. Repinning the runbook needs the provenance-pin
procedure, which is out of scope here.

**Tests.** `scripts/ops/__tests__/multitable-onprem-s6a-artifact-root-acl.tests.ps1`, in
three layers: static wiring (step precedes the restart, both entry points expose the
switch, the package build requires the helper), injected icacls/ACL facts (argument
vector, every fail-closed branch, retraction, values-free output), and real `icacls`
against a throwaway directory under the process TEMP dir (apply, verify, idempotent
re-run, and a tampered ACL that retracts the attestation). CI runs it under Windows
PowerShell 5.1 *and* pwsh 7 in `plugin-tests.yml` job `stock-prep-powershell51` — the only
job with a real NTFS volume — and under pwsh 7 on Linux in the `test` job for the static
and not-applicable branches.

## Follow-ups (not in this change)

1. Ask the owner whether a dedicated §10 token is wanted.
2. Unrelated Windows-host observation: `core.autocrlf=true` checkouts fail
   `sealed-export-package-provenance` / `-s5-evidence`, because the pins hash LF bytes.
   Needs a `.gitattributes` `-text` rule or LF-normalising digests.
