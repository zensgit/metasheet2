/**
 * #6164 step 1 — census guard: the encrypted-store probe stays COMPLETE.
 *
 * src/security/encrypted-store-probe.ts trial-decrypts the stores listed in ENCRYPTED_STORE_CATALOG.
 * A store that is not in that catalog is invisible to it — and after a key change its values would
 * again fail one at a time on some unrelated page, which is the failure #6164 exists to end. So this
 * suite scans the source tree (tests/utils/encrypted-store-writer-census.ts: core-backend src/ and
 * scripts/, every plugin's index.* / lib/ / src/ / engine/) for every place that can SEAL a value —
 * the named writers (encryptStoredSecretValue, normalizeStoredSecretValue, the dingtalk-destination
 * wrapper, the attendance plugin's encryptIntegrationSecretValue / normalizeStoredIntegrationSecretValue),
 * every `.encrypt(…)` call (plugin security service, credential stores, ConfigService's SecretManager)
 * and every createCipheriv / createCipher (any re-implementation) — and pins the EXACT set of
 * (file, writer, count) to a catalog store or to a reasoned exemption.
 *
 * A new writer, a new file that seals, or a new re-implementation of the `enc:` format turns this red
 * until someone decides where its values live: add a catalog entry (and the probe covers it), or add a
 * reasoned exemption here. Removing a catalog entry that a pinned writer still feeds turns it red too.
 *
 * Mutation self-proof is built in and memory-level: a synthetic new writer is spliced into the source
 * of real files IN MEMORY (nothing is written to disk) and the pinned comparison must fail, naming it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import { ENCRYPTED_STORE_CATALOG } from '../../src/security/encrypted-store-probe'
import {
  countSealingSites,
  GENERIC_SEALING_CALLS,
  isScannableFile,
  listCensusFiles,
  NAMED_SEALING_WRITERS,
  scanSealingSites,
  type SealingSite,
} from '../utils/encrypted-store-writer-census'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/** Why a sealing site feeds NO probed store. Each reason names what was checked. */
const EXEMPTIONS = {
  'shared-primitive':
    'security/encrypted-secrets.ts is the `enc:` primitive itself (encryptStoredSecretValue is called by normalizeStoredSecretValue, createCipheriv by encryptStoredSecretValue); it persists nothing — its callers are pinned individually.',
  'recovery-archive-crypto':
    'Recovery-archive envelope crypto: per-archive DEKs and a custody keyring sealed under its own backup secret, never ENCRYPTION_KEY / ENCRYPTION_SALT, so a platform key change does not affect it (outside #6164).',
  'recovery-verify-script':
    'scripts/verify-recovery-manual-checkpoint.mts is an operator verification script: it seals a synthetic capture under a fresh randomBytes(32) key inside its own throwaway database to exercise the prepared-capture store; no platform material, no persisted store of this deployment.',
  'dead-plugin-config-manager':
    'src/plugin/PluginConfigManager.ts has no importer in src/ (the runtime uses core/plugin-config-manager.ts, which encrypts nothing); it would seal plugin_configs.value under a random per-instance key with crypto.createCipher, not platform material.',
  'unwired-security-service-impl':
    'services/SecurityService.ts SecurityServiceImpl (scrypt of an injected key, else a random key) is only built by core/plugin-service-factory.ts for core/plugin-manager.ts createPluginManager(), which nothing in src/ calls; the live runtime injects PluginRuntimeSecurityService (index.ts) whose encrypt() is encryptStoredSecretValue.',
} as const

type ExemptionKey = keyof typeof EXEMPTIONS

interface CensusEntry {
  count: number
  /** Catalog stores (table names) this site seals values for. */
  stores?: readonly string[]
  exempt?: ExemptionKey
}

const CS = 'packages/core-backend/src'
const SCRIPTS = 'packages/core-backend/scripts'

