# Run21 API Testing Notes

Date: 2026-03-23

## Scope

This note captures the API testing expectations confirmed during Run21 validation so future runs do not regress on endpoint selection or status code interpretation.

## Confirmed API Contracts

### User creation

- `GET /api/auth/users` is the admin user listing endpoint.
- User creation uses `POST /api/admin/users`.
- Do not test `POST /api/auth/users`; that route does not exist in the current contract.

### Attendance import template

- `GET /api/attendance/import/template` returns a JSON guide payload.
- The web UI already exposes a CSV template download by transforming that guide client-side.
- If API consumers need CSV directly, add a dedicated CSV endpoint instead of changing the JSON guide shape in place.

### Shift payload compatibility

- The canonical shift payload uses `workStartTime`, `workEndTime`, and `isOvernight`.
- Legacy aliases are also accepted for shift create/update:
  - `work_start_time`
  - `work_end_time`
  - `start_time`
  - `end_time`
  - `is_overnight`
  - `working_days`
- Use `isOvernight: true` or `is_overnight: true` whenever the shift crosses midnight.

### Missing resource status codes

- `400` is expected for malformed identifiers, including invalid UUIDs.
- `404` should be asserted only for syntactically valid identifiers that do not exist.
- Do not treat a `400` response as a bug unless the identifier format is valid and the resource still resolves as missing.

## Payload Notes

- Attendance request payloads require `requestType`.
- Use camelCase field names in API payloads.
- Rule-set `version` must be a number, not a string.
- Valid rule-set scopes include `org`, `department`, `project`, `user`, and `custom`.
- Attendance request `workDate` must be a pure `YYYY-MM-DD` date string.

## Run21 Confirmation

- Shift GET by id and update-name flow passed.
- Overtime rule GET by id and update-name flow passed.
- Adding a member to a group passed.
- Creating a shift assignment passed.
- Creating a rotation rule passed.
- Creating a rule set passed once the request format matched the live contract.

## Follow-up

- Keep future API tests aligned to the live route map instead of inferred paths.
- Prefer contract-first assertions for payload shape and status code semantics.
