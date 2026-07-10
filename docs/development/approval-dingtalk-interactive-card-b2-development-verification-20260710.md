# 审批钉钉互动卡 · B-2 投放链开发与验证 — 2026-07-10

> Parent lock: `approval-dingtalk-interactive-card-slice-b-design-lock-20260709.md`.
> Owner said "continue" after the B-1 review. This slice implements **send only**;
> B-3 callback execution and B-4 in-place terminal updates remain locked.

## 1. Scope and runtime gate

B-2 adds the interactive-card branch to the existing
`send_dingtalk_approval_card` automation action. The branch is selected only when
`DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` is explicitly `1`/`true` and the Stream client id,
client secret, and template id are all present. Any missing setting preserves the existing
`work_notice_action_card` path.

The merged runtime must remain **flag-off** until B-3, B-4, and real DingTalk Stream UAT pass.
The default Stream factory is still intentionally `sdk_unwired`; B-2 does not make a dead approve
button production-ready merely by making the send request available.

## 2. As-built

| Piece | Behavior |
|---|---|
| Send API | `POST /v1.0/card/instances/createAndDeliver` with the Stream app token. The request follows DingTalk's direct `imRobotOpenSpaceModel` / `imRobotOpenDeliverModel` shape and lower-case `dtv1.card//im_robot.<userId>` space id. |
| Ledger anchor | The row is inserted first with `delivery_kind='interactive_card'`; `outTrackId` is exactly that row's id. The mainline `integration_id` remains attached for same-corp link-secret verification. |
| Card content | Title, request number, node, status, button labels, and the signed Slice-A reject URL only. Form values and the approval instance id are absent. |
| Actions | Approve is template-owned Stream callback metadata for B-3. Reject stays a signed `/m/approval-decision` URL because a comment is mandatory. |
| Provider result | A provider `carrierId` is stored as `task_id`. HTTP 200 is not sufficient: top-level failure, an empty delivery result, or any failed delivery raises a typed business error and leaves the ledger `send_status='failed'`. |
| Legacy path | Flag-off and partial-config runs still use the existing OA ActionCard, per-integration app credentials, and the same per-corp signed deep link. |

The request contract was checked against DingTalk's official
[`createAndDeliver` documentation](https://open.dingtalk.com/document/development/create-and-deliver-cards)
and its generated `card_1_0` SDK model before the tests were pinned.

## 3. B-1 hardening carried with B-2

The B-1 review left three non-blocking tails. They are closed here before a real SDK adapter lands:

1. a half-started client is best-effort closed when `start()` throws;
2. concurrent or repeated `initialize()` calls share one start attempt;
3. the intentional default factory failure reports `sdk_unwired`, distinct from a real
   `client_start_failed`, without logging provider error payloads or credentials.

## 4. Verification

- Backend type-check: `tsc --noEmit` clean.
- Unit: `dingtalk-interactive-card-stream.test.ts` + `dingtalk-work-notification.test.ts`, 16/16.
- Real DB: `automation-dingtalk-approval-card-action.test.ts`, 10/10 on an ephemeral database
  migrated with the same exclusion list as `plugin-tests.yml`.
- Mutation proof: forcing the runtime branch back to the OA path makes the focused B-2 real-DB
  golden fail on `work_notice_action_card` vs `interactive_card`; restoring the branch returns green.
- Existing CI wiring is reused: both unit files are already in normal discovery and the real-DB
  file is excluded from the no-DB run and listed whole-file in the multitable real-DB step.

The real-DB golden proves both directions: default env sends the byte-compatible OA ActionCard,
while complete opt-in config writes an `interactive_card` ledger row, uses its id as `outTrackId`,
stores the provider carrier id, retains `integration_id`, and emits no instance id or form value.

## 5. Explicitly not shipped

- no real Stream SDK adapter;
- no callback payload parser or approval action execution (B-3);
- no in-place terminal/stale card update (B-4);
- no claim that Slice B has passed live DingTalk UAT.

The next slice must wire the official Stream SDK, accept only the ratified approve callback shape,
and call `executeApprovalActionFromCardDelivery` without introducing a parallel approval path.
