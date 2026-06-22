# Design-lock (PROPOSED): Attendance notification — SMTP email delivery channel

> **Scope**: add a second concrete delivery channel (SMTP email) to the already-shipped pluggable
> attendance-notification delivery seam, so attendance notifications (unscheduled-punch reminder,
> schedule-dispatch, etc.) can reach recipients over email — not only the in-app work-notification
> channel. **Reliability/coverage**, not a new producer.
> **Grounding**: `origin/main`. Reuses: the `AttendanceDeliveryChannel { name; send(message) }` seam +
> `createAttendanceDeliveryChannelsFromEnv` factory + `AttendanceNotificationDeliveryWorker` (lease /
> backoff / retry / dead-letter) in `services/AttendanceNotificationDeliveryWorker.ts`; the SMTP
> transport + readiness from `services/email-transport-readiness.ts` + `NotificationService.ts`
> (`EmailSmtpTransport`, nodemailer wrapper).
> **Why a design-lock (not just-build)**: the adapter itself is decision-free, BUT a *useful* email
> channel needs a **producer-routing product decision** (§3) — how a delivery row gets
> `channel='email_smtp'`. That decision is the owner's; this doc surfaces it. MetaSheet's own 口径; no
> competitor framing.

---

## 1. The decision — what v1 is, and why it is small

The delivery seam is already pluggable: the worker reads `attendance_notification_deliveries` rows and
routes each to `channelsByName.get(row.channel)`; channels are produced by an env factory. v1 of the
first channel shipped as in-app work-notification only. **This lock adds one more `AttendanceDeliveryChannel`
implementation — SMTP email — env-gated, coexisting via name-routing.** No new worker, no new producer,
no schema change for the adapter itself.

