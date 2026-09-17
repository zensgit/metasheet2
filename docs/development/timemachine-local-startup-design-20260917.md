# Local Custody Startup Integration

Base: `23dfdf417686b931a515bf03abbce1d6471c3098`.

Owner authorized isolated development and synthetic verification. No flag
activation, customer storage, deployment, dispatch, or production access.

## Contract

- Existing exact-true archive and writer-fence gates remain unchanged. The OFF
  path must not read local configuration, storage, secrets, or database state.
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

Stage 1 alone is not standard local startup integration. Existing server entry
still requires explicit composition; stages 2 and 3 remain incomplete until
their executable gates and evidence are recorded.
