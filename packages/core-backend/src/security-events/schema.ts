import { createHash } from 'node:crypto'
import { EVENT_REGISTRY, BOOLEAN_FACTS, COUNT_FACTS, PRODUCERS, REASON_CODES, RESULT_CODES, SOURCE_KINDS } from './registry'
import type { EventSql } from './runtime'

export class EventSchemaUnavailable extends Error {
  readonly code = 'E1_SCHEMA_UNAVAILABLE'
  constructor() { super('E1_SCHEMA_UNAVAILABLE') }
}
export const SCHEMA_TABLES = ['security_event_deliveries', 'security_events']
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** The same digest, exported only so reviewed fixtures can be recomputed from their sections. */
export const eventSchemaDigest = (major: number, sections: unknown) => digest({ major, sections })
export const APPLICATION_SCHEMA_FINGERPRINT = digest({ version: 1, EVENT_REGISTRY, BOOLEAN_FACTS, COUNT_FACTS, PRODUCERS, REASON_CODES, RESULT_CODES, SOURCE_KINDS })

/** Exact catalog, including every CHECK expression, rather than just event_type or CHECK names. */
export const EVENT_SCHEMA_QUERIES = [
  `SELECT c.relname,c.relkind,c.relpersistence,c.relispartition,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,
    (c.relowner=d.datdba OR c.relowner=n.nspowner) AS owner_trusted
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_database d ON d.datname=current_database()
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
  `SELECT c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,
    co.collname AS collation,pg_get_expr(d.adbin,d.adrelid) AS default_expression
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,a.attnum`,
  `SELECT sn.nspname AS source_schema,s.relname AS source,c.conname,c.contype,c.convalidated,c.condeferrable,c.condeferred,
    dn.nspname AS target_schema,d.relname AS target,pg_get_constraintdef(c.oid,true) AS definition
    FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_namespace sn ON sn.oid=s.relnamespace
    LEFT JOIN pg_class d ON d.oid=c.confrelid LEFT JOIN pg_namespace dn ON dn.oid=d.relnamespace
    WHERE (sn.nspname='public' AND s.relname=ANY($1::text[])) OR (dn.nspname='public' AND d.relname=ANY($1::text[]))
    ORDER BY sn.nspname,s.relname,c.conname`,
  `SELECT t.relname AS table_name,i.relname AS index_name,x.indisunique,x.indisprimary,x.indisvalid,x.indisready,x.indislive,
    pg_get_indexdef(i.oid) AS definition FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class i ON i.oid=x.indexrelid
    WHERE n.nspname='public' AND t.relname=ANY($1::text[]) ORDER BY t.relname,i.relname`,
  `SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
  `SELECT c.relname,r.rulename,pg_get_ruledef(r.oid,true) AS definition FROM pg_rewrite r
    JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,r.rulename`,
  `SELECT c.relname,p.polname,pg_get_expr(p.polqual,p.polrelid) AS using_expression,pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,p.polname`,
] as const

export async function inspectEventSchema(sql: EventSql) {
  const meta = (await sql.query<{ major: number }>("SELECT current_setting('server_version_num')::int / 10000 AS major")).rows[0]
  if (!meta || ![14, 15, 16, 17].includes(meta.major)) throw new EventSchemaUnavailable()
  const sections: Record<string, unknown>[][] = []
  for (const text of EVENT_SCHEMA_QUERIES) sections.push((await sql.query(text, [SCHEMA_TABLES])).rows)
  if (sections[0].length !== 2 || sections[0].some(row => row.relkind !== 'r' || row.relpersistence !== 'p' || row.owner_trusted !== true
    || row.relispartition !== false || row.relrowsecurity !== false || row.relforcerowsecurity !== false)) throw new EventSchemaUnavailable()
  return { major: meta.major, sections, digest: eventSchemaDigest(meta.major, sections), applicationFingerprint: APPLICATION_SCHEMA_FINGERPRINT }
}

/**
 * The release gate supplies reviewed PG14–17 fixture attestations, never a digest learned from
 * the target database. E1-A does not ship unmeasured hashes or automatically approve a new schema.
 */
export type EventSchemaApproval = Readonly<{ major: number; digest: string; applicationFingerprint: string }>
export async function assertEventSchema(sql: EventSql, approved: readonly EventSchemaApproval[]): Promise<void> {
  try {
    const actual = await inspectEventSchema(sql)
    if (!approved.some(item => item.major === actual.major && item.applicationFingerprint === APPLICATION_SCHEMA_FINGERPRINT && item.digest === actual.digest)) throw new EventSchemaUnavailable()
  } catch { throw new EventSchemaUnavailable() }
}
