# ERP/PLM Deploy Safety Batch Design - 2026-05-08

## Context

The ERP/PLM integration path is close enough to deploy for internal testing, but customer-live K3 WISE execution is still gated by the customer GATE packet and test account access. This batch does not add new integration scope. It closes small safety gaps around operator-edited values, adapter counters, incremental cursors, payload redaction, diagnostic exposure, and postdeploy token export.

The goal is to make the current deployment path less brittle while we wait for customer-supplied K3 WISE and PLM details.

## Merged Scope

| PR | Merge SHA | Area | Design decision |
| --- | --- | --- | --- |
| #1377 `fix(integration): redact session payload keys` | `fa60e2a140a3539d7ec11c73d10fc8afb4b6f2ae` | payload redaction | Treat common session and cookie identifiers as secrets in evidence, logs, and API-visible payloads. |
| #1378 `fix(integration): validate adapter upsert counters` | `7c84f2b8a3ac48acd56d89971df0a3301f5374e5` | adapter contract | Reject non-finite, fractional, or negative adapter counters instead of silently normalizing bad writeback results. |
| #1376 `fix(integration): validate watermark values before persistence` | `df8bf686f53c2f226e5501e9a6ea98e5974d41c6` | watermark storage | Validate incremental cursor values before persistence so a bad adapter response cannot poison the next sync. |
| #1374 `fix(integration): coerce ERP feedback boolean options` | `5dfab888d0e8ada5a4ca13b4bbe7704be772a037` | ERP feedback config | Accept common boolean shapes from hand-edited JSON and spreadsheets, but fail closed for unknown values. |
| #1372 `fix(integration): guard K3 smoke token env exports` | `bd3986143ad7be205982733a8bc553ac479f5436` | postdeploy smoke ops | Keep GitHub env exports single-line and compact-token only, preventing newline or delimiter injection from smoke token inputs. |
| #1360 `fix(ops): accept K3 tenant auto-discovery in runtime readiness` | `48ca34f8282811701b7bcfcb7031d84396fbe091` | runtime readiness ops | Treat explicit tenant scope and approved auto-discovery as equivalent readiness paths. |
| #1361 `fix(integration): redact REST error details` | `f7fe632ba160a061e6b380b7c8dfef5a76348b73` | REST API diagnostics | Redact unsafe `error.details` fields before returning integration errors to callers. |
| #1363 `fix(integration): redact run error summaries` | `e0a7105814b59441d7ce11bc7d24323f2bf49079` | run log diagnostics | Redact token, password, JWT, and basic-auth URL patterns before writing run error summaries. |
| #1367 `fix(integration): redact external system public config` | `2e038c36b009698f654b7c5b38806058d5dfa5e8` | external system config API | Return sanitized public config while preserving raw private config for adapters. |

## Boundary

This batch deliberately avoids platform reshaping:

- No new PLM or ERP vendor contract is introduced.
- No K3 WISE live connection behavior changes are introduced.
- No database schema migration is introduced.
- No frontend workflow change is introduced.

The resulting main branch is better prepared for internal deployment and postdeploy smoke, but the customer-live PoC remains blocked until the customer GATE packet provides K3 WISE version, WebAPI or channel base URL, tenant/workspace scope, SQL Server permission shape, PLM source fields, rollback policy, and test account credentials.

## Deployment Meaning

Internal deployment can proceed once the main-branch deployment readiness workflow gates pass for the selected head SHA. Customer-live testing should still be treated as blocked until:

1. Customer GATE JSON is available and passes preflight.
2. A K3 WISE test account or safe channel base is reachable.
3. PLM source fixture or live source table access is confirmed.
4. Postdeploy smoke token resolution succeeds without unsafe env output.
5. Evidence summary is generated and signed off.

## Remaining Risk

The next useful development batch should not continue sweeping the same bug class blindly. The higher-value remaining queue is:

- Hold #1358 for focused review because it touches runner and transform behavior.
- Merge #1369 only after #1358 has landed and its preflight/evidence tests rerun.
- Keep older conflicting PRs on hold until their overlap with already-merged deploy-readiness work is re-evaluated.
