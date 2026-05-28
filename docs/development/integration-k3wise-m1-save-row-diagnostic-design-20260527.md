# K3 WISE M1 Save Row Diagnostic Design - 2026-05-27

## Purpose

After the second M1 Material Save-only attempt, the live K3 response still failed the row-level success gate while surfacing only the envelope-level message `Successful`. That wording is misleading for the operator: the write did not pass, but the dead letter reads like a success.

This change improves diagnostics only. It does not approve another Save-only attempt and does not change the Save success criteria.

## Scope

- Keep the existing row-level success gate unchanged.
- When a Save response fails row-level success but the only response message is success-like, replace the dead-letter message with a structural failure summary.
- Preserve useful K3 validation messages when they exist, such as row-level `FMessage`.
- Keep diagnostics redacted and structural: row count, successful row count, failed row count, success entity count, envelope status, and envelope message presence.

## Non-goals

- No third M1 Save-only approval.
- No Submit, Audit, BOM, list/search, pagination, multi-record, production, or direct K3 SQL work.
- No raw K3 payload persistence.
- No customer dictionary/default population. The missing `bodyTemplate` / field-mapping configuration remains an operator/customer configuration track.

## Behavior

For a failing Save response:

1. Prefer explicit row-level or configured failure messages.
2. If the message is success-like, for example `Successful`, synthesize:

```text
K3 WISE save failed row-level success gate
```

with bounded structural counts.

This keeps dead letters actionable without exposing raw material identifiers, K3 codes, tokens, endpoint details, or connection strings.

## Boundary

This PR is allowed to touch only the K3 WebAPI adapter diagnostics and its tests. It is not a product-level K3 standardization step. The next live write still requires a separate fresh approval after the entity machine preview proves the customer-profile Material fields are present.
