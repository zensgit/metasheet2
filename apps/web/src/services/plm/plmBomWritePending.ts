/**
 * Browser-durable frozen personal BOM writes.
 *
 * The snapshot is the request that may already have been accepted. Retries replay it.
 * Identity comes from server binding metadata: owner, Meta tenant, and the native
 * person, origin, and scope. This module does not read tokens, session signatures,
 * or principal keys. A `token:` principal fallback or a session-signature string
 * is not a scope field and is not stored. Success is decided only by a native receipt.
 *
 * One tab is single-threaded. Two tabs can both scan, see no record, and then store.
 * Each frozen operation therefore has its own storage key. A write replaces only that
 * key. Recovery scans the scoped keys and does not rewrite another operation.
 * A same-target 412, 422, or identity mismatch keeps the unresolved snapshot.
 * A separate explicit commit may store another operation beside it. Nothing here
 * rotates or refreezes an existing snapshot on its own.
 * A target list keeps every owner. Pass ownerId only to scope a display.
 * That filter does not remove another owner's record.
 */

export const BOM_WRITE_PENDING_STORAGE_KEY = 'metasheet.plm.bom-write-pending.v1'

export type BomWriteOperationKind = 'line' | 'eco-intent'

export interface BomWriteIdentity {
  ownerId: string
  metaTenantId: string | null
  dataSourceId: string
  connectionId: string
  subjectId: string
  targetOrigin: string
  yuantusTenantId: string
  yuantusOrgId: string
  workspaceId: string | null
  scopeKind: string
}

export interface BomWritePatch {
  quantity?: number | string | null
  uom?: string | null
  find_num?: string | null
  refdes?: string | null
}

export interface FrozenBomWrite {
  clientKey: string
  operationKind: BomWriteOperationKind
  dataSourceId: string
  partId: string
  bomLineId: string | null
  patch: BomWritePatch | null
  ifMatch: string | null
  identity: BomWriteIdentity
}

export type FrozenLookup =
  | { status: 'storage' }
  | { status: 'identity-changed' }
  | { status: 'multiple' }
  | { status: 'existing'; frozen: FrozenBomWrite }
  | { status: 'none' }

export type FreezeCommit =
  | { ok: true; mode: 'created' | 'existing'; frozen: FrozenBomWrite }
  | { ok: false; reason: 'storage' | 'identity-changed' | 'multiple' }

export interface BomWritePendingStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  keys(): string[]
}

export interface BomWritePendingHelper {
  findFrozenBomWrite(candidate: FrozenCandidate): FrozenLookup
  commitFrozenBomWrite(candidate: FrozenBomWrite, options?: { separate?: boolean }): FreezeCommit
  removeFrozenBomWrite(frozen: FrozenRemoval): boolean
  listFrozenBomWritesForTarget(dataSourceId: string, partId: string, ownerId?: string): FrozenBomWrite[] | null
}

type FrozenCandidate = Pick<FrozenBomWrite, 'operationKind' | 'dataSourceId' | 'partId' | 'bomLineId' | 'identity'> & {
  pinClientKey?: string
}

type FrozenRemoval = Pick<FrozenBomWrite, 'clientKey' | 'operationKind' | 'dataSourceId' | 'partId' | 'bomLineId' | 'identity'>

const PATCH_KEYS = ['quantity', 'uom', 'find_num', 'refdes'] as const
const RECORD_PREFIX = `${BOM_WRITE_PENDING_STORAGE_KEY}.`
const IRRECOVERABLE_PREFIX = 'metasheet.plm.bom-write-irrecoverable.v1.'

function browserStorage(): BomWritePendingStorage {
  const storage = globalThis.localStorage
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
    keys: () => {
      const names: string[] = []
      for (let index = 0; index < storage.length; index += 1) {
        const name = storage.key(index)
        if (name) names.push(name)
      }
      return names
    },
  }
}

function recordKey(frozen: Pick<FrozenBomWrite, 'clientKey' | 'operationKind' | 'dataSourceId' | 'partId' | 'bomLineId' | 'identity'>): string {
  return RECORD_PREFIX + encodeURIComponent(JSON.stringify([
    frozen.clientKey,
    frozen.operationKind,
    frozen.dataSourceId,
    frozen.partId,
    frozen.bomLineId,
    bucketIdForBomWrite(frozen.identity),
  ]))
}

