# Multitable Native Person Field Migration Design - 2026-05-06

## Goal

Close the Phase 7 "Native person field migration" backlog item without destabilising the existing record/link stack.

Before this slice, the frontend treated `person` as a create-only pseudo type:

1. call `/api/multitable/person-fields/prepare`;
2. receive a system People sheet preset;
3. create a normal `link` field with `property.refKind = "user"`.

That works, but API callers that send `type: "person"` directly still hit the route enum and fail before the authoritative field creation path.

## Design

This slice makes `person` a native API input type while keeping storage compatible:

- `POST /api/multitable/fields` accepts `type: "person"`.
- `PATCH /api/multitable/fields/:fieldId` accepts `type: "person"`.
- The route provisions or reuses the hidden system People sheet inside the same DB transaction.
- The field is persisted as `type = "link"` with `property.refKind = "user"` and `foreignSheetId` pointing at the system People sheet.
- Caller-supplied `foreignSheetId` is ignored for native person requests; only `limitSingleRecord` is accepted as a user-controlled person option.

Keeping storage as `link` is deliberate. Existing paths already understand link fields:

- record write validation and link mutation;
- link summaries and display maps;
- import people lookup repair;
- Yjs and REST write invalidation;
- grid/drawer/form/link picker rendering.

The migration therefore removes the API contract gap without forcing a risky storage rewrite.

## Contract Updates

- `MultitableFieldType` now includes `person` in OpenAPI.
- The OpenAPI parity guard expects `person`.
- Frontend field typings now include `person`.
- `isLinkField()` treats both `link` and `person` as link-like, and `isPersonField()` treats `type: "person"` or legacy `link + refKind=user` as a person field.

## Compatibility

- Existing `link + refKind=user` fields continue to render and behave as person fields.
- Existing direct prepare + create flows keep working.
- If a future or legacy row is found with raw DB `type = "person"`, backend type mapping now coerces it to `link` instead of falling back to `string`.

## Non-Goals

- No DB data migration is required.
- No new People sheet schema beyond the existing `User ID`, `Name`, `Email`, `Avatar URL` preset.
- No frontend workflow rewrite; the existing prepared-link workflow remains valid.
- No person-specific record value storage; values remain linked record ids.
