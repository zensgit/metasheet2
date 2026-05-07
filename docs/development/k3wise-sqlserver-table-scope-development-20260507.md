# K3 WISE SQL Server Table Scope - Development - 2026-05-07

## Context

The K3 WISE SQL Server channel supports customer environments that expose
read-only K3 business tables and/or writable integration middle tables.

The previous allowlist merged `allowedTables`, `readTables`, and `writeTables`
into a single set used by both `read()` and `upsert()`. That meant a table
listed only in `readTables` could also authorize a middle-table write if the
object exposed `upsert`, and a table listed only in `writeTables` could
authorize reads.

## Change

- `normalizeTableSet()` now returns directional allowlists:
  - `read = allowedTables + readTables`
  - `write = allowedTables + writeTables`
- `read()` checks only the read allowlist.
- `upsert()` checks only the write allowlist.
- `allowedTables` remains a backward-compatible shared allowlist.
- Exported `normalizeTableSet` under `__internals` for focused inspection.

## Behavioral Contract

- Existing configs using `allowedTables` continue to work for both read and
  write.
- `readTables` grants read access only.
- `writeTables` grants write access only.
- Direct writes to core K3 tables remain blocked unless the object explicitly
  opts into direct writes.
