# Yjs DingTalk Trial Send Development

Date: 2026-04-19

## Scope

This slice sends the prepared Yjs human-collaboration trial notice to the real
DingTalk group after the operator provided:

- a full DingTalk robot webhook URL
- a matching robot signing secret

## Why This Was Needed

Earlier inspection confirmed that:

- the remote rollout host was already on the latest `main`
- the app had DingTalk OAuth and a registered DingTalk notification channel
- but there was no pre-bound outbound webhook/group recipient stored in app
  data

So the missing piece for actual delivery was not code sync, but a real robot
target.

## Implementation

Used the same signing algorithm already implemented in
`packages/core-backend/src/services/NotificationService.ts`:

- HMAC-SHA256 over `timestamp + "\\n" + secret`
- URL-encoded base64 signature
- appended `timestamp` and `sign` query parameters to the provided webhook URL

The outbound payload used DingTalk markdown with:

- Yjs internal trial title
- role assignment table
- rollout environment summary
- scenario checklist
- exception reporting template

## Outcome

The real DingTalk send succeeded:

- response `statusCode=200`
- response `errcode=0`
- response `errmsg=ok`

The operations message document was then updated with a delivery record so the
trial package now shows that the group notification was already sent once.
