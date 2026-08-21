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
   `operationId` — deliberately: the browser is not an authoritative W4 client and
   has no identity to mint one from.
2. In the write boundary
   (`packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts`, the
   `input.operationId === null` branch, ~:2024-2036): a null-`operationId` punch is
   served by the legacy adapter **only** when the org's write posture is
   `legacy_projection_only`. For a W4-postured org it falls through to the
   operation-registry protocol, which fails closed with
   `W4C0_OPERATION_ID_REQUIRED` **before any source DML**.
3. Therefore, for an org whose W4 posture has advanced beyond legacy, a browser
   punch does not produce a calculation row — it produces a 422 and writes nothing.

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
