MetaSheet Stock Preparation RC-A C-Stage Window
================================================

Purpose
-------
This no-Git sidecar performs one fail-safe RC-A acceptance window:

  OFF -> ON -> one frozen extended smoke -> physical readback -> OFF

It does not patch, redeploy, or enable external writes. Run it only after the approved source
configuration has passed the private six-item preflight recorded in issue #4437.

Prerequisites
-------------
- Windows PowerShell 5.1, Node.js 20, and the existing PM2-managed backend.
- The deployed product remains the RC-A package pinned by #4437.
- A short-lived known-good login token and approved config reference are available privately.
- Do not put either value in this file, the operator command line, a transcript, or an issue comment.
- The runner supplies the config reference only to the frozen helper's required local child argument;
  do not reproduce that internal argument in operator evidence.
- Do not start a second run while one is active, and do not retry automatically.

Run
---
Open Windows PowerShell 5.1 in the extracted sidecar directory and run:

  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\stock-preparation-rca-window.ps1 `
    -SidecarDir . `
    -BaseUrl http://127.0.0.1:8900 `
    -TenantId <private-tenant-id> `
    -ApprovedConfigPreflightPassed

The runner prompts for the token and approved config reference with hidden input. If your deployment
uses a workspace, also pass `-WorkspaceId <private-workspace-id>`.

Evidence
--------
Reply to #4437 with only:
- the complete STOCK_PREPARATION_RCA_WINDOW block;
- the process exit code;
- the sidecar ZIP SHA-256 comparison result as PASS or FAIL.

Never post token, config reference, tenant/workspace values, URLs other than the fixed localhost
default, PM2 raw output, API response bodies, record identifiers, or local filesystem paths.

Exit 0 means every closed PASS criterion succeeded. Exit 2 means BLOCKED/FAIL. On either exit, the
runner independently attempts OFF restoration, PM2 stabilization, health, token logout, helper
cleanup, and lock release. A failed cleanup step cannot skip the remaining cleanup steps.
