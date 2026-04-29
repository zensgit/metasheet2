# Wave M-Feishu-3 Send Email Automation Design

Date: 2026-04-29

## Scope

Wave M-Feishu-3 adds a first-class automation action type, `send_email`, for rule authors who need static email delivery from automation rules.

This slice intentionally reuses the existing `NotificationService.send()` email channel. It does not add SMTP, SendGrid, SES, or any other real email provider integration. Provider wiring remains outside this PR.

## Backend Contract

`send_email` action config:

```json
{
  "recipients": ["ops@example.com"],
  "subjectTemplate": "Record {{record.title}} changed",
  "bodyTemplate": "Status: {{record.status}}"
}
```

Validation happens in `AutomationService` for both legacy single-action fields and V1 `actions[]`:

- at least one static recipient is required
- `subjectTemplate` is required
- `bodyTemplate` is required

Execution happens in `AutomationExecutor`:

- renders templates with `sheetId`, `recordId`, `actorId`, and `record`
- calls `notificationService.send({ channel: 'email', ... })`
- treats `NotificationService` result status `failed` as action failure
- fails clearly when `notificationService` is not injected

## Frontend Contract

`MetaAutomationRuleEditor` exposes a `Send email` action with:

- static recipients textarea, comma or newline separated
- subject template
- body template

Save is disabled until the action has at least one recipient and both templates. The saved payload is normalized to deduplicated `recipients[]`, trimmed `subjectTemplate`, and trimmed `bodyTemplate`.

## Capability Boundary

The current runtime capability is only as strong as the existing NotificationService email channel. In this repository, that channel is the abstraction point for email delivery. Real provider configuration, retries beyond the channel implementation, bounce handling, and operational email credentials are not part of Wave M-Feishu-3.