function principalMaterial(value: string): boolean {
  return value.startsWith('token:') || value.startsWith('["')
}

function text(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max || principalMaterial(trimmed)) return null
  return trimmed
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null
  return text(value) ?? undefined
}

function clientKey(value: unknown): string | null {
  const key = text(value, 200)
  if (!key || key.includes('.') || /yua_|yuw_|bearer/i.test(key)) return null
  return key
}

function identityOf(value: unknown): BomWriteIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 10) return null
  const ownerId = text(row.ownerId)
  const dataSourceId = text(row.dataSourceId)
  const connectionId = text(row.connectionId)
  const subjectId = text(row.subjectId)
  const targetOrigin = text(row.targetOrigin)
  const yuantusTenantId = text(row.yuantusTenantId)
  const yuantusOrgId = text(row.yuantusOrgId)
  const scopeKind = text(row.scopeKind)
  const metaTenantId = nullableText(row.metaTenantId)
  const workspaceId = nullableText(row.workspaceId)
  if (!ownerId || !dataSourceId || !connectionId || !subjectId || !targetOrigin
    || !yuantusTenantId || !yuantusOrgId || !scopeKind
    || metaTenantId === undefined || workspaceId === undefined) return null
  return {
    ownerId,
    metaTenantId,
    dataSourceId,
    connectionId,
    subjectId,
    targetOrigin,
    yuantusTenantId,
    yuantusOrgId,
    workspaceId,
    scopeKind,
  }
}

export function sameBomWriteIdentity(left: BomWriteIdentity, right: BomWriteIdentity): boolean {
  return left.ownerId === right.ownerId
    && left.metaTenantId === right.metaTenantId
    && left.dataSourceId === right.dataSourceId
    && left.connectionId === right.connectionId
    && left.subjectId === right.subjectId
    && left.targetOrigin === right.targetOrigin
    && left.yuantusTenantId === right.yuantusTenantId
    && left.yuantusOrgId === right.yuantusOrgId
    && left.workspaceId === right.workspaceId
    && left.scopeKind === right.scopeKind
}

export function bucketIdForBomWrite(identity: BomWriteIdentity): string {
  return JSON.stringify([
    identity.ownerId,
    identity.metaTenantId,
    identity.dataSourceId,
    identity.connectionId,
    identity.subjectId,
    identity.targetOrigin,
    identity.yuantusTenantId,
    identity.yuantusOrgId,
    identity.workspaceId,
    identity.scopeKind,
  ])
}

function slotKey(row: Pick<FrozenBomWrite, 'operationKind' | 'partId' | 'bomLineId'>): string {
  return JSON.stringify([row.operationKind, row.partId, row.bomLineId])
}

// Native linePatchBody stores a JSON scalar as given. Empty is a value. There is no trim,
// header cap, or ASCII whitelist. NUL is not text, and a lone surrogate is not Unicode.
function jsonCellText(value: string): boolean {
  if (value.includes('\u0000')) return false
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
        continue
      }
      return false
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

function patchOf(value: unknown): BomWritePatch | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (Object.keys(row).some((key) => !PATCH_KEYS.includes(key as typeof PATCH_KEYS[number]))) return undefined
  const patch: BomWritePatch = {}
  if ('quantity' in row) {
    const quantity = row.quantity
    if (typeof quantity === 'number') {
      if (!Number.isFinite(quantity)) return undefined
      patch.quantity = quantity
    } else if (quantity === null) {
      patch.quantity = null
    } else if (typeof quantity === 'string') {
      if (!jsonCellText(quantity)) return undefined
      patch.quantity = quantity
    } else {
      return undefined
    }
  }
  for (const key of ['uom', 'find_num', 'refdes'] as const) {
    if (!(key in row)) continue
    const cell = row[key]
    if (cell === null) {
      patch[key] = null
      continue
    }
    if (typeof cell !== 'string' || !jsonCellText(cell)) return undefined
    patch[key] = cell
  }
  return patch
}

