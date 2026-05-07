# K3 WISE PoC Secret Text Guard - Development - 2026-05-07

## Context

The K3 WISE live PoC preflight and evidence scripts already checked secret-like
field names such as `password`, `token`, and `authorization`.

That was not enough for customer-entered free-text fields. URLs, archive paths,
request IDs, and evidence notes can carry credentials in places where the key
name is harmless, for example `apiUrl?access_token=...` or
`archivePath=https://share?...signature=...`.

## Change

- Added secret-like text detection for:
  - URL username/password
  - secret query params such as `access_token`, `signature`, `api_key`
  - `Bearer ...` / `Basic ...`
  - JWT-looking values
  - long `SEC...` secret IDs
- `validateUrl()` now rejects K3/PLM URLs carrying credentials or secret query
  parameters.
- Packet generation now scans all generated string fields for secret-like text,
  not only values collected from secret-named keys.
- Evidence reporting now rejects secret-like text in non-secret fields such as
  `archivePath` and `requestId`.

## Behavioral Contract

- Secrets must remain outside generated packet and evidence artifacts.
- Customer-runnable scripts fail fast when input contains credential-bearing
  URLs or free-text tokens.
- Existing placeholder-based credential flow remains unchanged.
