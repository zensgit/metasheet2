# Multitable H-Series Observation SOP

**Date:** 2026-05-19
**Status:** Operational runbook, no product behavior change
**Scope:** Multitable H-series after H1/H2/H3 closeout

## 1. Purpose

The H-series shipped the main multitable onboarding path:

- Home entry: recent bases, favorites, search, template quickstart.
- Template center: `/multitable/templates`, category tabs, search, install action.
- Industry templates: 8 built-in templates guarded by the template quality harness.

This SOP defines how to observe whether that path is useful before starting more cleanup or new feature work.

The current codebase does not provide full funnel analytics for page visits, category clicks, search terms, local favorites, or recent bases. Observation must therefore use two tracks:

- Qualitative user feedback from a small, enumerable user set.
- A minimal backend install event once `[multitable.template.install]` logging is available.

## 2. Non-Goals

This SOP does not authorize any of the following:

- Frontend analytics for page views, search terms, category clicks, or localStorage behavior.
- New Prometheus metrics.
- New database tables or migrations.
- Writes to `operation_audit_logs`.
- Removing the `/grid` redirect before the Phase C observation gate.
- Starting Phase E legacy view retirement.
- Starting Phase D spreadsheet work.

These remain separate decisions.

## 3. Required Context

Use this SOP after the following are true on the target environment:

- H2 template center is deployed.
- H3 industry templates are deployed.
- The H-series closeout anchor is in `docs/development/views-consolidation-multitable-spreadsheets-plan-20260517.md`.

If template install logging has not landed yet, run only the qualitative track and record that machine-readable install counts are unavailable.

## 4. Qualitative Track

Use this track as the primary signal while the user group is small.

Interview 3 to 5 real internal or pilot users. Keep each interview under 5 minutes.

Questions:

1. Did you notice the multitable home page as the default entry?
2. Did you see the "Template Center" entry?
3. When creating a multitable base, did you start blank or install a template?
4. If you used a template, which one did you choose and why?
5. If you did not use a template, was it because you did not need one, could not find the right one, or did not notice the feature?
6. Did category filtering help, or did you just scan the full template list?
7. Did search help, or was it unused?
8. Which missing scenario would make the template list useful for your team?
9. After install, did the created base look immediately usable?
10. What was the first thing you had to change after install?

Record answers in a local note or issue using this shape:

```md
## Multitable H-Series Feedback - <date>

- User/team:
- Role:
- Entry discovered from:
- Blank vs template:
- Template used:
- Missing template:
- First post-install edit:
- Confusion/blocker:
- Follow-up action:
```

Do not record private customer data, live business records, tokens, webhook URLs, or email addresses unless the user explicitly approves that content for internal tracking.

## 5. Machine Track

The only machine-readable signal worth collecting in the current architecture is template install.

Expected backend event name:

```text
[multitable.template.install]
```

Expected successful event fields:

```json
{
  "templateId": "contract-management",
  "ok": true,
  "userId": "<user-id>",
  "baseId": "<created-base-id>",
  "sheetId": "<first-created-sheet-id>"
}
```

Expected failed event fields:

```json
{
  "templateId": "contract-management",
  "ok": false,
  "userId": "<user-id-or-null>",
  "statusCode": 404,
  "errorCode": "NOT_FOUND"
}
```

The event must not include `baseName`, request body, template content, email, token, workspace name, or arbitrary user-provided text.

## 6. Log Collection

Use the command that matches the deployment.

There are two levels of evidence:

- Event presence: `grep -F '[multitable.template.install]'` works for Docker stdout, local dev stdout, and JSON log files.
- Field-level counting: `templateId` / `errorCode` extraction is reliable only when the captured line is JSON-formatted. Docker stdout uses the backend console formatter and may not preserve JSON fields in a sed-friendly shape.

Docker container logs, event presence only:

```bash
docker logs metasheet-backend --since 168h 2>&1 \
  | grep -F '[multitable.template.install]'
```

File or collector logs, event presence:

```bash
grep -F '[multitable.template.install]' /var/log/metasheet/backend*.log
```

