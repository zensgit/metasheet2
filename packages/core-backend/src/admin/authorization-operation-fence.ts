import { createHash } from 'node:crypto'
import type { AuthorizationInputQueryable } from '../rbac/authorization-input-brand'

/** Closure of command inputs, its writes, and the vetted trigger/FK dependencies. */
export const AUTHORIZATION_OPERATION_FENCE_TABLES = Object.freeze([
  'authorization_operation_audit', 'authorization_operation_receipts',
  'delegated_role_admin_activation', 'delegated_role_admin_member_groups', 'delegated_role_admin_scopes',
  'directory_account_departments', 'directory_account_links', 'directory_accounts',
  'directory_departments', 'directory_deprovision_effects', 'directory_deprovision_events',
  'directory_integrations', 'directory_sync_runs', 'permissions', 'platform_member_group_members',
  'platform_member_groups', 'role_permissions', 'roles', 'user_namespace_admissions',
  'user_permissions', 'user_roles', 'users',
] as const)

/** Exact profiles measured with the delegation activation migration applied. */
// UTF-8 C with the verified Windows checkout function body bytes.
export const AUTHORIZATION_OPERATION_SCHEMA_PROFILE = 'eb063ac64c15cc8072093aa37ae546509eebdd3d0d8ee46233096869ab19e0fe'
const SUPPORTED_SCHEMA_PROFILES = new Set([
  AUTHORIZATION_OPERATION_SCHEMA_PROFILE,
  // PostgreSQL 14, UTF-8 C with LF bodies and trusted public schema CREATE grants.
  '19ef5b595d055ebd269bf58a4b8cd4312d95d022f4a2dcb9285c55d82346607d',
  // PostgreSQL 15, UTF-8 C with LF bodies.
  'f29f6b75a23223a5784ea86ad9dac74deeb02ffbe17e89af3dff87ce799f7f02',
  // PostgreSQL 16, UTF-8 C with LF bodies on clean and in-place Windows upgrades.
  '619f688920f9dfd66bd7a4bb3b4fd093251878409c82e66ef0f56b45c2420740',
  // PostgreSQL 16, en_US.utf8/2.41 with LF bodies.
  '1f2b2c96c6854cc87d374bf136f43f1b441a8dc8ed563cdd25a8a8fd0175adb1',
  // PostgreSQL 17, UTF-8 C with LF bodies.
  '052c717a45feea6acd4cf5f2711917f4b1e59eef8d1c31aa3bb82c6c1a3e037f',
])
export class AuthorizationOperationFenceUnavailable extends Error {
  readonly status = 503
  readonly code = 'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE'
  constructor() { super('Authorization operation input fence is unavailable') }
}

const TABLES = [...AUTHORIZATION_OPERATION_FENCE_TABLES]
export const AUTHORIZATION_OPERATION_FENCE_LOCK_SQL = `LOCK TABLE ${TABLES.map(name => `"public"."${name}"`).join(', ')} IN EXCLUSIVE MODE NOWAIT`

export const AUTHORIZATION_OPERATION_SCHEMA_QUERIES = [
  `SELECT c.relname, c.relkind, c.relpersistence, c.relispartition, c.relhassubclass,
          c.relrowsecurity, c.relforcerowsecurity, c.reloptions,
          (c.relowner=d.datdba OR c.relowner=n.nspowner) AS owner_trusted
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_catalog.pg_database d ON d.datname=pg_catalog.current_database()
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
  `SELECT c.relname, a.attnum, a.attname, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
          a.attnotnull, a.attidentity, a.attgenerated, co.collname AS collation,
          pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
     LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,a.attnum`,
  `SELECT sn.nspname AS source_schema, s.relname AS source, c.conname, c.contype,
          c.convalidated,c.condeferrable,c.condeferred,c.connoinherit,
          dn.nspname AS target_schema, d.relname AS target, pg_catalog.pg_get_constraintdef(c.oid,true) AS definition
     FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class s ON s.oid=c.conrelid
     JOIN pg_catalog.pg_namespace sn ON sn.oid=s.relnamespace
     LEFT JOIN pg_catalog.pg_class d ON d.oid=c.confrelid
     LEFT JOIN pg_catalog.pg_namespace dn ON dn.oid=d.relnamespace
    WHERE (sn.nspname='public' AND s.relname=ANY($1::text[]))
       OR (c.contype='f' AND dn.nspname='public' AND d.relname=ANY($1::text[]))
    ORDER BY sn.nspname,s.relname,c.conname`,
  `SELECT t.relname AS table_name, i.relname AS index_name, x.indisunique,x.indisprimary,x.indisvalid,x.indisready,x.indislive,
          pg_catalog.pg_get_indexdef(i.oid) AS definition
     FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class t ON t.oid=x.indrelid
     JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
    WHERE n.nspname='public' AND t.relname=ANY($1::text[]) ORDER BY t.relname,i.relname`,
  `SELECT c.relname,t.tgname,t.tgenabled,t.tgtype,pg_catalog.pg_get_triggerdef(t.oid,true) AS definition,
          fn.nspname AS function_schema,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments
     FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
     JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
     JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
  `SELECT c.relname,r.rulename,pg_catalog.pg_get_ruledef(r.oid,true) AS definition
     FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class
     JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,r.rulename`,
  `SELECT c.relname,p.polname,p.polpermissive,p.polcmd,pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS using_expression,
          pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
     FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
     JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,p.polname`,
  // Pin every public function: triggers, constraints, defaults and index expressions can call
  // functions indirectly, and PL/pgSQL bodies do not expose all dependencies to pg_depend.
  `SELECT n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
          l.lanname,p.prosecdef,p.provolatile,p.proparallel,p.proconfig,pg_catalog.pg_get_functiondef(p.oid) AS definition,
          (p.proowner=d.datdba OR p.proowner=n.nspowner) AS owner_trusted
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
     JOIN pg_catalog.pg_database d ON d.datname=pg_catalog.current_database()
     JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.prokind='f' ORDER BY n.nspname,p.proname,arguments`,
] as const