function frozenOf(value: unknown): FrozenBomWrite | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 8) return null
  const key = clientKey(row.clientKey)
  const dataSourceId = text(row.dataSourceId)
  const partId = text(row.partId)
  const identity = identityOf(row.identity)
  const patch = patchOf(row.patch)
  const ifMatch = row.ifMatch === null ? null : text(row.ifMatch)
  const kind = row.operationKind
  const lineId = row.bomLineId === null ? null : text(row.bomLineId)
  if (!key || !dataSourceId || !partId || !identity || patch === undefined || ifMatch === null && row.ifMatch !== null) return null
  if (identity.dataSourceId !== dataSourceId) return null
  if (kind !== 'line' && kind !== 'eco-intent') return null
  if (kind === 'line') {
    if (!lineId || !patch || Object.keys(patch).length === 0) return null
  } else if (lineId !== null || patch !== null || ifMatch !== null) {
    return null
  }
  return {
    clientKey: key,
    operationKind: kind,
    dataSourceId,
    partId,
    bomLineId: lineId,
    patch,
    ifMatch,
    identity,
  }
}

function recordOf(value: unknown): FrozenBomWrite | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.v !== 1 || Object.keys(row).length !== 2) return null
  return frozenOf(row.frozen)
}

function readRecords(store: BomWritePendingStorage): FrozenBomWrite[] | null {
  let names: string[]
  try {
    names = store.keys()
  } catch {
    return null
  }
  const rows: FrozenBomWrite[] = []
  for (const name of names) {
    if (!name.startsWith(RECORD_PREFIX)) continue
    let raw: string | null
    try {
      raw = store.getItem(name)
    } catch {
      return null
    }
    if (raw == null || raw === '') return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      return null
    }
    const frozen = recordOf(parsed)
    if (!frozen || name !== recordKey(frozen)) return null
    rows.push(frozen)
  }
  return rows
}

function scan(rows: FrozenBomWrite[], candidate: FrozenCandidate): FrozenLookup {
  const slot = slotKey(candidate)
  const current: FrozenBomWrite[] = []
  let foreign = false
  for (const row of rows) {
    if (row.dataSourceId !== candidate.dataSourceId || slotKey(row) !== slot) continue
    if (sameBomWriteIdentity(row.identity, candidate.identity)) current.push(row)
    else foreign = true
  }
  // A pinned or current-identity row is resolved before a foreign scope in the same slot can block it.
  if (candidate.pinClientKey) {
    const exact = current.find((row) => row.clientKey === candidate.pinClientKey)
    if (exact) return { status: 'existing', frozen: exact }
    if (current.length > 0) return { status: 'multiple' }
    if (foreign) return { status: 'identity-changed' }
    return { status: 'none' }
  }
  if (current.length > 1) return { status: 'multiple' }
  if (current.length === 1) return { status: 'existing', frozen: current[0] }
  if (foreign) return { status: 'identity-changed' }
  return { status: 'none' }
}

function refuse(found: FrozenLookup): FreezeCommit | null {
  if (found.status === 'identity-changed') return { ok: false, reason: 'identity-changed' }
  if (found.status === 'multiple') return { ok: false, reason: 'multiple' }
  if (found.status === 'existing') return { ok: true, mode: 'existing', frozen: found.frozen }
  if (found.status !== 'none') return { ok: false, reason: 'storage' }
  return null
}

function findIn(store: BomWritePendingStorage, candidate: FrozenCandidate): FrozenLookup {
  const rows = readRecords(store)
  if (!rows) return { status: 'storage' }
  return scan(rows, candidate)
}

function storedExact(rows: FrozenBomWrite[], frozen: FrozenBomWrite): FrozenBomWrite | null {
  return rows.find((row) => row.clientKey === frozen.clientKey
    && row.operationKind === frozen.operationKind
    && row.dataSourceId === frozen.dataSourceId
    && row.partId === frozen.partId
    && row.bomLineId === frozen.bomLineId
    && sameBomWriteIdentity(row.identity, frozen.identity)) ?? null
}

function commitIn(
  store: BomWritePendingStorage,
  candidate: FrozenBomWrite,
  separate = false,
): FreezeCommit {
  const frozen = frozenOf(candidate)
  if (!frozen) return { ok: false, reason: 'storage' }
  const rows = readRecords(store)
  if (!rows) return { ok: false, reason: 'storage' }
  if (!separate) {
    const blocked = refuse(scan(rows, frozen))
    if (blocked) return blocked
  } else {
    const same = storedExact(rows, frozen)
    if (same) return { ok: true, mode: 'existing', frozen: same }
  }
  const key = recordKey(frozen)
  try {
    if (store.getItem(key) != null) {
      const again = readRecords(store)
      if (!again) return { ok: false, reason: 'storage' }
      const same = storedExact(again, frozen)
      if (same) return { ok: true, mode: 'existing', frozen: same }
      return separate ? { ok: false, reason: 'storage' } : (refuse(scan(again, frozen)) ?? { ok: false, reason: 'storage' })
    }
    store.setItem(key, JSON.stringify({ v: 1, frozen }))
  } catch {
    return { ok: false, reason: 'storage' }
  }
  return { ok: true, mode: 'created', frozen }
}