| Slice | What | Cost | Decision-status |
|---|---|---|---|
| **S1 — adapter foundation** (this lock's buildable core) | `EmailAttendanceDeliveryChannel implements AttendanceDeliveryChannel`; env-gated registration; recipient-email resolution; SMTP send via the existing transport; failure classification; tests | small (~adapter + tests) | **decision-free → build after 拍板** |
| **S2 — producer routing** | how a delivery row is assigned `channel='email_smtp'` (so email is actually exercised end-to-end) | medium | **needs owner 拍板 (§3)** |

S1 is the foundation (useful for any routing); S2 wires it. S1 mirrors the bottom-up pattern used
elsewhere (build + adversarially test the channel, then wire the producer).

## 2. Contract — the email adapter (S1)

- **Name**: `EMAIL_SMTP_CHANNEL_NAME = 'email_smtp'` (a new channel-name constant beside the existing work-notification channel's, in `AttendanceNotificationDeliveryWorker.ts`).
- **Impl**: `class EmailAttendanceDeliveryChannel implements AttendanceDeliveryChannel`. `send(message)`:
  1. **Resolve recipient email — PINNED (S1, #3018): `users.email` scoped to the delivery org.** The query
     is `users u JOIN user_orgs uo ON uo.user_id=u.id AND uo.org_id = message.orgId AND uo.is_active WHERE
     u.id = message.recipientUserId AND u.is_active`. This is the **tenant boundary** (email is external
     egress; the deliveries table does not prove recipient↔org membership, so a bare `users.id` lookup could
     send cross-tenant). **Fail-closed**: no active org-member row (inactive / not a member of this org /
     no email) → `{ ok:false, retryable:false }`, do NOT send — dead-letters, never spins. (A DB lookup
     *error* is `retryable:true`.)
  2. **Build subject/body** from `message.payload` via the existing `buildDeliveryTitle`/`buildDeliveryContent`
     helpers (shared with the in-app channel — one content source, no per-channel drift).
  3. **Send** via the existing `EmailSmtpTransport` (nodemailer wrapper) using the
     `EmailSmtpTransportConfig` already read from `MULTITABLE_EMAIL_SMTP_*` (`email-transport-readiness.ts`).
     **No new SMTP config surface; reuse the one the app already has.**
  4. **Classify failure** into the seam's `{ ok:false, retryable, error }`:
     - **retryable** = transient transport (ECONNREFUSED / ETIMEDOUT / socket / SMTP 4xx greylisting).
     - **non-retryable** = config/auth invalid, SMTP 5xx permanent, malformed/absent recipient email.
     This is the load-bearing correctness point — a misclassification either spins a dead message (retryable
     when it's permanent) or drops a deliverable one (non-retryable when it's transient).
- **Redaction**: the email body is the same content the in-app channel already sends; the delivery
  record / logs must not add the recipient's raw email beyond what the existing observability stores
  (reuse the existing delivery-record redaction; do not introduce a new PII surface).

## 3. Producer routing — THE owner decision (S2)

A delivery row's `channel` is set by the **producer** (the enqueue path, outside the worker). Today it
is the single in-app channel. For email to be *used*, the producer must assign `channel='email_smtp'`
to some rows. **Three options — owner picks:**

| Option | Behavior | Pro | Con |
|---|---|---|---|
| **(a) per-user channel preference** | each user chooses their channel(s) | most user-respecting | needs a preference UI + store; heaviest |
| **(b) fan-out to all enabled channels** | every notification enqueued once per enabled channel | simplest coverage; no new config | duplicate notifications (in-app **and** email) — may annoy |
| **(c) per-org default channel (+ per-user override later)** *(recommended)* | org admin sets the default delivery channel; user override is a future slice | clean v1, one config point, no dupes; extensible to (a) | needs a small per-org config |

**Recommendation: (c)** — a per-org default channel config (env or org-setting), defaulting to the
existing in-app channel so behavior is unchanged until an admin opts an org into email. This is the
"safe default + explicit opt-in" 口径 and avoids the (b) duplicate-notification annoyance. **Owner 拍板
before S2 is built.**

## 4. Env-gate (reuse the existing readiness — no per-tick warn noise)

Register the email channel in `createAttendanceDeliveryChannelsFromEnv` **only when SMTP is actually
configured** — gate on `email-transport-readiness`'s required-env set (`MULTITABLE_EMAIL_SMTP_HOST/PORT/
USER/PASSWORD/FROM`) being present (optionally behind an explicit `ATTENDANCE_NOTIFICATION_EMAIL_ENABLED`
flag, mirroring the existing channel flags). **Default-off**; an unconfigured deploy registers nothing
(honors the env-gate-side-effect-channels rule: optional channels register only when env-configured, else
they produce per-tick warn noise under at-least-once retry). The factory **accumulates** channels
(returns all enabled), so email coexists with the in-app channel via name-routing — a minor change from
today's first-match-return, justified because the worker already routes by `row.channel` name.

## 5. Boundaries / non-goals

- **S1 only after 拍板; S2 (producer routing) only after the §3 decision.** No producer change in S1.
- **SMTP email only** — SMS / other enterprise-IM / other channels are separate future adapters on the same seam
  (each its own env-gated impl + opt-in), not this lock.
- **No new SMTP config / transport** — reuse the app's existing email transport + readiness verbatim.
- **No content change** — same `buildDeliveryTitle/Content`; no per-channel content fork.
- **No new producer / notification type** — this is a delivery *channel*, not a new reminder.

## 6. Verification plan (S1)

- adapter unit tests (mock the SMTP transport + the recipient-email query):
  - 2xx send → `{ ok:true }`; delivery-record written without raw-PII leak beyond existing.
  - transient transport error → `{ ok:false, retryable:true }` (re-leased by the worker).
  - permanent 5xx / auth-invalid / **absent recipient email** → `{ ok:false, retryable:false }` (dead-letters; no spin).
  - **env-gate**: SMTP env absent → factory does NOT register the email channel (no channel, no warn noise);
    SMTP env present (+ flag) → channel registered and coexists with the in-app channel.
  - content parity: subject/body come from the shared `buildDeliveryTitle/Content` (no per-channel drift).
- integration (real-DB worker): an `email_smtp` delivery row is leased → sent (mock transport) → marked
  delivered; a permanent failure → dead-lettered, not retried forever.

## 7. Governance

design-lock → **owner 拍板**（incl. §3 routing choice）→ build S1 (adapter + env-gate + tests, PR-not-merge)
→ S2 (producer routing per the §3 pick) → staging smoke → backfill the benchmark tracker. Each slice is a
separate opt-in. MetaSheet's own 口径; the runtime design-lock carries no competitor names.
