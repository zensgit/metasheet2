# Kysely Type Mapping Notes

- Prefer explicit PostgreSQL types via `sql` for special columns.
- Use `numeric(p,s)` instead of `decimal(p,s)` in Kysely migrations.
- JSONB: define columns as `jsonb` and prefer passing JS objects (driver serializes).
- UUID: use `gen_random_uuid()` (pgcrypto) or `uuid_generate_v4()` (uuid-ossp).
- Timestamps: `timestamptz` with defaults via `NOW()`; keep `updated_at` via trigger or app logic.
- Kysely types: use `Generated<string>`, `ColumnType<Date, undefined, Date>`, `JsonObject` for strong typing.

Examples
```ts
.addColumn('estimated_hours', sql`numeric(8,2)`)
.addColumn('config', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
.addColumn('id', 'uuid', col => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
```
