/**
 * SINGLE DEFINITION of "which data-source config key is secret-shaped" (#5621).
 *
 * THE GAP THIS CLOSES. Before this module the same question had three answers in four places:
 *   - routes/data-sources.ts `ConnectionConfigSchema` (a free `z.record`) ACCEPTED
 *     `connection.password` — so a direct API caller could put a password there;
 *   - DataSourceManager.configToRecord encrypts ONLY `config.credentials`, so that password
 *     was persisted in PLAINTEXT inside `data_sources.config->connection`;
 *   - routes/data-sources.ts `sanitizeConfig` destructured only `credentials`, so `connection`
 *     (password included) was echoed back by `GET /api/data-sources/:id` and copied into the
 *     update / rotate / delete AUDIT rows;
 *   - BaseAdapter.redactSecrets nevertheless counted `connection.password` as a secret value.
 *
 * Every one of those surfaces now asks THIS module. The rule is stated once, so a future key
 * (`connection.apiToken`, `connection.clientSecret`, …) cannot be secret on one surface and
 * public on another.
 *
 * SCOPE OF THE FAIL-CLOSED CLAIM (narrowed deliberately — do not restate it as an absolute).
 * Inside the surface this module guards — the API-WRITABLE FLAT `connection`, i.e. what
 * routes/data-sources.ts `ConnectionConfigSchema` accepts: a record of SCALARS only — no shipped
 * adapter reads a secret BY KEY NAME. Every one takes its secret from `config.credentials`
 * (PostgresAdapter :85-86, MSSQLAdapter :194-195, MySQLAdapter :205-206, MongoDBAdapter :519,
 * HTTPAdapter :152-156, PLMAdapter :1084-1086; the remaining adapters read none). A secret-shaped
 * KEY sent to the API under `connection` therefore never authenticated anything — it was pure
 * plaintext exposure, which is why the write entry can refuse it fail-closed without taking away
 * any working configuration.
 *
 * It is NOT true that "nothing under `connection` can authenticate". Three measured counterexamples,
 * all invisible to a key-name predicate and all tracked as follow-ups in
 * docs/development/data-source-connection-secret-keys-design-20260912.md §6:
 *   1. URL USERINFO IN A VALUE — `connection.baseURL = 'https://user:pw@host'` is handed to axios
 *      by HTTPAdapter.ts:138, and axios@1.13.2 (lib/adapters/http.js:574-578) turns the URL's
 *      username/password into a REAL Basic credential; that password does authenticate. This
 *      module looks at keys only, so it neither refuses, strips, nor redacts it, and
 *      PLMAdapter.ts:1137 additionally logs `connection.url` unredacted.
 *   2. `connection.headers.Authorization` — the API cannot send it (the Zod record rejects object
 *      values), but PLMAdapter writes its own Bearer into `this.config.connection.headers` at
 *      runtime (PLMAdapter.ts:1076-1080, :1200-1205) and HTTPAdapter.ts:140,:147 spreads those
 *      headers into the axios defaults, so a STORED row can hold a live credential there.
 *   3. IN-PROCESS WRITERS — `DataSourceManager.addDataSource/updateDataSource` are not gated by this
 *      module at all (a stated boundary of this cut; storage is untouched here).
 *
 * MATCHING RULE (deliberately narrow so it cannot swallow legitimate connection keys such as
 * `host` / `database` / `encrypt` / `trustServerCertificate` / `strictOffsetOrdering`):
 *   - the key is normalised (lower-cased, non-alphanumerics dropped) and matched against the
 *     word list below by SUBSTRING — `dbPassword`, `API_KEY`, `sslPassphrase` all hit;
 *   - a word marked `wholeTokenOnly` must equal one of the key's camel/underscore TOKENS —
 *     `pass` and `db_pass` hit; the UNSPLIT lower-case spellings `passthrough` / `bypass` do NOT.
 *     Measured counterexample to any wider reading: tokenisation runs BEFORE the comparison, so
 *     `passThrough`, `pass_through` and `byPass` DO hit and are refused with a coded 400. No key of
 *     that shape exists in any shipped adapter's `connection` today (both directions pinned in
 *     tests/unit/data-source-connection-secret-keys.test.ts group D); if one appears, the fix is a
 *     word-list exception, not a looser rule (loosening would let `passHash` / `passValue` through).
 * There is no exemption list: `hasCredentials` is a PRESENCE FLAG computed by the route AFTER
 * stripping, never a key of a stored config, so it never reaches this predicate.
 */

