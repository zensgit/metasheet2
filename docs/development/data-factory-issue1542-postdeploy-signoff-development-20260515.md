# Data Factory issue #1542 postdeploy signoff development - 2026-05-15

## Summary

This slice records the first successful deployment-side Data Factory issue
#1542 smoke after the `issue1542_install_staging` GitHub Actions input landed.

No product code changed in this slice. The development work was operational:

- use the new manual workflow input added by
  `ci(integration): expose issue1542 install-staging smoke`;
- run it against the 142 bridge/test deployment;
- verify the staging-table-as-source path, K3 material target schema, and draft
  pipeline save contract from a real deployed backend;
- preserve the result as a redaction-safe closeout note.

## Triggered Workflow

- Workflow: `K3 WISE Postdeploy Smoke`
- Run: `25905364900`
- Ref: `main`
- Commit: `f612a04c00b05baaf7aeb6016a16defc6c72f871`
- Event: `workflow_dispatch`
- URL: `https://github.com/zensgit/metasheet2/actions/runs/25905364900`

Inputs:

- `base_url`: bridge/test MetaSheet HTTP endpoint
- `require_auth`: `true`
- `tenant_id`: `default`
- `auto_discover_tenant`: `false`
- `issue1542_install_staging`: `true`
- `timeout_ms`: `10000`

The token was resolved by the deploy-host fallback. Token values were never
printed in the workflow log or copied into this document.

## What This Proves

The issue #1542 deployment retest covers the path that previously blocked the
Workbench dry-run setup:

1. install integration staging descriptors;
2. create or reuse the `metasheet:staging` source system from installed staging
   metadata;
3. verify `standard_materials` source schema discovery;
4. verify K3 WISE material target schema discovery;
5. save a draft staging-to-K3 material pipeline without running dry-run or K3
   writes.

This specifically closes the deployment-observed symptoms:

- staging source had to be created manually;
- staging source schema returned `fields: []`;
- pipeline save failed with PostgreSQL `22P02`;
- dry-run could not begin because no pipeline id was returned.

## Safety Boundary

The smoke writes metadata only:

- staging descriptors and sheet/open-link metadata;
- a MetaSheet staging source external-system record;
- a metadata-only K3 target if no live target is available for this smoke;
- a draft pipeline definition.

It does not execute:

- source record read;
- transform/dry-run;
- K3 Save-only;
- Submit;
- Audit;
- SQL Server executor calls.

## Remaining Non-Blocking Gap

SQL Server source execution remains outside this signoff. The issue #1542 smoke
proves the staging-table-as-source route, which is enough for Data Factory users
to clean data in MetaSheet and validate a staging-to-K3 pipeline shape. SQL
Server reads still need a deployed allowlist executor before the advanced SQL
channel can become a normal source path.
