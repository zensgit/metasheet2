# Integration Payload Session Redaction Development

## Context

`sanitizeIntegrationPayload()` is used by integration dry-run previews,
dead-letter payloads, REST responses, and other operator-visible evidence paths.
It already redacts broad credential keys such as `authorization`, `cookie`,
`password`, `token`, and `sessionId`.

The key normalizer strips punctuation and lowercases names, but the sensitive
key set did not include common session cookie/header names:

- `JSESSIONID`
- `connect.sid`
- `sid`
- `X-Session-Id`

Those values can appear when K3 WISE, ERP, PLM, or generic HTTP adapters expose
parsed cookies/headers in payloads or error details.

## Change

Extended `SENSITIVE_PAYLOAD_KEYS` with normalized session aliases:

- `connectsid`
- `jsessionid`
- `sid`
- `xsessionid`

The existing key normalizer means these cover punctuation/case variants such as
`connect.sid`, `JSESSIONID`, and `X-Session-Id`.

## Scope

Changed files:

- `plugins/plugin-integration-core/lib/payload-redaction.cjs`
- `plugins/plugin-integration-core/__tests__/payload-redaction.test.cjs`

No REST route, run-log, external-system registry, adapter, workflow, database,
or frontend code is changed.
