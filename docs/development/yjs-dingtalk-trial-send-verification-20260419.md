# Yjs DingTalk Trial Send Verification

Date: 2026-04-19

## Verification Method

Verification focused on confirming that a real DingTalk group notification could
be sent successfully with the operator-provided webhook URL and signing secret.

## Command Run

Executed a one-off Node script that:

- generated a DingTalk signed webhook URL using HMAC-SHA256
- posted the prepared markdown trial notice
- printed only the response status and DingTalk result code

## Result

- send timestamp: `2026-04-19 17:17:09 CST`
- HTTP status: `200`
- DingTalk `errcode`: `0`
- DingTalk `errmsg`: `ok`

## Verified Outcome

- the provided webhook URL and secret are valid together
- the target DingTalk group accepted the Yjs trial notice
- no further remote code synchronization was required before sending
- the operations message document now includes the delivery record