/** Every sealing site in the scanned roots today: `<file> :: <writer>` -> count + owner. */
const CENSUS: Readonly<Record<string, CensusEntry>> = {
  // data_sources.config.credentials.{password,apiKey,token} — DataSourceManager.encryptCredentials
  [`${CS}/data-adapters/DataSourceManager.ts :: encryptStoredSecretValue`]: { count: 1, stores: ['data_sources'] },
  // directory_integrations.config: appSecret + workNotificationAgentId (create + update)
  [`${CS}/directory/directory-sync.ts :: normalizeStoredSecretValue`]: { count: 4, stores: ['directory_integrations'] },
  // directory_integrations.config.approvalCardLinkSecret
  [`${CS}/integrations/dingtalk/approval-card-config.ts :: normalizeStoredSecretValue`]: { count: 1, stores: ['directory_integrations'] },
  // directory_integrations.config.workNotificationAgentId (agent-id save)
  [`${CS}/integrations/dingtalk/work-notification-settings.ts :: normalizeStoredSecretValue`]: { count: 1, stores: ['directory_integrations'] },
  // dingtalk_group_destinations.{webhook_url,secret}: the wrapper and its four call sites
  [`${CS}/multitable/dingtalk-group-destinations.ts :: normalizeStoredSecretValue`]: { count: 1, stores: ['dingtalk_group_destinations'] },
  [`${CS}/multitable/dingtalk-group-destination-service.ts :: encryptDingTalkDestinationValue`]: { count: 4, stores: ['dingtalk_group_destinations'] },
  // integration_external_systems.credentials_encrypted: the host security service the credential store
  // calls (`enc:`), the credential store (host `security.encrypt` + legacy `v1:` encrypt / cipher), and
  // external-systems.cjs (string + object credentials)
  [`${CS}/security/plugin-runtime-security-service.ts :: encryptStoredSecretValue`]: { count: 1, stores: ['integration_external_systems'] },
  ['plugins/plugin-integration-core/lib/credential-store.cjs :: encrypt']: { count: 2, stores: ['integration_external_systems'] },
  ['plugins/plugin-integration-core/lib/credential-store.cjs :: createCipheriv']: { count: 1, stores: ['integration_external_systems'] },
  ['plugins/plugin-integration-core/lib/external-systems.cjs :: encrypt']: { count: 2, stores: ['integration_external_systems'] },
  // attendance_integrations.config.appSecret — the plugin's own copy of the `enc:` format
  // (normalizeStoredIntegrationSecretValue -> encryptIntegrationSecretValue -> createCipheriv; the second
  // encryptIntegrationSecretValue reference is the __attendanceIntegrationSecretForTests export)
  ['plugins/plugin-attendance/index.cjs :: encryptIntegrationSecretValue']: { count: 2, stores: ['attendance_integrations'] },
  ['plugins/plugin-attendance/index.cjs :: normalizeStoredIntegrationSecretValue']: { count: 1, stores: ['attendance_integrations'] },
  ['plugins/plugin-attendance/index.cjs :: createCipheriv']: { count: 1, stores: ['attendance_integrations'] },
  // system_configs.value of is_encrypted rows — ConfigService SecretManager (rotateKey re-seal + its cipher)
  [`${CS}/services/ConfigService.ts :: encrypt`]: { count: 1, stores: ['system_configs'] },
  [`${CS}/services/ConfigService.ts :: createCipheriv`]: { count: 1, stores: ['system_configs'] },
  // one-off backfill scripts over stores already in the catalog
  [`${SCRIPTS}/encrypt-dingtalk-destination-secrets.ts :: normalizeStoredSecretValue`]: { count: 2, stores: ['dingtalk_group_destinations'] },
  [`${SCRIPTS}/encrypt-dingtalk-integration-secrets.ts :: normalizeStoredSecretValue`]: { count: 1, stores: ['directory_integrations', 'attendance_integrations'] },
  // exemptions
  [`${CS}/security/encrypted-secrets.ts :: encryptStoredSecretValue`]: { count: 1, exempt: 'shared-primitive' },
  [`${CS}/security/encrypted-secrets.ts :: createCipheriv`]: { count: 1, exempt: 'shared-primitive' },
  [`${CS}/multitable/recovery-archive-attachment-crypto.ts :: createCipheriv`]: { count: 1, exempt: 'recovery-archive-crypto' },
  [`${CS}/multitable/recovery-archive-crypto.ts :: createCipheriv`]: { count: 1, exempt: 'recovery-archive-crypto' },
  [`${CS}/multitable/recovery-local-custody.ts :: createCipheriv`]: { count: 1, exempt: 'recovery-archive-crypto' },
  [`${SCRIPTS}/verify-recovery-manual-checkpoint.mts :: createCipheriv`]: { count: 1, exempt: 'recovery-verify-script' },
  [`${CS}/plugin/PluginConfigManager.ts :: encrypt`]: { count: 1, exempt: 'dead-plugin-config-manager' },
  [`${CS}/plugin/PluginConfigManager.ts :: createCipher`]: { count: 1, exempt: 'dead-plugin-config-manager' },
  [`${CS}/services/SecurityService.ts :: createCipheriv`]: { count: 1, exempt: 'unwired-security-service-impl' },
}

