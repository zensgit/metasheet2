# Attendance Record Timeline Suggestion Design

## Goal

Make the raw punch timeline detail row self-explanatory before the operator clicks into the request form.

The previous slice already inferred the right request type internally, but the UI still hid that inference until the operator clicked the CTA. This slice surfaces the suggestion inline and keeps the CTA text aligned with it.

## Scope

1. Show the inferred request type directly in the expanded timeline detail row.
2. Update the CTA label to match the inferred request type.
3. Keep the existing bridge behavior unchanged.

## Design

### 1. Surface the inference where the operator is already looking

After reviewing raw punches, the operator should immediately see:

- what kind of correction the system suggests
- what action the CTA will take

So the detail row now renders:

- `Suggested request: ...`
- a matching CTA label such as `Use as Missed check-out`

### 2. Keep the implementation local

The slice reuses the existing inference function and only adds:

- one small formatter for CTA text
- one displayed suggestion line

No backend or routing changes are needed.

## Non-goals

- No new request inference rules
- No change to request submission
- No extra analytics or logging
