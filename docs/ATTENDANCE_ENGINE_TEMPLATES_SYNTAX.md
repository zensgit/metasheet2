# Attendance Engine Templates Syntax

This note captures the minimum shape that the attendance rule preview and custom template flow expect today.

## Minimal rule template shape

Custom rules live under:

```json
{
  "engine": {
    "templates": [
      {
        "name": "用户自定义",
        "rules": [
          {
            "id": "unique_rule_id",
            "when": {},
            "then": {}
          }
        ]
      }
    ]
  }
}
```

## Required keys per rule

- `id`: unique stable identifier for the rule
- `when`: the match condition object
- `then`: the action/result object applied when the condition matches

## Authoring checklist

- Keep every `id` unique inside the same template.
- Start with one focused rule per change.
- Use Rule Preview before saving the rule set.
- Preserve any advanced JSON fields that are already present in the draft.

## Example

```json
{
  "id": "missing_checkout",
  "when": {
    "clockIn1_exists": true,
    "clockOut1_exists": false
  },
  "then": {
    "warning": "缺少下班卡"
  }
}
```

## Related references

- `docs/ATTENDANCE_CUSTOM_RULE_TEMPLATES.md`
- `docs/development/attendance-v270-hotfix-design-20260328.md`
