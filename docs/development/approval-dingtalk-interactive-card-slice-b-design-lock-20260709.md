# 审批钉钉互动卡 Slice B · DESIGN-LOCK — 2026-07-09

> Status: **RATIFIED FOR B-1**. This document is a runtime design lock, not an implementation PR.
> It opens only because Slice A A-5 has PASS evidence in
> `approval-dingtalk-one-tap-a5-verification-20260705.md` §4.1.
> 2026-07-09 owner said "请继续"; B-1 may ship on the recommended defaults below.
> Runtime B-2..B-4 still ship as separate reviewed slices.

## 1. Goal

Slice A proved the action-card path:

`approval.task_created -> send_dingtalk_approval_card -> /m/approval-decision -> card-delivery wrapper -> approval action`.

Slice B removes the remaining extra page hop for the common happy path:

- Approve from the DingTalk card itself.
- Keep reject on the Slice A decision page, because reject comment is mandatory and card input widgets are not a discipline we want to bet on for v1.
- Update the same card to a terminal state after action, so repeated clicks converge to the current truth instead of creating parallel UI states.

## 2. Non-negotiable invariants inherited from Slice A

| Invariant | Slice B rule |
|---|---|
| Ledger-only anchor | `outTrackId` is exactly `dingtalk_approval_card_deliveries.id`; callback payload instance ids, sheet ids, form values, or amounts are ignored. |
| Unified action path | Callback execution must call `executeApprovalActionFromCardDelivery`; it must not call raw `/api/approvals/:id/actions` or duplicate approval-engine gates. |
| Identity fail-closed | DingTalk callback actor is accepted only after platform verification and active local-user mapping. Unmapped users get no action. |
| Values-free cards | Card body and callback handling must not carry form field values. Summary stays title/request/node/status level. |
| Idempotency | `card_state='sent' AND send_status='sent'` remains the only actionable ledger state. Duplicate callbacks re-read and return the real terminal state. |
| Audit | Successful actions still write `approval_records.metadata.channel='dingtalk_card'` and `cardDeliveryId=<delivery id>`. |

## 3. Scope

### In scope

1. Stream-mode DingTalk interactive-card worker, env-gated and disabled by default.
2. Interactive-card send/update helpers for approval cards only.
3. Callback adapter from DingTalk Stream event to `executeApprovalActionFromCardDelivery`.
4. Terminal card update after success, stale, duplicate, and fail-closed outcomes.
5. Real-DB and mocked-Stream verification matrix.

### Out of scope

1. HTTP callback mode. Stream mode is the v1 channel because it avoids public inbound endpoints and IP allowlists.
2. Inline reject comment collection. Reject button links to the existing Slice A page.
3. Group approval cards.
4. Feishu / WeCom adapters.
5. Conversational keyword replies such as "agree".
6. JSAPI `requestAuthCode` A-6 enhancement.

## 4. Runtime shape

### B-1 Stream worker

Add an optional worker registered only when all required Stream settings are present and the explicit enable flag is on.

Recommended env names:

| Env | Meaning |
|---|---|
| `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=1` | Explicit opt-in. Missing or false means no worker registration and no noisy warning loop. |
| `DINGTALK_INTERACTIVE_CARD_CLIENT_ID` | DingTalk Stream app client id, if distinct from the existing app key. |
| `DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET` | DingTalk Stream app secret, read from env or secret store only. |
| `DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID` | Interactive-card template id used by B-2 sends. |

If the existing DingTalk internal app credentials are sufficient for the Stream SDK in the deployed environment, B-1 may resolve these from the current DingTalk config store. That must be an explicit implementation choice in the PR body, not an implicit fallback.

Worker failure policy:

- Missing config: disabled, values-free info log at startup.
- SDK reconnects: delegated to DingTalk SDK.
- Callback handler throw: values-free error log with reason code and delivery id only; no card payload, no form data.
- Process shutdown: close Stream client if SDK exposes a close method.

### B-2 Interactive-card send

Add delivery kind `interactive_card` using the existing `dingtalk_approval_card_deliveries` table.

Send flow:

1. Resolve assignee DingTalk user id exactly as Slice A does.
2. Insert ledger row first with `delivery_kind='interactive_card'`.
3. Send interactive card with `outTrackId = delivery.id`.
4. Store provider card/task identifiers if the API returns them. If no stable provider id exists, the ledger id remains the only internal anchor.
5. On send failure, mark `send_status='failed'` with a redacted reason and leave `card_state='sent'` unreachable by `claimActed` because `send_status!='sent'`.

Card content:

- Title: approval title/request number.
- Body: node name/status level only.
- Buttons:
  - `同意`: Stream callback action, decision `approve`.
  - `驳回`: URL action to Slice A decision page, same signed `d`/`t` link shape.