// The eight B2 migrations only add catalog rows to the accepted profiles.
// Hash the entire B2 addition separately so each previously qualified PostgreSQL
// version/locale still has to match its own original exact catalog profile.
const B2_CATALOG_ADDITIONS = 'c8b8994bc64060dde36280a452662854741816a88091d1b2280d7f3f1ca0f743'
const B2_FOREIGN_KEY_SOURCES = new Set([
  'admin_grant_target_ceremony_challenges', 'directory_connection_application_pins',
  'directory_connection_login_scope', 'user_external_identity_evidence', 'user_external_identity_login_grants',
])

type CatalogRow = Record<string, unknown>

function belongsToB2Catalog(section: number, row: CatalogRow): boolean {
  switch (section) {
    case 1: return row.relname === 'users' && row.attname === 'local_credential_version'
    case 2: return B2_FOREIGN_KEY_SOURCES.has(String(row.source))
    case 4: return row.tgname === 'admin_grant_integration_invalidate' || row.tgname === 'admin_grant_local_credential_version'
    case 7: return /^(admin_grant_|strict_login_grant_|security_action_session_flight_)/.test(String(row.proname))
    default: return false
  }
}

// D21 (zzzz20261106110500, Y5a #6786) only adds catalog rows too: one subject authorization
// version trigger on each of five fenced tables (two on users) and the two public trigger functions.
// It is hashed as its own addition, exactly like B2, so the base profile stays the one each
// PostgreSQL version/locale was qualified with. On this base path an absent or partial D21
// addition is refused: this code bumps subject_authorization_versions, so a database that lost
// D21's triggers or functions is not one it was qualified against. (A database matching one of the
// pre-B2 exact profiles above has neither addition and is unchanged by this.)
const D21_CATALOG_ADDITIONS = 'e726ffee09a3b6193a1e5ecb167a5064df67ea121447caec73b0b6c2f66f9ced'
const D21_TRIGGERS = new Set([
  'trg_platform_member_group_members_zz_authz_subject_version', 'trg_user_namespace_admissions_zz_authz_subject_version',
  'trg_user_permissions_zz_authz_subject_version', 'trg_user_roles_zz_authz_subject_version',
  'trg_users_zz_authz_subject_version_lifecycle', 'trg_users_zz_authz_subject_version_update',
])
const D21_FUNCTIONS = new Set(['metasheet_authz_bump_sheet_permission_version', 'metasheet_authz_bump_subject_authorization_version'])

function belongsToD21Catalog(section: number, row: CatalogRow): boolean {
  switch (section) {
    case 4: return D21_TRIGGERS.has(String(row.tgname))
    case 7: return D21_FUNCTIONS.has(String(row.proname))
    default: return false
  }
}

// Y6 (zzzz20261108120000, #6797) adds one public function, the generated-layout immutability guard.
// It touches no fenced table, but the fence pins every public function, so it is a reviewed addition
// of its own, hashed and required on the base path like D21.
const YIDA_LAYOUT_CATALOG_ADDITIONS = 'bcd3224cc13d9701dc2da0f16b708e7ba012b4c22efc57f73d694b3b0ccf9432'
const YIDA_LAYOUT_FUNCTIONS = new Set(['integration_yida_generated_layout_immutable_guard'])

function belongsToYidaLayoutCatalog(section: number, row: CatalogRow): boolean {
  return section === 7 && YIDA_LAYOUT_FUNCTIONS.has(String(row.proname))
}

function schemaDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function readBaseProfile(database: CatalogRow | null, rows: CatalogRow[][]): string | undefined {
  const base = rows.map(() => [] as CatalogRow[])
  const additions = rows.map(() => [] as CatalogRow[])
  const d21 = rows.map(() => [] as CatalogRow[])
  const yidaLayout = rows.map(() => [] as CatalogRow[])
  for (const [section, catalog] of rows.entries()) {
    for (const row of catalog) {
      const partition = belongsToB2Catalog(section, row) ? additions
        : belongsToD21Catalog(section, row) ? d21
          : belongsToYidaLayoutCatalog(section, row) ? yidaLayout
            : base
      partition[section].push(row)
    }
  }
  if (schemaDigest(additions) === B2_CATALOG_ADDITIONS && schemaDigest(d21) === D21_CATALOG_ADDITIONS
    && schemaDigest(yidaLayout) === YIDA_LAYOUT_CATALOG_ADDITIONS) return schemaDigest({ database, rows: base })
}

