# DingTalk Notify Template Governance Deploy Verification - 2026-04-20

## Verification Summary

Deployment of the DingTalk notification template governance package succeeded on the remote host.

## Verified Facts

- `origin/main` points to `71e29327d052f4976dff549e46d34aa96f398667`
- Remote repo `~/metasheet2` is on `main@71e29327d052f4976dff549e46d34aa96f398667`
- Remote `.env` now sets:

```text
IMAGE_TAG=71e29327d052f4976dff549e46d34aa96f398667
```

- Running containers now use:
  - `ghcr.io/zensgit/metasheet2-backend:71e29327d052f4976dff549e46d34aa96f398667`
  - `ghcr.io/zensgit/metasheet2-web:71e29327d052f4976dff549e46d34aa96f398667`

## Command Results

### Container status

```text
metasheet-backend  ghcr.io/zensgit/metasheet2-backend:71e29327d052f4976dff549e46d34aa96f398667  Up
metasheet-web      ghcr.io/zensgit/metasheet2-web:71e29327d052f4976dff549e46d34aa96f398667      Up
metasheet-postgres postgres:15-alpine                                                             Up (healthy)
metasheet-redis    redis:7-alpine                                                                 Up (healthy)
```

### Health endpoint

```json
{"status":"ok","ok":true,"success":true}
```

### Web bundle smoke

Verified deployed frontend assets contain the authoring-governance markers introduced by `#930`, including strings matching:

- `Message summary`
- `Rendered title`
- `Unknown placeholder`
- the preview/example rendering helper code path

## Interpretation

- Runtime deployment succeeded.
- No migration failure occurred.
- Frontend bundle serving from the live web container contains the newly merged template-governance authoring features.

## Remaining Gap To “Send DingTalk Message And Open Form”

Feature capability is already present end-to-end:

- table trigger
- DingTalk group/person message
- public form link
- internal processing link

After this deployment, the remaining gap is no longer feature delivery. It is only operational configuration and live rule setup, which is an hours-level rollout task rather than a new development phase.