/** Coded refusal for a write that carries a secret-shaped key under `connection`. */
export const DATA_SOURCE_CONNECTION_SECRET_REJECTED_CODE = 'DATA_SOURCE_CONNECTION_SECRET_REJECTED'

export interface SecretKeyWord {
  /** Word parts; joined for key matching, separator-tolerant in the text pattern. */
  readonly parts: readonly string[]
  /** Match only a whole camel/underscore token of the key (keeps `passthrough` out). */
  readonly wholeTokenOnly?: boolean
  /**
   * Keep this word OUT of the `key=value` text pattern. Only `authorization` sets it: its value
   * is `scheme + token` ("Bearer xyz") and redactSecrets already has a dedicated rule that
   * consumes the whole credential. A single-token `key=value` rule would eat only "Bearer" and
   * leave the token behind (regression guarded by data-source-test-error-fidelity.test.ts).
   */
  readonly skipInTextPattern?: boolean
}

/**
 * The canonical word list. A SUPERSET of every key set it replaces:
 *   - DataSourceManager SENSITIVE_CREDENTIAL_KEYS: password / apiKey / token;
 *   - BaseAdapter.redactSecrets values: credentials.password / token / apiKey / secret,
 *     connection.password;
 *   - BaseAdapter.redactSecrets text pattern: password / pwd / pass / token / api[_-]?key / secret.
 * Widening this list refuses MORE on write and strips MORE on read. On the redaction leg it widens
 * the VALUE SET only: `collectSecretConfigValues` returns a superset of the tuple it replaced, and
 * it returns the values LONGEST-FIRST, because replacing a short secret that is a PREFIX of a
 * longer one first would cut the longer one up and leave a tail (`{secret:'xy', password:'xyz'}`
 * over "tried xyz" -> "tried ***z"). "Widens" is a statement about the value SET plus that order,
 * not about every byte of every message.
 */
export const DATA_SOURCE_SECRET_KEY_WORDS: readonly SecretKeyWord[] = [
  { parts: ['password'] },
  { parts: ['passwd'] },
  { parts: ['pwd'] },
  { parts: ['passphrase'] },
  { parts: ['pass'], wholeTokenOnly: true },
  { parts: ['secret'] },
  { parts: ['token'] },
  { parts: ['credential'] },
  { parts: ['api', 'key'] },
  { parts: ['access', 'key'] },
  { parts: ['private', 'key'] },
  { parts: ['authorization'], skipInTextPattern: true },
]

/** Split a key into lower-cased camel/underscore tokens: `dbPassWord` -> ['db','pass','word']. */
function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase())
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** THE predicate. True when this config key is secret-shaped and must never be stored/echoed bare. */
export function isSecretConfigKey(key: string): boolean {
  const normalized = normalizeKey(key)
  if (normalized.length === 0) return false
  let tokens: string[] | null = null
  for (const word of DATA_SOURCE_SECRET_KEY_WORDS) {
    const joined = word.parts.join('')
    if (word.wholeTokenOnly) {
      tokens ??= keyTokens(key)
      if (tokens.includes(joined)) return true
    } else if (normalized.includes(joined)) {
      return true
    }
  }
  return false
}

/** Plain JSON containers are the only things worth walking; Date/Buffer/Map are values. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** A path segment is only echoed when it looks like an identifier (the key came from the caller). */
function safeSegment(key: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : '<key>'
}

const MAX_REPORTED_PATHS = 20

/**
 * Deep scan for secret-shaped keys. Returns dotted PATHS ONLY (never values), so the refusal a
 * caller sees — and anything logged from it — carries no secret material. Nested containers are
 * walked because a stored row can hold arbitrary JSON (e.g. `connection.headers.Authorization`).
 */
