# Workflow minimal verification (2025-12-31)

## Scope
- Deploy BPMN process
- List definitions by category
- Start process instance
- Confirm instance appears in listing

## Environment
- Base URL: http://127.0.0.1:7778
- JWT secret: dev-secret-key
- User: dev-workflow-admin
- Timestamp: 2025-12-31 14:36 CST

## Command
```bash
JWT_SECRET=dev-secret-key USER_ID=dev-workflow-admin \
  scripts/verify_workflow_minimal.sh http://127.0.0.1:7778
```

## Result
```
Deployed definition: 42e8e33d-cf52-44f3-aa48-0bb909a33844
Started instance: 322fab55-68bd-4edd-a931-4d232c42e595
Workflow minimal verification passed
```

## Notes
- Script updated to parse JSON responses via `python3 -c` to avoid stdin consumption issues.