/** The Y6 generated-layout addition's digest over raw catalog rows; used to measure and pin YIDA_LAYOUT_CATALOG_ADDITIONS. */
export function authorizationOperationYidaLayoutAdditionDigest(rows: CatalogRow[][]): string {
  return schemaDigest(rows.map((catalog, section) => catalog.filter(row => belongsToYidaLayoutCatalog(section, row))))
}

/** The D21 addition's digest over raw catalog rows (section order as in the schema queries); used to measure and pin D21_CATALOG_ADDITIONS. */
export function authorizationOperationD21AdditionDigest(rows: CatalogRow[][]): string {
  return schemaDigest(rows.map((catalog, section) => catalog.filter(row => !belongsToB2Catalog(section, row) && belongsToD21Catalog(section, row))))
}

/** Compute only structural metadata. Never reads customer rows or emits SQL values. */
export async function inspectAuthorizationOperationSchema(query: AuthorizationInputQueryable['query']): Promise<{ digest: string; tableCount: number; ordinary: boolean; baseDigest?: string }> {
  const version = await query(`SELECT pg_catalog.current_setting('server_version_num')::int / 10000 AS version, pg_catalog.current_schema() AS schema, d.datcollate,d.datctype,
    pg_catalog.to_jsonb(d)->>'datlocprovider' AS datlocprovider,
    pg_catalog.to_jsonb(d)->>'datcollversion' AS datcollversion,
    NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
      WHERE a.privilege_type='CREATE' AND a.grantee<>n.nspowner AND a.grantee<>d.datdba) AS schema_create_trusted
    FROM pg_catalog.pg_database d JOIN pg_catalog.pg_namespace n ON n.nspname='public' WHERE d.datname=pg_catalog.current_database()`)
  const rows: CatalogRow[][] = []
  for (const statement of AUTHORIZATION_OPERATION_SCHEMA_QUERIES) rows.push((await query(statement, statement.includes('$1') ? [TABLES] : undefined)).rows)
  const tables = rows[0] as Array<Record<string, unknown>>
  const ordinary = tables.length === TABLES.length && tables.every(row => row.relkind === 'r' && row.relpersistence === 'p' && row.relispartition === false && row.relhassubclass === false && row.relrowsecurity === false && row.relforcerowsecurity === false && row.owner_trusted === true)
    && version.rows[0]?.schema_create_trusted === true
    && (rows[7] as Array<Record<string, unknown>>).every(row => row.owner_trusted === true)
  const database = version.rows[0] ?? null
  const digest = schemaDigest({ database, rows })
  const baseDigest = ordinary && !SUPPORTED_SCHEMA_PROFILES.has(digest) ? readBaseProfile(database, rows) : undefined
  return { digest, tableCount: tables.length, ordinary, baseDigest }
}

export function isSupportedAuthorizationOperationSchema(result: { digest: string; ordinary: boolean; baseDigest?: string }): boolean {
  return result.ordinary && SUPPORTED_SCHEMA_PROFILES.has(result.baseDigest ?? result.digest)
}
export async function assertAuthorizationOperationSchema(query: AuthorizationInputQueryable['query']): Promise<void> {
  const result = await inspectAuthorizationOperationSchema(query)
  if (!isSupportedAuthorizationOperationSchema(result)) throw new AuthorizationOperationFenceUnavailable()
}

/** Caller already holds R0 and operation locks. Locking before inspection closes the data race. */
export async function acquireAuthorizationOperationFence(query: AuthorizationInputQueryable['query']): Promise<void> {
  const schema = await query('SELECT pg_catalog.current_schema() AS schema')
  if (schema.rows[0]?.schema !== 'public') throw new AuthorizationOperationFenceUnavailable()
  await query("SELECT pg_catalog.set_config('search_path', 'pg_catalog,public,pg_temp', true)")
  await query(AUTHORIZATION_OPERATION_FENCE_LOCK_SQL)
  await assertAuthorizationOperationSchema(query)
}

/** Read-only preview/receipt paths hold R0 while inspecting the same known schema. */
export async function assertAuthorizationOperationReadReady(
  query: AuthorizationInputQueryable['query'],
  worldSharedTry: string,
): Promise<boolean> {
  const schema = await query('SELECT pg_catalog.current_schema() AS schema')
  if (schema.rows[0]?.schema !== 'public') throw new AuthorizationOperationFenceUnavailable()
  const acquired = await query(worldSharedTry.replace('SELECT pg_', 'SELECT pg_catalog.pg_'))
  if (acquired.rows[0]?.acquired !== true) return false
  await query("SELECT pg_catalog.set_config('search_path', 'pg_catalog,public,pg_temp', true)")
  await assertAuthorizationOperationSchema(query)
  return true
}