function removeIn(store: BomWritePendingStorage, frozen: FrozenRemoval): boolean {
  const key = clientKey(frozen.clientKey)
  if (!key) return false
  const rows = readRecords(store)
  if (!rows) return false
  const match = rows.find((row) => row.clientKey === key
    && row.operationKind === frozen.operationKind
    && row.dataSourceId === frozen.dataSourceId
    && row.partId === frozen.partId
    && row.bomLineId === frozen.bomLineId
    && sameBomWriteIdentity(row.identity, frozen.identity))
  if (!match) return false
  try {
    store.removeItem(recordKey(match))
    try {
      store.removeItem(`${IRRECOVERABLE_PREFIX}${match.clientKey}`)
    } catch {
      // The snapshot is already gone. A marker left behind does not restore it.
    }
    return true
  } catch {
    return false
  }
}

export function rememberIrrecoverableBomWrite(
  operationKey: string,
  status: 412 | 422,
  store: BomWritePendingStorage = browserStorage(),
): boolean {
  const key = clientKey(operationKey)
  if (!key || (status !== 412 && status !== 422)) return false
  try {
    store.setItem(`${IRRECOVERABLE_PREFIX}${key}`, JSON.stringify({ v: 1, clientKey: key, status }))
    return true
  } catch {
    return false
  }
}

export function irrecoverableBomWriteKeys(store: BomWritePendingStorage = browserStorage()): string[] {
  try {
    const keys: string[] = []
    for (const name of store.keys()) {
      if (!name.startsWith(IRRECOVERABLE_PREFIX)) continue
      const raw = store.getItem(name)
      if (!raw) continue
      let parsed: { v?: unknown; clientKey?: unknown; status?: unknown }
      try {
        parsed = JSON.parse(raw) as { v?: unknown; clientKey?: unknown; status?: unknown }
      } catch {
        continue
      }
      if (parsed.v !== 1 || (parsed.status !== 412 && parsed.status !== 422)) continue
      if (parsed.clientKey !== name.slice(IRRECOVERABLE_PREFIX.length)) continue
      keys.push(parsed.clientKey)
    }
    return keys
  } catch {
    return []
  }
}

function listIn(
  store: BomWritePendingStorage,
  dataSourceId: string,
  partId: string,
  ownerId?: string,
): FrozenBomWrite[] | null {
  const rows = readRecords(store)
  if (!rows) return null
  return rows.filter((row) => row.dataSourceId === dataSourceId
    && row.partId === partId
    && (ownerId === undefined || row.identity.ownerId === ownerId))
}

export function openBomWritePending(store: BomWritePendingStorage = browserStorage()): BomWritePendingHelper {
  return {
    findFrozenBomWrite: (candidate) => findIn(store, candidate),
    commitFrozenBomWrite: (candidate, options) => commitIn(store, candidate, options?.separate === true),
    removeFrozenBomWrite: (frozen) => removeIn(store, frozen),
    listFrozenBomWritesForTarget: (dataSourceId, partId, ownerId) => listIn(store, dataSourceId, partId, ownerId),
  }
}

export function findFrozenBomWrite(
  candidate: FrozenCandidate,
  store: BomWritePendingStorage = browserStorage(),
): FrozenLookup {
  return findIn(store, candidate)
}

export function commitFrozenBomWrite(
  candidate: FrozenBomWrite,
  store: BomWritePendingStorage = browserStorage(),
  options?: { separate?: boolean },
): FreezeCommit {
  return commitIn(store, candidate, options?.separate === true)
}

export function removeFrozenBomWrite(
  frozen: FrozenRemoval,
  store: BomWritePendingStorage = browserStorage(),
): boolean {
  return removeIn(store, frozen)
}

export function listFrozenBomWritesForTarget(
  dataSourceId: string,
  partId: string,
  store: BomWritePendingStorage = browserStorage(),
  ownerId?: string,
): FrozenBomWrite[] | null {
  return listIn(store, dataSourceId, partId, ownerId)
}
