# Fallback Staging Validation (Partial)

This directory documents an internal fallback path when official Staging BASE_URL and JWT are delayed.

Workflow:
1. `bash scripts/fallback/prepare.sh` — write `.env.fallback`, run migrations.
2. Start Postgres (if needed) on specified port.
3. `bash scripts/fallback/seed.sh` — seed minimal view.
4. `bash scripts/fallback/validate.sh` — run snapshot/rule + perf sample.
5. `bash scripts/fallback/collect.sh` — copy evidence under `docs/sprint2/fallback-evidence/`.
6. Review gaps vs real staging (latency, plugins, dashboards, real rate limits).
7. If used, clearly mark PR as "Partial Staging" until full staging pass occurs.

Do NOT treat fallback results as a substitute for full staging validation.
