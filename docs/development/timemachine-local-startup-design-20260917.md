# Local Custody Startup Integration

Base: `23dfdf417686b931a515bf03abbce1d6471c3098`.

Owner authorized isolated development and synthetic verification. No flag
activation, customer storage, deployment, dispatch, or production access.

## Contract

- Existing exact-true archive and writer-fence gates remain unchanged. The OFF
  preparation path must not read local configuration, storage, secrets, or database
  state. The dedicated local launcher refuses OFF without starting a listener;
  the existing ordinary `src/index.ts` entry is unchanged.
- Local startup begins locked. Configuration and an encrypted backup receipt
  cannot grant an archive capability. Only explicit local operator unlock can.
- Secrets must not enter environment variables, command arguments, configuration,
  database rows, HTTP requests, logs, or readiness output. A launcher-owned
  one-shot operator input must be bounded and scrubbed after use.
- Use existing local custody/store admission and canonical database-backed
  recovery callbacks. Do not add permissive adapters or new crypto.
- No listener, readiness success, or restore worker before unlock and admission.
- Shutdown must close admission and drain BOTH accepted HTTP work and the worker
  before locking custody. A failed drain must not claim safe key disposal.
- Worker stop is terminal even before worker start. Failed boot is terminal;
  later calls must not silently report successful startup or retry implicitly.
- No capture cadence, retention period, coverage, or automatic key retirement
  is selected by this integration. Those remain explicit policy design inputs.

## Implementation Stages

1. Close the existing archive application terminal-state race, with red/green
   tests for stop-before-start, in-flight drain, failed boot, and OFF behavior.
2. Add launcher-owned async local configuration/unlock composition and post-drain
   custody ownership. Verify receipt/root admission, authentic capability, secret
   scrubbing, startup cancellation, and synthetic process restart.
3. Record capture-policy decisions separately, without enabling capture.

## Executable Local Entry

The dedicated entry is `packages/core-backend/scripts/start-recovery-local.mts`.
An approved local supervisor invokes Node directly with `--import tsx`, the script
path and one absolute nonsecret configuration path. It passes a local pipe or Unix
socket as FD 3, writes exactly 32 secret bytes, then closes its write side. Do not
launch through the `tsx` CLI or a package-manager wrapper: those can spawn a child
without forwarding FD 3. No secret is passed in arguments or environment.

The entry listens only on `127.0.0.1`; it does not inherit a wider `HOST`. Existing
JWT/owner authorization remains in force. This is not a customer deployment or a
remote operator-unlock API. `RECOVERY_LOCAL_CUSTODY_LOCKED` is a values-free status,
not readiness. Secret input has a maximum 60-second wait, requires EOF, and rejects
TCP, files and directories. Descriptor ownership begins only after pipe admission;
an absent FD 3 can be reused by libuv, so unknown non-pipe handles are not closed.

Configuration is an owner-private regular file, at most 8192 bytes. Its closed
fields are archivePath, custodyPath, custodyId, storeId, maxObjectBytes, receipt
(backupId/sha256/size), auditedReplayHorizonMs, asyncResumeHorizonMs,
workerIntervalMs, leaseMs, replayHorizonMs, sweepLimit and maxChunksPerRun. All are
mandatory; no capture or retention defaults are inferred. Existing provider
admission validates pre-provisioned roots; startup never provisions them.

The launcher alone owns its process shutdown handlers. A startup AbortSignal is
checked before initialization, listen, listening notification and worker start.
The application resolves revocation from the same authentic custody capability;
no independently supplied release callback can substitute for it. Old admission
release cannot revoke a later session epoch. Release requires a successful worker
drain, and the server invokes it only after the accepted HTTP and completion drains.

Implementation and focused synthetic process tests now exist. Full successful
launcher-to-HTTP recovery plus process restart against isolated PostgreSQL remains
a release gate; the prior injected-server and backup drill are not substitutes.
Capture policy is separately PROPOSED, not activated.
