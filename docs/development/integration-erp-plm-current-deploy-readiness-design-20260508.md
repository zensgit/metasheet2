# Integration ERP/PLM Current Deploy Readiness Design - 2026-05-08

## Context

The backend and frontend Docker image builds now pin pnpm 10 and the K3 WISE setup page exposes a deploy checklist. The remaining operator problem is knowing whether the latest `main` commit is actually ready for a physical-machine internal test.

Older readiness work tracked a stack of individual PR numbers. That became stale once those slices were merged or retargeted. The deploy gate now needs to look at current mainline facts instead of historical PR topology.

## Change

Add `scripts/ops/integration-erp-plm-deploy-readiness.mjs` and a package shortcut:

```bash
pnpm run verify:integration-erp-plm:deploy-readiness
```

The gate checks three surfaces:

- GitHub Actions workflow runs for the selected `main` commit.
- Source markers for the K3 WISE deploy checklist, offline mock PoC chain, and current postdeploy smoke.
- Optional customer GATE JSON top-level presence.

## Required Workflow Gates

For the selected `main` commit, these workflows must be completed with `success`:

- `Build and Push Docker Images`
- `Plugin System Tests`
- `Phase 5 Production Flags Guard`
- `Deploy to Production`

This makes the command answer the deployment question directly: can the current images and deployment workflow be trusted for an internal physical-machine test?

## Customer Boundary

The command reports internal deployment readiness separately from customer live readiness.

Internal deployment can be ready without customer data. Customer live remains blocked until the GATE packet and test account/network details exist. If `--customer-gate-json` is supplied and the required top-level sections are present, the command moves customer status to `gate-packet-present-run-preflight-next`, not directly to live PASS.

## Outputs

The script supports text, markdown, and JSON output. Markdown output is meant to be attached to deployment handoff notes.
