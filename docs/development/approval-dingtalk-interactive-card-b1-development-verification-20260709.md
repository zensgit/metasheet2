# 审批钉钉互动卡 · B-1 Stream worker skeleton 开发与验证 — 2026-07-09

> Parent lock: `approval-dingtalk-interactive-card-slice-b-design-lock-20260709.md`.
> Owner said "请继续" after A-5 PASS and B-0 design-lock merge; this PR implements only **B-1**.

## 1. Scope

B-1 establishes the optional DingTalk interactive-card Stream worker boundary:

- env-gated startup;
- explicit Stream config resolver;
- injectable SDK/client adapter seam;
- server lifecycle startup/shutdown wiring;
- values-free failure logs.

It deliberately does **not** send interactive cards, parse approval callback payloads, call
`executeApprovalActionFromCardDelivery`, or update cards in place. Those stay B-2/B-3/B-4.

## 2. As-built

| Piece | File | Behavior |
|---|---|---|
| Config resolver | `packages/core-backend/src/integrations/dingtalk/interactive-card-stream.ts` | Requires explicit `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=1`/`true` plus client id, client secret, and template id. Missing anything returns disabled with a reason code. |
| Worker skeleton | same file | Calls an injected `clientFactory` only when fully configured; otherwise no Stream registration and no warning loop. |
| Default factory | same file | Throws `DINGTALK_INTERACTIVE_CARD_STREAM_SDK_UNWIRED`; this is intentional until the real SDK adapter lands. B-2 classifies this separately as `sdk_unwired`, while real adapter failures remain `client_start_failed`. |
| Event handler | same file | Logs a values-free "ignored by B-1 skeleton" message. No business callback parsing. |
| Server lifecycle | `packages/core-backend/src/index.ts` | Instantiates the worker during startup and shuts it down with the other optional services. Default env keeps it disabled. |

## 3. Env contract

| Env | B-1 behavior |
|---|---|
| `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` | Only `1` or `true` enables registration. Missing/other values disable the worker. |
| `DINGTALK_INTERACTIVE_CARD_CLIENT_ID` | Required when enabled. |
| `DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET` | Required when enabled; never logged. |
| `DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID` | Required when enabled. |

This PR does not reuse the existing work-notification app credentials implicitly. The parent lock allows that as a future explicit implementation choice, but B-1 keeps the boundary narrow and reviewable.

## 4. Verification

Unit tests: `packages/core-backend/tests/unit/dingtalk-interactive-card-stream.test.ts`

Covered cases:

1. default disabled state reports `env_disabled` and does not call the client factory;
2. enabled flag with partial config fails closed by missing setting reason;
3. full config calls the injected client factory and starts the client;
4. B-1 event handler ignores events without invoking any approval action path;
5. shutdown closes the injected client;
6. default factory reports `sdk_unwired`; a real client-factory failure reports `client_start_failed`;
7. a client whose `start()` fails is best-effort closed without logging SDK error text or secrets;
8. concurrent/repeated initialization starts the client exactly once.

## 5. Next slices

- **B-2**: interactive-card send path + `delivery_kind='interactive_card'`.
- **B-3**: callback adapter -> `executeApprovalActionFromCardDelivery`.
- **B-4**: card terminal update + duplicate/stale convergence.

Do not declare Slice B shipped until B-1..B-4 plus real DingTalk Stream UAT pass.
