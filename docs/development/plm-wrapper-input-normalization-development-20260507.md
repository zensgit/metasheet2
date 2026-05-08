# PLM Wrapper Input Normalization - Development - 2026-05-07

## Context

The Yuantus PLM wrapper normalizes third-party PLM material and BOM rows before
they enter the integration cleaning pipeline. It also accepts BOM `productId`
from filters/options/config.

Two input-quality gaps existed:

- whitespace-only strings were treated as valid IDs/codes/names/product IDs
- numeric conversion used raw `Number()`, which silently maps booleans and
  arrays to numbers (`true -> 1`, `[] -> 0`, `[2] -> 2`)

Both cases can produce dirty records that look valid until they reach staging
or K3 WISE.

## Change

- `normalizeString()` now trims and returns `null` for whitespace-only strings.
- `firstDefined()` skips whitespace-only string candidates.
- Added strict `normalizeFiniteNumber()` for PLM BOM quantities.
- BOM quantity now accepts finite numbers and parseable numeric strings only.
- `transform-engine` `toNumber` now accepts only finite numbers or parseable
  numeric strings.

## Behavioral Contract

- PLM material `sourceId`, `code`, and `name` are trimmed.
- whitespace-only material fields fail as validation errors.
- whitespace-only BOM `productId` fails before calling the PLM client.
- BOM quantity rejects booleans, arrays, objects, `NaN`, and `Infinity`.
- `toNumber` rejects booleans and arrays instead of silently coercing them.
