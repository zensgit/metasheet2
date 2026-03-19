# Codex Task: Phase 15 Backend

Branch: `codex/multitable-fields-views-linkage-automation-20260312`

## Task 1: Server-Side Search

- Modify `GET /api/multitable/view`
- Accept `search` query param (`string`)
- Apply case-insensitive partial matching across searchable multitable fields before pagination
- Keep `page.total` aligned with the filtered result set

## Task 2: Attachment Endpoints

- `POST /api/multitable/attachments` (`multipart/form-data`) -> `MultitableAttachment`
- `GET /api/multitable/attachments/:attachmentId` -> stream file (`?thumbnail=true` is best-effort for images)
- `DELETE /api/multitable/attachments/:attachmentId` -> remove storage object and scrub the owning record reference when present
- Migration: `multitable_attachments`
- Storage path: `ATTACHMENT_PATH || <cwd>/data/attachments`

## Notes

- Reuse `StorageServiceImpl.createLocalService()` and `createUploadMiddleware()`
- Keep attachment metadata in `multitable_attachments`; do not repurpose `/api/files`
- Attachment field values remain `record.data[fieldId] = string[]` of attachment ids
