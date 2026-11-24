/**
 * Reads, from the authoritative database, the two installation generations the realtime admission
 * table depends on:
 *
 *   1. the strict login scope generation (the permanent scope table and its supporting objects);
 *   2. the environment enablement record generation (the one-way record of purposes an environment
 *      was enabled for).
 *
 * Each generation has exactly two decidable states: certainly never installed with no leftover
 * object, or completely installed and readable. Everything else — a registered migration with a
 * missing object, leftovers without a registration, an incomplete structure, a refused or timed-out
 * read — is `unknown`. `unknown` is never treated as empty.
 *
 * Both generations are read inside one read-only snapshot, so the answer describes a single
 * consistent view of the database.
 *
 * ENABLEMENT RECORD GENERATION IN THIS BUILD. This build ships no enablement record structure, so no
 * environment can have been enabled by it. The probe for that generation is an interface;
 * `enablementRecordNotDefinedInThisBuild` answers `never-installed` and marks the answer so the
 * administrator diagnostics always show that the generation is not readable by this build. A build
 * that ships the structure must replace this probe before any environment is enabled.
 */

export type ProbeQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>

export type ProbeCaller = { query: ProbeQuery }

export type StrictScopeGeneration =
  | { readonly state: 'never-installed' }
  | { readonly state: 'installed'; readonly hasScope: boolean }
  | { readonly state: 'unknown' }

export type EnablementPurpose = 'strict-switch' | 'credential-chain'

export type EnablementGeneration =
  | { readonly state: 'never-installed'; readonly definedInThisBuild: boolean }
  | { readonly state: 'installed'; readonly purposes: readonly EnablementPurpose[] }
  | { readonly state: 'unknown' }

export interface RealtimeInstallationFacts {
  readonly strictScope: StrictScopeGeneration
  readonly enablement: EnablementGeneration
}

/** 'installed' | 'never-installed'; rejects when the installation cannot be decided. */
export type StrictInstallationReader = (caller: ProbeCaller) => Promise<'installed' | 'never-installed'>

export type EnablementRecordProbe = (caller: ProbeCaller) => Promise<EnablementGeneration>

export const enablementRecordNotDefinedInThisBuild: EnablementRecordProbe = async () =>
  Object.freeze({ state: 'never-installed', definedInThisBuild: false })

export const STRICT_SCOPE_TABLE = 'directory_connection_login_scope'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** First non-system schema of the search path: the schema the strict login generation installs into. */
export const INSTALL_SCHEMA_SQL = `SELECT candidate.nspname AS schema_name
  FROM pg_catalog.unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS candidate(nspname, ord)
 ORDER BY candidate.ord`

async function installSchema(caller: ProbeCaller): Promise<string> {
  const result = await caller.query(INSTALL_SCHEMA_SQL)
  for (const row of result.rows) {
    const name = row.schema_name
    if (typeof name !== 'string' || name.startsWith('pg_') || name === 'information_schema') continue
    if (!IDENTIFIER.test(name)) break
    return name
  }
  throw new Error('install schema not decidable')
}

export async function readStrictScopeGeneration(
  caller: ProbeCaller,
  readInstallation: StrictInstallationReader,
): Promise<StrictScopeGeneration> {
  try {
    const installation = await readInstallation(caller)
    if (installation === 'never-installed') return Object.freeze({ state: 'never-installed' })
    if (installation !== 'installed') return Object.freeze({ state: 'unknown' })
    const schemaName = await installSchema(caller)
    const scope = await caller.query(
      `SELECT EXISTS (SELECT 1 FROM "${schemaName}"."${STRICT_SCOPE_TABLE}") AS has_scope`,
    )
    const hasScope = scope.rows[0]?.has_scope
    if (scope.rows.length !== 1 || typeof hasScope !== 'boolean') return Object.freeze({ state: 'unknown' })
    return Object.freeze({ state: 'installed', hasScope })
  } catch {
    return Object.freeze({ state: 'unknown' })
  }
}

export interface InstallationProbeDeps {
  /** Runs `work` on one connection inside a single read-only snapshot and ends that transaction. */
  withReadOnlySnapshot: <T>(work: (caller: ProbeCaller) => Promise<T>) => Promise<T>
  readStrictInstallation: StrictInstallationReader
  readEnablement: EnablementRecordProbe
  timeoutMs?: number
}

export const DEFAULT_INSTALLATION_PROBE_TIMEOUT_MS = 3000

const UNKNOWN_FACTS: RealtimeInstallationFacts = Object.freeze({
  strictScope: Object.freeze({ state: 'unknown' }),
  enablement: Object.freeze({ state: 'unknown' }),
})

/** Never rejects: a probe that cannot complete answers `unknown` for both generations. */
export async function probeRealtimeInstallation(deps: InstallationProbeDeps): Promise<RealtimeInstallationFacts> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_INSTALLATION_PROBE_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<RealtimeInstallationFacts>((resolve) => {
    timer = setTimeout(() => resolve(UNKNOWN_FACTS), timeoutMs)
  })
  const work = (async (): Promise<RealtimeInstallationFacts> => {
    try {
      return await deps.withReadOnlySnapshot(async (caller) => {
        const strictScope = await readStrictScopeGeneration(caller, deps.readStrictInstallation)
        let enablement: EnablementGeneration
        try {
          enablement = await deps.readEnablement(caller)
        } catch {
          enablement = Object.freeze({ state: 'unknown' })
        }
        return Object.freeze({ strictScope, enablement })
      })
    } catch {
      return UNKNOWN_FACTS
    }
  })()
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
