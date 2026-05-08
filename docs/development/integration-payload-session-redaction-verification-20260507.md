# Integration Payload Session Redaction Verification

## Commands

```bash
pnpm --dir plugins/plugin-integration-core run test:payload-redaction
pnpm --dir plugins/plugin-integration-core run test:pipeline-runner
git diff --check
```

## Local Result

- `pnpm --dir plugins/plugin-integration-core run test:payload-redaction`:
  passed.
- `pnpm --dir plugins/plugin-integration-core run test:pipeline-runner`:
  passed.
- `git diff --check`: passed.

## Covered Cases

The payload redaction unit suite now covers:

- existing credential key redaction for `Authorization`, `x-api-key`, `password`,
  `token`, `cookie`, and `rawPayload`;
- new session aliases: `JSESSIONID`, `connect.sid`, `sid`, and `X-Session-Id`;
- nested header and cookie object redaction;
- long string truncation;
- payload byte cap behavior;
- circular reference handling;
- unsafe prototype-pollution keys are skipped and sanitized objects use null
  prototypes.

## Residual Risk

This is a redaction-key expansion. It does not parse raw cookie strings into
individual cookie names; payloads that store all cookies under the existing
`cookie` key are already fully redacted.
