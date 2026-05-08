# Integration Core Dead-Letter Communication API Design - 2026-05-07

## Context

`plugin-integration-core` already exposes dead-letter list and replay workflows
over REST:

- `GET /api/integration/dead-letters`
- `POST /api/integration/dead-letters/:id/replay`

The cross-plugin communication namespace still stopped at external systems,
pipelines, runner, and staging operations. That left a gap for future packaged
integration UI plugins: they could launch runs through `integration-core`, but
could not inspect or replay failed records without using the HTTP route layer.

## Scope

This slice adds a narrow communication surface in
`plugins/plugin-integration-core/index.cjs`:

- `listDeadLetters(input)`
- `getDeadLetter(input)`
- `replayDeadLetter(input)`

It also extends `getStatus()` with:

- `deadLetters`
- `deadLetterReplay`

## Security Contract

Dead-letter records can contain PLM or ERP business payloads. The communication
namespace is plugin-to-plugin, not per-user HTTP, so the default contract is
metadata-first:

- `listDeadLetters()` strips `sourcePayload` and `transformedPayload`.
- `getDeadLetter()` strips `sourcePayload` and `transformedPayload`.
- `replayDeadLetter()` delegates to the runner, then strips payload fields from
  the returned `deadLetter` object.
- All returned dead-letter records include `payloadRedacted: true`.

The underlying `dead-letter.cjs` validators still own tenant/workspace/id input
validation. The communication layer only adds initialization checks and output
redaction.

## Non-Goals

- No HTTP route changes.
- No new database tables or migrations.
- No change to runner replay behavior or dead-letter persistence semantics.
- No payload opt-in flag in the communication namespace. Any plugin that truly
  needs payload inspection should go through a separately reviewed contract.

## Files Changed

- `plugins/plugin-integration-core/index.cjs`
- `plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs`
- `docs/development/integration-core-dead-letter-communication-api-design-20260507.md`
- `docs/development/integration-core-dead-letter-communication-api-verification-20260507.md`

## Expected Impact

This is a small control-plane completion slice. It improves readiness for an
independent integration UI/plugin package while keeping payload exposure tighter
than the existing internal store object.