The card must not include form field values in v1.

### B-3 Callback adapter

Callback input accepted by business logic:

```ts
type DingTalkApprovalCardCallback = {
  outTrackId: string
  action: 'approve'
  operatorDingTalkUserId: string
}
```

Everything else in the DingTalk event is transport metadata. It may be logged only as values-free reason/category fields.

Execution:

1. Validate `outTrackId` is a UUID-shaped delivery id.
2. Validate action is exactly `approve`; any other action is ignored with a terminal or no-op card update, never mapped heuristically.
3. Resolve `operatorDingTalkUserId` to active linked local user.
4. Call `executeApprovalActionFromCardDelivery(deliveryId, 'approve', { kind: 'dingtalk', dingtalkUserId })`.
5. Convert the wrapper result to a card update.

No raw `/actions` call is permitted. Add the same kind of static tripwire used by Slice A.

### B-4 Card terminal update

Card update is a presentation follow-up, not the source of truth. The source of truth remains the approval engine + ledger.

Update outcomes:

| Wrapper result | Card update |
|---|---|
| success approve | `已由 <display name> 同意 · <time>` |
| stale / duplicate | current true terminal state from summary |
| unmapped DingTalk user | `请先在网页端绑定钉钉后再处理` |
| non-recipient / permission denied | `当前账号无权处理该审批` |
| engine validation error | reason-coded failure copy, no values |
| card update API failure after successful action | do not roll back the approval; log values-free error and let duplicate clicks converge through stale summary |

Display names must come from server-side local user data, never from callback payload display text.

## 5. Security and privacy fences

1. **No payload trust**: Callback payload is not a source of instance, sheet, record, amount, or form data.
2. **No existence oracle beyond card ownership**: Unknown delivery and invalid/unsupported callback should not disclose whether an approval instance exists.
3. **No secret logging**: Stream credentials, signed deep-link tokens, and raw card payloads must not enter logs or docs.
4. **No mixed-channel actor spoofing**: HTTP sessions cannot set `{ kind:'dingtalk' }`; Stream callbacks cannot set a local user id directly.
5. **No state before engine success**: The ledger can be claimed only through the wrapper's action result discipline. If the approval action fails, the delivery must remain retryable unless the wrapper returns a true stale/terminal state.

## 6. Verification plan

### Unit / pure tests

- Callback parser accepts only `approve` and UUID-shaped `outTrackId`.
- Callback parser rejects unsupported actions without guessing.
- Card renderer is values-free and omits form fields.
- Static tripwire: callback code and card renderer do not import or contain raw `/api/approvals/:id/actions` path.

### Real-DB tests

- Linked recipient callback approves and writes `metadata.channel='dingtalk_card'` with the delivery id.
- Duplicate callback returns terminal summary and writes exactly one approve record.
- Unmapped DingTalk user fails closed and writes no approval record.
- Mapped but non-assignee user is rejected by the approval engine and writes no approval record.
- Pending/failed send rows are not actionable.
- Reject button path remains Slice A URL and does not attempt inline callback execution.

### Mocked Stream tests

- Worker disabled when env flag is absent.
- Worker registers when flag + credentials + template id are present.
- SDK event is converted to the callback adapter once.
- Handler error logs only reason code + delivery id.

### UAT

After B-1..B-4 merge behind the env gate:

1. Enable Stream env on the same DingTalk test app used by A-5.
2. Send an approval interactive card to a linked test recipient.
3. Tap `同意` in DingTalk.
4. Confirm approval record, ledger acted state, and in-place card terminal update.
5. Tap again and confirm the card stays terminal with no duplicate approval record.
6. Tap `驳回` on a fresh card and confirm it opens the Slice A decision page with comment-required behavior.

## 7. Owner decisions before runtime

Recommended defaults are marked `RECOMMENDED`; changing any of these is a product/security choice, not an implementation detail.

| Decision | Recommended default |
|---|---|
| B1 env shape | `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=1` plus explicit Stream credentials/template id. |
| B2 reject handling | `同意` inline; `驳回` jumps to Slice A page. |
| B2 card body | values-free title/request/node/status only. |
| B3 callback action set | approve-only in v1. |
| B4 card update failure | action remains committed; log and allow stale refresh on next click. |
| UAT gate | real DingTalk Stream UAT required before declaring Slice B shipped. |

## 8. Implementation order

1. **B-1** Stream worker skeleton + env gate, no business action.
2. **B-2** interactive-card send path, ledger kind `interactive_card`, no callback execution yet.
3. **B-3** callback adapter -> wrapper -> engine action.
4. **B-4** terminal card update + duplicate/stale convergence.
5. Closeout MD with CI evidence and real DingTalk Stream UAT result.

Do not combine this with unrelated approval UX work. This slice touches an external callback channel and must stay narrow.