export function findSecretConfigKeyPaths(value: unknown, basePath: string): string[] {
  const found: string[] = []
  const seen = new WeakSet<object>()
  const walk = (node: unknown, path: string): void => {
    if (found.length >= MAX_REPORTED_PATHS) return
    if (typeof node !== 'object' || node === null) return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    if (!isPlainRecord(node)) return
    for (const [key, child] of Object.entries(node)) {
      const childPath = `${path}.${safeSegment(key)}`
      if (isSecretConfigKey(key)) {
        if (found.length < MAX_REPORTED_PATHS) found.push(childPath)
        continue // the whole subtree is refused; no need to descend into it
      }
      walk(child, childPath)
    }
  }
  walk(value, basePath)
  return found
}

/**
 * Deep copy with every secret-shaped key REMOVED. Read-path defence for LEGACY ROWS: a row written
 * before the write entry started refusing (or written by an internal caller) must still never be
 * echoed. Non-plain values (Date, Buffer, …) are passed through by reference, as the
 * response serialiser expects.
 */
export function stripSecretConfigKeys<T>(value: T): T {
  const seen = new WeakSet<object>()
  const walk = (node: unknown): unknown => {
    if (typeof node !== 'object' || node === null) return node
    if (seen.has(node)) return undefined // cycle: drop rather than echo an unchecked subtree
    seen.add(node)
    if (Array.isArray(node)) return node.map((item) => walk(item))
    if (!isPlainRecord(node)) return node
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(node)) {
      if (isSecretConfigKey(key)) continue
      out[key] = walk(child)
    }
    return out
  }
  return walk(value) as T
}

/**
 * Every string VALUE stored under a secret-shaped key, across the given config parts. Feeds
 * BaseAdapter.redactSecrets so a driver message can never carry a configured secret back to a
 * client — same rule as the write refusal and the read strip, one list.
 *
 * Returned LONGEST-FIRST (same ordering rule as secretKeyValueTextPattern): the caller replaces the
 * values one after another, so a short secret that is a substring of a longer one must not go first
 * — `{secret:'xy', password:'xyz'}` replaced in insertion order leaves "***z" of the longer secret.
 */
export function collectSecretConfigValues(parts: ReadonlyArray<unknown>): string[] {
  const values: string[] = []
  const seen = new WeakSet<object>()
  const walk = (node: unknown, keyIsSecret: boolean): void => {
    if (typeof node === 'string') {
      if (keyIsSecret && node.length > 0) values.push(node)
      return
    }
    if (typeof node !== 'object' || node === null) return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyIsSecret)
      return
    }
    if (!isPlainRecord(node)) return
    for (const [key, child] of Object.entries(node)) {
      walk(child, keyIsSecret || isSecretConfigKey(key))
    }
  }
  for (const part of parts) walk(part, false)
  // Longest first: a short secret that is a substring of a longer one must never be replaced first.
  values.sort((a, b) => b.length - a.length)
  return values
}

/**
 * `key=value` / `key: value` redaction pattern built from the SAME word list. Returned fresh per
 * call because a /g RegExp carries lastIndex state. Longest words first so a short word can never
 * shadow a longer one.
 */
export function secretKeyValueTextPattern(): RegExp {
  const alternation = DATA_SOURCE_SECRET_KEY_WORDS.filter((word) => word.skipInTextPattern !== true)
    .map((word) => word.parts.join('[_-]?'))
    .sort((a, b) => b.length - a.length)
    .join('|')
  return new RegExp(
    `(\\b(?:${alternation})\\b\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s;,)]+)`,
    'gi'
  )
}

/**
 * Values-free refusal text for a write that carries secrets under `connection`. Names the offending
 * KEY PATHS (identifier-shaped or `<key>`), never the values, and points at the one place a secret
 * belongs: `credentials`, which is encrypted at rest and never returned by any read surface.
 */
export function connectionSecretRefusalMessage(paths: readonly string[]): string {
  const listed = paths.join(', ')
  return (
    `数据源 connection 不接受口令类字段（${listed}），请改放 credentials（加密存储且任何接口都不回显） / ` +
    `connection must not carry secret-shaped keys (${listed}); send them under credentials instead ` +
    `(encrypted at rest, never returned)`
  )
}