const PINNED_COUNTS = Object.fromEntries(
  Object.entries(CENSUS)
    .map(([key, entry]) => [key, entry.count] as const)
    .sort(([a], [b]) => a.localeCompare(b)),
)

const readRepoFile = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')

/** Files whose text can hold a site at all (every site's identifier contains one of these names). */
function mayHoldSite(source: string): boolean {
  return [...NAMED_SEALING_WRITERS, ...GENERIC_SEALING_CALLS].some((name) => source.includes(name))
}

function scanTree(read: (rel: string) => string = readRepoFile, extraFiles: string[] = []): SealingSite[] {
  const files = [...listCensusFiles(REPO_ROOT), ...extraFiles]
  return files.flatMap((rel) => {
    const source = read(rel)
    return mayHoldSite(source) ? scanSealingSites(rel, source) : []
  })
}

const NEW_SITE_HELP =
  'MORE sealing sites than pinned = a NEW encrypted field or store. Add its entry to ENCRYPTED_STORE_CATALOG ' +
  '(src/security/encrypted-store-probe.ts) so the probe checks it — or a reasoned EXEMPTION here when it is ' +
  'not platform material — and only then raise this pin. Bumping the pin alone leaves the new store unprobed.'
const GONE_SITE_HELP =
  'FEWER sealing sites than pinned = a writer went away. Lower the pin; if a catalog store lost its last ' +
  'writer, decide whether its ENCRYPTED_STORE_CATALOG entry should stay (old rows may still hold values).'

/** Census keys whose count differs from the pin (both directions), each with what to do about it. */
function censusDrift(actual: Record<string, number>): string[] {
  const keys = new Set([...Object.keys(actual), ...Object.keys(PINNED_COUNTS)])
  return [...keys]
    .filter((key) => actual[key] !== PINNED_COUNTS[key])
    .map((key) => {
      const pinned = PINNED_COUNTS[key] ?? 0
      const found = actual[key] ?? 0
      return `${key}: pinned ${pinned}, found ${found} — ${found > pinned ? NEW_SITE_HELP : GONE_SITE_HELP}`
    })
    .sort()
}

const newSite = (key: string, found = 1) => `${key}: pinned 0, found ${found} — ${NEW_SITE_HELP}`

