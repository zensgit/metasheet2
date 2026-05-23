# Attendance comprehensive-hours preview runtime smoke - 2026-05-23

## Scope

This verification records a production runtime smoke for the comprehensive-hours
preview UI and backend route after the deploy host moved from the legacy
`142.171.239.56` address to `23.254.236.11`.

The smoke is read-only:

- no attendance fact table writes;
- no settings or policy persistence;
- no schedule save / block-save path;
- no token value recorded in this file.

## Environment

| Item | Value |
| --- | --- |
| API base | `http://23.254.236.11:8081` |
| Token source | local file, `0600`, value not printed |
| Production repo HEAD | `dc24a793d` |
| Production backend image | `ghcr.io/zensgit/metasheet2-backend:dc24a793d42e914f437860cabb3f17eae69f4777` |
| Production web image | `ghcr.io/zensgit/metasheet2-web:dc24a793d42e914f437860cabb3f17eae69f4777` |
| Confirmed ancestry | includes `#1777` comprehensive-hours preview UI and `#1779` effective-calendar badge slice |

## Runtime health

| Check | Result |
| --- | --- |
| SSH to `23.254.236.11` as `mainuser` | PASS |
| `http://23.254.236.11:8081/api/health` | PASS, HTTP 200 |
| `http://23.254.236.11:8082/api/health` | PASS, HTTP 200 |
| main web `/` | PASS, HTTP 200 |
| staging web `/` | PASS, HTTP 200 |
| main backend `/health` from host side | PASS |
| staging backend `/health` from host side | PASS |

## Auth and backend route smoke

The admin JWT was read from a local restricted-permission file. The token value
was not printed.

| Check | Result |
| --- | --- |
| `GET /api/auth/me` | PASS, user `zhouhua@china-yaguang.com`, role `admin` |
| unauthenticated `POST /api/attendance/comprehensive-hours/preview` | PASS, HTTP 401 `Missing Bearer token` rather than 404 |
| authenticated planned preview | PASS, HTTP 200 |

Authenticated preview payload shape:

```json
{
  "metric": "planned",
  "enforcement": "warn",
  "capMinutes": 480,
  "userIds": ["<sample-user-id>"],
  "period": {
    "type": "custom_range",
    "from": "2026-05-01",
    "to": "2026-05-01"
  }
}
```

Authenticated preview response summary:

| Field | Value |
| --- | --- |
| `ok` | `true` |
| `data.readOnly` | `true` |
| `data.metric` | `planned` |
| `data.enforcement` | `warn` |
| `data.rows.length` | `1` |
| `data.aggregate.status` | `ok` |
| `data.period.key` | `range:2026-05-01:2026-05-01` |

## UI smoke

The browser smoke used a normal Playwright browser context with the same local
admin JWT injected into browser storage. The in-app Browser plugin could not be
used for authenticated navigation because its page context had no
`localStorage`, `sessionStorage`, or `cookie` storage available.

Flow:

1. Open `http://23.254.236.11:8081/attendance`.
2. Authenticate with the local admin JWT.
3. Open `Admin Center`.
4. Jump to `Comprehensive hours`.
5. Enter one explicit user id.
6. Select `custom_range`, `2026-05-01` to `2026-05-01`.
7. Select `planned`, `warn`, `8` cap hours.
8. Click `Preview comprehensive hours`.

Observed UI result:

| UI assertion | Result |
| --- | --- |
| URL | `http://23.254.236.11:8081/attendance?tab=admin#attendance-admin-comprehensive-hours-preview` |
| `GET /api/auth/me` | HTTP 200 |
| `POST /api/attendance/comprehensive-hours/preview` | HTTP 200 |
| Status text | `Read-only preview refreshed. No policy was saved.` |
| Read-only chip | `Read-only preview` |
| Result rows | `1` |
| Aggregate users | `1` |
| Aggregate OK | `1` |
| Aggregate warnings | `0` |
| Aggregate violations | `0` |

Screenshot artifact was written outside the repo at:

```text
/tmp/attendance-comprehensive-hours-ui-smoke-20260523.png
```

## Conclusion

PASS. The comprehensive-hours preview backend route and admin UI are deployed on
the production runtime behind `23.254.236.11:8081`. The smoke confirms the
intended PR3 boundary: read-only preview works, returns a backend 200, renders
rows and aggregate status, and explicitly reports that no policy was saved.

This closes the runtime evidence gap left by the previous legacy-IP deploy-host
SSH timeout. Future PR4 work should remain warning-only until the separately
scoped strong-control PR is explicitly approved.
