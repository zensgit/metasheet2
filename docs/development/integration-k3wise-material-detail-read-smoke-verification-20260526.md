# K3 WISE Material/GetDetail Read-Only Smoke Verification - 2026-05-26

## Scope

This verification covers the #1709 read-only runtime slice for one K3 WISE
Material/GetDetail record.

It verifies only the runtime and fixture contract. It does not claim customer
environment live success, does not unlock broad K3 reads, and does not exercise
Save, Submit, Audit, BOM, list, pagination, or server-side Data Factory
composition.

## Acceptance Matrix

| ID | Requirement | Evidence |
| --- | --- | --- |
| A1 | Default K3 WebAPI target remains read-disabled | Adapter tests expect the default `adapter.read({ object: 'material' })` call and a fully keyed `adapter.read({ object: 'material', filters: { FNumber } })` call to throw `UnsupportedAdapterOperationError`. |
| A2 | Material read is opt-in | New test enables `config.objects.material.operations = ['upsert', 'read']` before calling read. |
| A3 | Endpoint is exactly Material/GetDetail | New test asserts one `POST /K3API/Material/GetDetail` call. |
| A4 | Body is the customer-approved single-key shape | New test asserts `{ Data: { FNumber }, GetProperty: false }`. |
| A5 | No write operation is fired | New test asserts no `/Material/Save`, `/Material/Submit`, or `/Material/Audit` call during read. |
| A6 | Response harvesting preserves reference object shapes | Fixture includes `{FName}`, `{FNumber,FName}`, and `{FID,FName}` examples; test asserts all are harvested into `_k3ReferenceObjects`. |
| A7 | `FUnitGroupID` with only `FName` is accepted | Test asserts the FName-only object is retained because the customer sample exposed that shape. |
| A8 | Missing key is rejected | Test asserts `K3_WISE_READ_KEY_REQUIRED`. |
| A9 | Broad/list filters are rejected | Test asserts `K3_WISE_READ_FILTER_UNSUPPORTED` for `modifiedSince`. |
| A10 | Cursor/watermark reads are rejected | Test asserts `K3_WISE_READ_LIST_UNSUPPORTED` for cursor and watermark inputs. |
| A11 | BOM remains locked | Test configures BOM with `read` and still asserts `UnsupportedAdapterOperationError`. |
| A12 | K3 business-negative read is surfaced | Test asserts `K3_WISE_READ_BUSINESS_ERROR`. |
| A13 | HTTP/transport read failure is surfaced | Test asserts `K3_WISE_READ_FAILED`. |

## Commands Run

```bash
pnpm -F plugin-integration-core test:k3-wise-adapters
```

Result:

```text
plugin-integration-core@0.1.0 test:k3-wise-adapters
node __tests__/k3-wise-adapters.test.cjs

✓ k3-wise-adapters: WebAPI, SQL Server channel, and auto-flag coercion tests passed
```

Broader validation:

```bash
git diff --check
pnpm -F plugin-integration-core test
pnpm -F plugin-integration-core test:k3-wise-adapters
pnpm verify:integration-k3wise:poc
```

Results:

- `git diff --check`: pass
- `pnpm -F plugin-integration-core test`: pass
- `pnpm -F plugin-integration-core test:k3-wise-adapters`: pass
- `pnpm verify:integration-k3wise:poc`: pass

## Secret Hygiene

The committed fixture is redacted:

- No real K3 host
- No token
- No password
- No authority code
- No raw material code or account value
- Placeholder values only, such as `<template-material-number>` and
  `<base-unit-number>`

The tests assert request shape and operation paths without logging credentials or
session token values.

## Residual Risk

This slice proves runtime mechanics against a redacted fixture and local adapter
tests. It still requires a separate entity-machine smoke with a customer-approved
template material number before any S4 one-record Save regression can use the
harvested reference objects.

The slice does not resolve master data by code. It only harvests reference
objects already present in the detail record.
