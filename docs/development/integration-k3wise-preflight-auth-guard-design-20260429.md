# K3 WISE Preflight Auth Guard Design - 2026-04-29

## Goal

Prevent the K3 WISE live PoC preflight script from declaring a customer GATE packet ready when the K3 target cannot authenticate.

Before this change, `integration-k3wise-live-poc-preflight.mjs` required `k3Wise.acctId`, but did not require either:

- `k3Wise.credentials.username` + `k3Wise.credentials.password`
- `k3Wise.credentials.sessionId`

That meant a packet could reach `preflight-ready`, then fail later during `external-systems/:id/test` with `K3_WISE_CREDENTIALS_MISSING`.

## Scope

Changed files:

- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`

## Contract

The preflight now accepts either credential shape:

- username/password login: `credentials.username` or `credentials.userName`, plus `credentials.password`
- pre-issued session: `credentials.sessionId`

The existing `k3Wise.acctId` requirement remains unchanged because K3 WISE login still needs the account-set scope for normal username/password auth, and the generated external-system credential placeholders continue to include it.

## Safety

The generated packet still replaces credential values with `<set-at-runtime>`. This guard only checks that the customer supplied the required key shape; it does not write secrets into tracked artifacts.

## Out Of Scope

- Verifying the actual credential value against live K3 WISE.
- Changing the K3 WISE WebAPI adapter credential contract.
- Requiring PLM credentials in this patch.