Local development:

```bash
pnpm --filter @metasheet/core-backend dev 2>&1 \
  | grep -F '[multitable.template.install]'
```

If the log source is JSON formatted, count installed templates:

```bash
grep -F '[multitable.template.install]' backend.log \
  | grep '"ok":true' \
  | sed -n 's/.*"templateId":"\([^"]*\)".*/\1/p' \
  | sort \
  | uniq -c \
  | sort -nr
```

If the log source is JSON formatted, count failures:

```bash
grep -F '[multitable.template.install]' backend.log \
  | grep '"ok":false' \
  | sed -n 's/.*"errorCode":"\([^"]*\)".*/\1/p' \
  | sort \
  | uniq -c \
  | sort -nr
```

If the logger output is not strict JSON, keep the raw event lines as evidence and summarize manually or through the log collector UI.

## 7. Review Cadence

Run two lightweight reviews:

- Day 7 after deployment: check whether template install works and whether any H3 template is clearly unused.
- Day 14 after deployment: decide whether to improve template content, change entry placement, or continue observing.

Do not wait for statistically significant telemetry. This product stage has a small user pool. Use directional evidence.

## 8. Decision Matrix

| Observation | Interpretation | Action |
| --- | --- | --- |
| Users do not know template center exists | Entry/discovery problem | Move or strengthen template entry on multitable home |
| Users install templates but immediately rewrite most fields | Template content mismatch | Revise that template instead of adding more templates |
| 5 H3 templates receive zero installs while users are active | Template catalog mismatch | Interview users and replace low-value templates |
| One or two templates dominate installs | Catalog has a useful direction | Add adjacent templates in that scenario |
| Install events show `409` or `500` | Correctness issue | Fix install path before adding features |
| Users only use home quickstart and never open `/multitable/templates` | Independent template center may be secondary | Consider surfacing more template-center capability on home |
| Users ask for spreadsheet-like behavior | Spreadsheet need is real | Revisit Phase D only after license/package audit |
| No `/grid` traffic after the Phase C observation window | Redirect is unused | Prepare Phase C redirect removal PR |
| `/grid` traffic remains non-zero | Legacy links remain active | Keep redirect and identify source before removal |

## 9. Phase C Preparation

Phase C removes the `/grid` redirect only after the documented gate:

- Earliest review: 2026-05-25.
- Required signal: `/grid` hits are zero or explicitly accepted as removable.
- Maintainer review trigger: 2026-06-30.

`/grid` is a client-side Vue Router redirect:

```ts
{ path: '/grid', redirect: '/multitable' }
```

The backend only sees API traffic and must not be used as the primary `/grid` hit source. A backend log grep can return zero while real browsers still request `/grid` from the static frontend or reverse proxy layer.

Before Phase C, collect `/grid` requests from the frontend/static/reverse-proxy access log, CDN log, or load-balancer access log:

```bash
grep -E '(GET|HEAD) /grid(\\?| |$)' /var/log/nginx/access.log* | tail -50
```

If the frontend is containerized, use the web/static container logs only if they include HTTP access logs:

```bash
docker logs metasheet-web --since 168h 2>&1 \
  | grep -E '(GET|HEAD) /grid(\\?| |$)' \
  | tail -50
```

If the deployment terminates HTTP at a CDN or external load balancer, use that access-log source instead. Record the exact source in the closeout report.

Do not remove the redirect solely because the H-series is complete.

## 10. Closeout Template

Use this format when reporting an observation cycle:

```md
# Multitable H-Series Observation - <date>

## Deployment

- Commit/image:
- Environment:
- Observation window:

## Qualitative Feedback

- Users interviewed:
- Template center discovered by:
- Templates used:
- Missing scenarios:
- Main confusion:

## Install Events

- Total successful installs:
- Installs by template:
- Failures by code:
- Raw log evidence location:

## Phase C Signal

- `/grid` hits:
- Source if non-zero:
- Recommendation:

## Decision

- Keep observing / improve template content / fix install bug / prepare Phase C:
- Owner:
- Next review date:
```