describe('encrypted-store census: every sealing site is pinned to a probed store or a reasoned exemption', () => {
  let sites: SealingSite[] = []
  beforeAll(() => {
    sites = scanTree()
  })

  it('the scanned tree holds exactly the pinned sealing sites (file, writer, count)', () => {
    const drift = censusDrift(countSealingSites(sites))
    expect(drift, `encrypted-store census drift:\n  ${drift.join('\n  ')}`).toEqual([])
    expect(countSealingSites(sites)).toEqual(PINNED_COUNTS)
  })

  it('a census drift message says what a higher / lower count means', () => {
    expect(censusDrift({ ...PINNED_COUNTS, 'probe.ts :: encryptStoredSecretValue': 2 })).toEqual([
      newSite('probe.ts :: encryptStoredSecretValue', 2),
    ])
    expect(newSite('x')).toMatch(/NEW encrypted field or store\. Add its entry to ENCRYPTED_STORE_CATALOG/)
    const firstKey = Object.keys(PINNED_COUNTS)[0]
    const { [firstKey]: _gone, ...withoutFirst } = PINNED_COUNTS
    expect(censusDrift(withoutFirst)).toEqual([`${firstKey}: pinned ${PINNED_COUNTS[firstKey]}, found 0 — ${GONE_SITE_HELP}`])
  })

  it('every pinned site has an owner: catalog stores that exist, or an exemption with a reason', () => {
    const catalogStores = new Set(ENCRYPTED_STORE_CATALOG.map((entry) => entry.store))
    for (const [key, entry] of Object.entries(CENSUS)) {
      const hasStores = Array.isArray(entry.stores) && entry.stores.length > 0
      expect({ key, owned: hasStores !== Boolean(entry.exempt) }).toEqual({ key, owned: true })
      for (const store of entry.stores ?? []) {
        expect({ key, store, inCatalog: catalogStores.has(store) }).toEqual({ key, store, inCatalog: true })
      }
      if (entry.exempt) expect(EXEMPTIONS[entry.exempt].length).toBeGreaterThan(80)
    }
  })

  it('every catalog store is fed by at least one pinned writer, and every exemption is used', () => {
    const fed = new Set(Object.values(CENSUS).flatMap((entry) => entry.stores ?? []))
    const unfed = [...new Set(ENCRYPTED_STORE_CATALOG.map((entry) => entry.store))].filter((store) => !fed.has(store))
    expect(unfed).toEqual([])
    const usedExemptions = new Set(Object.values(CENSUS).map((entry) => entry.exempt).filter(Boolean))
    expect(Object.keys(EXEMPTIONS).filter((key) => !usedExemptions.has(key as ExemptionKey))).toEqual([])
  })

  it('is not vacuous: the scan reaches every root it claims, and only source files', () => {
    const files = listCensusFiles(REPO_ROOT)
    for (const expected of [
      'packages/core-backend/src/security/encrypted-secrets.ts',
      'packages/core-backend/src/services/ConfigService.ts',
      'packages/core-backend/scripts/encrypt-dingtalk-destination-secrets.ts',
      'plugins/plugin-attendance/index.cjs',
      'plugins/plugin-integration-core/lib/credential-store.cjs',
      'plugins/plugin-integration-core/lib/external-systems.cjs',
      // .mts / .cts are scanned too (a createCipheriv in a .mts script was invisible before)
      'packages/core-backend/scripts/verify-recovery-manual-checkpoint.mts',
    ]) {
      expect({ expected, scanned: files.includes(expected) }).toEqual({ expected, scanned: true })
    }
    expect(files.filter((f) => /(^|\/)(node_modules|dist|__tests__|tests)\//.test(f) || /\.(test|spec)\./.test(f))).toEqual([])
    // Every writer kind the census pins was actually seen somewhere.
    const seen = new Set(sites.map((site) => site.name))
    for (const name of [...NAMED_SEALING_WRITERS, ...GENERIC_SEALING_CALLS]) {
      expect({ name, seen: seen.has(name) }).toEqual({ name, seen: true })
    }
  })
})

describe('scanner self-check (synthetic sources, memory only)', () => {
  const count = (source: string, file = 'probe.ts') => scanSealingSites(file, source).map((site) => site.name)

  it('finds a writer in every shape a new store would use', () => {
    expect(count(`import { encryptStoredSecretValue } from '../security/encrypted-secrets'\nexport const x = encryptStoredSecretValue('a')`)).toEqual(['encryptStoredSecretValue'])
    expect(count(`import { normalizeStoredSecretValue as seal } from '../security/encrypted-secrets'\nexport const x = seal('a')`)).toEqual(['normalizeStoredSecretValue (alias)', 'normalizeStoredSecretValue'])
    expect(count(`import * as es from '../security/encrypted-secrets'\nexport const x = es.normalizeStoredSecretValue('a')`)).toEqual(['normalizeStoredSecretValue'])
    expect(count(`import { normalizeStoredSecretValue } from '../security/encrypted-secrets'\nexport const xs = ['a'].map(normalizeStoredSecretValue)`)).toEqual(['normalizeStoredSecretValue'])
    expect(count(`const { encryptIntegrationSecretValue: enc } = require('./x')\nmodule.exports = enc('a')`, 'probe.cjs')).toEqual(['encryptIntegrationSecretValue (alias)', 'encryptIntegrationSecretValue'])
    expect(count(`async function f(security) { return security.encrypt('a') }`, 'probe.cjs')).toEqual(['encrypt'])
    expect(count(`async function f(store) { return store['encrypt']('a') }`, 'probe.cjs')).toEqual(['encrypt'])
    expect(count(`const crypto = require('node:crypto')\nconst c = crypto.createCipheriv('aes-256-gcm', k, iv)`, 'probe.cjs')).toEqual(['createCipheriv'])
    expect(count(`import { createCipheriv } from 'node:crypto'\nconst c = (createCipheriv)('aes-256-gcm', k, iv)`)).toEqual(['createCipheriv'])
    expect(count(`module.exports = { normalizeStoredIntegrationSecretValue }`, 'probe.cjs')).toEqual(['normalizeStoredIntegrationSecretValue'])
    // aliases of the GENERIC primitives: the alias site, then each call under the original name
    expect(count(`import { createCipheriv as mk } from 'node:crypto'\nconst c = mk('aes-256-gcm', k, iv)`)).toEqual(['createCipheriv (alias)', 'createCipheriv'])
    expect(count(`async function f(security) { const { encrypt: seal } = security; return seal('a') }`, 'probe.cjs')).toEqual(['encrypt (alias)', 'encrypt'])
    expect(count(`const { createCipheriv: mk } = require('node:crypto')\nconst c = (mk)('aes-256-gcm', k, iv)`, 'probe.cjs')).toEqual(['createCipheriv (alias)', 'createCipheriv'])
    // .mts / .cts sources parse as TypeScript
    expect(count(`import { createCipheriv } from 'node:crypto'\nexport const c = (k: Buffer, iv: Buffer) => createCipheriv('aes-256-gcm', k, iv)`, 'probe.mts')).toEqual(['createCipheriv'])
    expect(count(`const crypto = require('node:crypto') as typeof import('node:crypto')\nexport const c = crypto.createCipheriv('aes-256-gcm', k as Buffer, iv)`, 'probe.cts')).toEqual(['createCipheriv'])
  })

  it('treats .mts / .cts as sources, and every declaration / test file as not', () => {
    for (const name of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.cjs', 'a.mjs']) {
      expect({ name, scanned: isScannableFile(name) }).toEqual({ name, scanned: true })
    }
    for (const name of ['a.d.ts', 'a.d.mts', 'a.d.cts', 'a.test.ts', 'a.spec.mts', 'a.test.cjs', 'a.json', 'a.md']) {
      expect({ name, scanned: isScannableFile(name) }).toEqual({ name, scanned: false })
    }
  })

  it('ignores comments, strings, declarations, object keys and non-sealing calls', () => {
    expect(count(`// encryptStoredSecretValue (NOT normalize)\n/* createCipheriv( */\nconst s = 'normalizeStoredSecretValue(x)'`)).toEqual([])
    expect(count(`export function normalizeStoredSecretValue(value: string) { return value }`)).toEqual([])
    expect(count(`const options = { encrypt: true, encryptStoredSecretValue: 1 }\nconst decipher = crypto.createDecipheriv('aes-256-gcm', k, iv)`)).toEqual([])
    expect(count(`class S { async encrypt(data: string) { return data } }`)).toEqual([])
    expect(count(`export { encryptStoredSecretValue } from './encrypted-secrets'`)).toEqual([])
  })

  it('in-memory mutation: a new writer spliced into a real file turns the pinned census red, by name', () => {
    const victim = 'packages/core-backend/src/routes/admin-routes.ts'
    const original = readRepoFile(victim)
    const mutated = `${original}\nimport { normalizeStoredSecretValue as eadmSeal } from '../security/encrypted-secrets'\nexport const eadmProbe = eadmSeal('fixture')\n`
    const drift = censusDrift(countSealingSites(scanTree((rel) => (rel === victim ? mutated : readRepoFile(rel)))))
    expect(drift).toEqual([
      newSite(`${victim} :: normalizeStoredSecretValue (alias)`),
      newSite(`${victim} :: normalizeStoredSecretValue`),
    ])
  })

  it('in-memory mutation: a new plugin module that seals through the host security service turns it red', () => {
    const newFile = 'plugins/plugin-after-sales/lib/eadm-webhook-secret-store.cjs'
    const source = `'use strict'\nasync function saveWebhookSecret(context, value) {\n  return context.services.security.encrypt(value)\n}\nmodule.exports = { saveWebhookSecret }\n`
    const drift = censusDrift(countSealingSites(scanTree((rel) => (rel === newFile ? source : readRepoFile(rel)), [newFile])))
    expect(drift).toEqual([newSite(`${newFile} :: encrypt`)])
  })

  it('in-memory mutation: a cipher in a new .mts script turns it red', () => {
    const newFile = 'packages/core-backend/scripts/eadm-reseal.mts'
    const source = `import { createCipheriv, randomBytes } from 'node:crypto'\nexport const sealed = createCipheriv('aes-256-gcm', randomBytes(32), randomBytes(12))\n`
    const drift = censusDrift(countSealingSites(scanTree((rel) => (rel === newFile ? source : readRepoFile(rel)), [newFile])))
    expect(drift).toEqual([newSite(`${newFile} :: createCipheriv`)])
  })

  it('in-memory mutation: a re-implementation of the `enc:` format in core turns it red', () => {
    const victim = 'packages/core-backend/src/services/elearning-notification-dingtalk.ts'
    const original = readRepoFile(victim)
    const mutated = `${original}\nimport crypto from 'node:crypto'\nexport function eadmSeal(key: Buffer, iv: Buffer) { return crypto.createCipheriv('aes-256-gcm', key, iv) }\n`
    const drift = censusDrift(countSealingSites(scanTree((rel) => (rel === victim ? mutated : readRepoFile(rel)))))
    expect(drift).toEqual([newSite(`${victim} :: createCipheriv`)])
  })
})
