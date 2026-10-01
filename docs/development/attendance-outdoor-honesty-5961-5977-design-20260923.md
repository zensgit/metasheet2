# Outdoor approval / photo honesty — design (#5961, #5977)

Date: 2026-09-23. Scope is the two open bugs only. No new endpoint, no new plugin consumer, no auth-boundary change.

## #5961 — do not save a dead `requireApproval`

Punch already fail-closes in `prepareOutdoorRequestCreate`:

- `approvalFlowId` set: that flow must exist in the punch org, `request_type = outdoor_punch`, and `is_active`.
- `approvalFlowId` empty: exactly one active `outdoor_punch` flow in that org (0 or more than one → `422 OUTDOOR_APPROVAL_FLOW_REQUIRED`).

`PUT /api/attendance/settings` today only normalizes the booleans, so an admin can persist `requireApproval: true` with no resolvable flow. The admin card shows a hint and still saves.

**Save gate (same code, same resolution).** When the request body includes `punchPolicy.outdoor` and the merged policy has `requireApproval === true`, resolve the flow with `getOrgId(req)` (the same helper that creates approval flows and that an unscoped punch falls back to) and refuse with `422 OUTDOOR_APPROVAL_FLOW_REQUIRED` unless that resolution would succeed at punch time:

- explicit id: active `outdoor_punch` flow in that org (other active flows may exist);
- empty id: exactly one active `outdoor_punch` flow.

`requireApproval: false` always saves, including with zero flows. A settings write that does not include `punchPolicy.outdoor` does not re-check a previously stored outdoor policy, so an unrelated card is not blocked by a legacy dead row. Punch still refuses if the stored policy later becomes unresolvable (flow removed or a second flow added while the id is empty).

The admin card refuses the same cases before the PUT, using the loaded active `outdoor_punch` list, and shows `OUTDOOR_APPROVAL_FLOW_REQUIRED`. The server remains the authority.

## #5977 — Web can attach the photo the punch API already accepts

`POST /api/attendance/punch` already accepts `photoFileId` and enforces `requirePhoto` with `422 OUTDOOR_PHOTO_REQUIRED` / `422 OUTDOOR_PHOTO_INVALID` on an outdoor candidate. Web punch does not collect geolocation or an outdoor marker. It still becomes an outdoor candidate when a geofence is configured and the body has no coordinates (`isGeoAllowed` is false) and `requireApproval` is on. That path had no upload control, and `punchOutcome` did not classify the photo codes.

**Web satisfies the gate.** On `OUTDOOR_PHOTO_REQUIRED` or `OUTDOOR_PHOTO_INVALID`, the employee punch page shows an image picker. Retry uploads via the existing `POST /api/files/upload`, then re-posts the punch with `photoFileId` plus any note already entered. No `location` and no `meta.outdoor` are added. `GET /api/attendance/rules/me` adds boolean `punchPolicy.outdoorPhotoRequired` (no flow id) so the punch page can say a photo may be required before the 422.

`requirePhoto: false` and a punch that is not an outdoor candidate stay unchanged.
