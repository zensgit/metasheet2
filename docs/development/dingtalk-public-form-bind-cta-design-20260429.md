# DingTalk Public Form Bind CTA Design - 2026-04-29

## Goal

When a signed-in local user opens a DingTalk-protected public multitable form but
has not bound a DingTalk identity, the form should provide a direct recovery
action instead of a dead-end error message.

Before this slice, `DINGTALK_BIND_REQUIRED` displayed only static copy. Users
had to know to leave the form, bind DingTalk elsewhere, and then return to the
same public form link.

## Scope

Updated frontend view:

- `apps/web/src/views/PublicMultitableFormView.vue`

Updated frontend test:

- `apps/web/tests/public-multitable-form.spec.ts`

## Behavior

`DINGTALK_AUTH_REQUIRED` remains unchanged:

- anonymous users are redirected through `GET /api/auth/dingtalk/launch`;
- the current public form URL is passed as `redirect`.

`DINGTALK_BIND_REQUIRED` now renders:

- the existing error text: `This form only accepts users with a bound DingTalk account.`;
- a CTA: `Bind DingTalk and return to this form`;
- a launch call to `GET /api/auth/dingtalk/launch?intent=bind&redirect=<current-public-form-url>`.

The bind launch uses `suppressUnauthorizedRedirect: true` so the public form
view owns the error state instead of being silently redirected by the generic API
client. If launch fails, the user stays on the public form and the bind CTA is
shown again with a launch failure message.

## Non-goals

- This does not change backend access rules for `public`, `dingtalk`, or
  `dingtalk_granted` modes.
- This does not change password-change bypass behavior; current main already
  allows public-token form context and submit requests to continue through the
  DingTalk public form path.
- This does not change selected-user or member-group allowlist evaluation.
- This does not store or expose any DingTalk token, webhook, or signing secret.
