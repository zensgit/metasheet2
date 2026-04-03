# Attendance Run 30 Contract Follow-up Design

## Goal

Reduce manual-test `400` responses that come from unclear create/generate request bodies without widening the attendance domain model.

## Scope

1. Accept a small set of compatibility aliases that match recent test/operator expectations.
2. Add concrete OpenAPI examples for request creation, approval flows, rotation rules, and payroll cycle create/generate.
3. Publish one short quickstart doc that testers can copy directly when they need to validate shift delete guards and other admin flows.

## Runtime Changes

### Rotation Rules

- Continue supporting canonical `shiftSequence`.
- Also accept:
  - `shift_sequence`
  - `shiftIds`
  - `shift_ids`
- Accept these aliases as arrays, JSON-array strings, or comma/newline-delimited strings.

### Payroll Cycles

- Continue supporting canonical `templateId`.
- Also accept:
  - `template_id`
  - `payrollTemplateId`
  - `payroll_template_id`
- Continue supporting canonical `anchorDate`, `startDate`, `endDate`, `namePrefix`.
- Also accept:
  - `anchor_date`
  - `start_date`
  - `end_date`
  - `name_prefix`
- Accept JSON-string metadata for manual callers.

## Non-goals

- No attendance business-rule expansion.
- No CSV export implementation.
- No change to request approval state machine.

## Expected Outcome

- Manual testers can create rotation rules and payroll cycles using the field names they are already trying.
- Shift delete guard can be validated end-to-end without guessing request payload shape.
- Public-facing contract examples better reflect what the runtime actually accepts.
