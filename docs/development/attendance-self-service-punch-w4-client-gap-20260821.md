# Attendance: the self-service punch client is not a W4 client (architectural note)

Status: **FINDING — informational, no decision taken.** This note records a
structural fact discovered while planning a human-traffic validation round. It
authorizes nothing and proposes no change.

- Baseline: `5e9a15f02e7f3971b34f3b768c064cd27491d947`.
- Why it is written down: the fact is not obvious from either side alone, and it
  silently invalidates any plan of the form "have real people exercise the W4/W7
  calculation path through the web UI". It cost one 24-hour validation window
  before it was understood; it should not have to be rediscovered.

## The fact

1. The web self-service punch sends a body of `{ eventType, timezone, orgId? }`
   (`apps/web/src/views/AttendanceView.vue`, punch call site). It never sends
   `operationId`: the browser is not an authoritative W4 client and has no identity
   to mint one from.
2. In the write boundary
   (`packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts`, the
   `input.operationId === null` branch): a null-`operationId` punch is served by the
   legacy adapter **only** when the org's write posture is `legacy_projection_only`.
   For any other posture it falls through to the operation-registry protocol, which
   fails closed **before any source DML**.
3. *Which* fail-closed it hits depends on the org, and the org a browser punch
   actually resolves to is `'default'` (it sends no `orgId`; see the companion lock).
   The registry builds the org identity **before** it checks the operation id —
   `createVerifiedAttendanceOrgIdentityV1` at `w4c0-operation-registry.ts:616`, the
   operation-id guard at `:630` — so for `'default'` under a non-legacy posture the
   first failure is `W4C0_DEFAULT_ORG_POSTURE_REJECTED`
   (`w4c0-identity.ts:~575`), not `W4C0_OPERATION_ID_REQUIRED`. The latter is
   reached only by a canonical-UUID org under a W4 posture.
4. **And that failure does not surface as a typed 4xx.** The plugin's `W4_ERROR_NAMES`
   map (`plugins/plugin-attendance/index.cjs:25249-25274`) does not list
   `AttendanceW4IdentityError`, so the error falls through to the generic handler
   (`:30213`) and the caller sees **`500 INTERNAL_ERROR`** with the typed code
   swallowed. Anyone debugging this by looking for a 422 will find an opaque 500 and
   reasonably conclude their environment is broken — which is the exact wasted cycle
   this note exists to prevent, so it is stated here rather than left to be
   rediscovered. (The unmapped error class is a separate defect, noted below.)
5. Therefore, for an org whose W4 posture has advanced beyond legacy, a browser punch
   does not produce a calculation row — it fails closed and writes nothing.

## What follows

- Human traffic through the current web UI can exercise the **legacy** attendance
  path only. It cannot, on any org, produce W4/W7 shadow calculation rows.
- Synthetic load tooling reaches those rows because it mints a stable
  `operationId` per punch, i.e. it acts as a W4 client. That is a property of the
  tool, not of "traffic being real".
- Consequently, "real users exercising the W4/W7 machine" is not a thing the
  system can currently be asked to do, and an acceptance criterion phrased that
  way is unsatisfiable under the present client contract rather than merely unmet.

## The options, if that capability is ever wanted

Recorded for completeness; **none is chosen here**, and none should be adopted as
a way to satisfy a validation gate:

- **A.** Make the self-service front-end an authoritative W4 client (it would have
  to mint and carry a stable `operationId`). This is a W4 rollout and client-identity
  decision with idempotency implications, not a UI change.
- **B.** Accept that human validation covers the legacy/self-service path, and that
  the W4/W7 machine is validated by tooling that is a W4 client.
- **C.** Drive a human-initiated leg through a non-browser client that already
  carries an `operationId`.

Note on A: having the browser generate a random UUID per punch would mechanically
pass the guard while adding no evidence — the guard exists to bind a punch to a
replayable operation identity, and a value invented per attempt does not do that.
Anything in this direction belongs in a W4 lock amendment, not in a validation
workaround.

## Adjacent defect, recorded here because this note is where it was found

`AttendanceW4IdentityError` is absent from `W4_ERROR_NAMES`
(`plugins/plugin-attendance/index.cjs:25249-25274`), so every typed fail-closed code
that class carries reaches the caller as a raw `500 INTERNAL_ERROR`. That contradicts
the doctrine the surrounding code states in its own words (`:25267-25272`), and it is
worth its own ticket before anyone runs a W4 staging round — a fail-closed guard whose
reason is swallowed is much harder to operate than one that says why.
