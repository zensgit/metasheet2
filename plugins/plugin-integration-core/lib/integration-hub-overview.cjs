'use strict'

// ---------------------------------------------------------------------------
// 对接总览 (integration hub overview) — the JOIN no page renders today.
//
// WHAT QUESTION THIS ANSWERS. "当前系统对接了哪些系统、各用哪个连接、谁在用、状态如何".
// Every fact needed to answer it already exists in this plugin, but it is spread across five
// independent reads that no single surface has ever put side by side:
//
//   1. integration_external_systems           — WHICH systems are registered (name/kind/role/status)
//   2. data_sources (via the host facade)     — WHICH connection a `data-source:*` bridge points at
//   3. the stock-prep table-action binding    — server config; the 备料 action names ONE system
//   4. integration_pipelines                  — source_system_id / target_system_id
//   5. approved read-source configs + compositions — count of approved bindings per system
//
// This module is the PURE projection over those five inputs. It performs no I/O of its own: the
// route layer gathers, this file decides. That split is deliberate — the values-free boundary is
// then a property of ONE small pure function that a test can drive with a poisoned fixture.
//
// ===========================================================================================
// VALUES-FREE HARD BOUNDARY (the reason this file exists as its own module)
// ===========================================================================================
// ALLOWED OUT: operator-authored LABELS and opaque IDS — external system `name`, pipeline `name`,
// data source `name`, the `kind` token, role/status enums, `lastTestedAt` timestamps, and counts.
// An operator typed those names into this product to recognize their own systems; showing them
// back is the entire point of the screen.
//
// NEVER OUT: anything from `external_system.config` other than the `dataSourceId` POINTER, and
// anything at all from a data source beyond {name, type, status}. Concretely refused: baseUrl,
// host, port, database, schema, username, connection strings, DSNs, credential fingerprints,
// credential formats, `hasCredentials`, `capabilities`, and `last_error` TEXT.
//
// WHY `lastError` TEXT IS REFUSED even though the column is part of the story this screen tells:
// it is free-form text produced by an adapter or a driver, and a driver error is the single most
// likely place in this whole schema for a DSN, a host:port or a username to appear verbatim
// ("failed to connect to sqlserver://svc_plm@10.2.3.4:1433/PLMDB"). The screen needs to say
// "上次测试失败", not to quote the failure — so this module emits the BOOLEAN `hasLastError` and
// drops the string. The full text stays available where it already was, on the connection editor.
//
// STRUCTURAL, not incidental: `projectSystem` below builds its output object from named literals.
// There is no spread of a source row anywhere in this file, so a column added to
// integration_external_systems tomorrow cannot silently start appearing on this screen.
// ---------------------------------------------------------------------------

const { isK3ExternalWriteTargetKind } = require('./k3-external-write-permanent-fence.cjs')

// ---------------------------------------------------------------------------
// Connector kinds, in plain words.
//
// `kind` is a free-form string on the table (external-systems.cjs takes any `requiredString`), so
// this map is a DISPLAY register, not a vocabulary: an unregistered kind renders as 自定义连接器
// and its raw token is carried verbatim in the 技术详情 disclosure. Nothing here rejects a kind.
//
// `connection` says WHERE this kind's connection lives, which is the difference the screen has to
// make legible:
//   'data-source'    — the system is a BRIDGE: the real connection is a data_sources row and
//                      `config.dataSourceId` points at it. These two kinds are the only ones that
//                      carry that pointer.
//   'self-contained' — the system holds its own endpoint + credentials (K3 WebAPI, PLM, HTTP).
//                      Nothing to join; the card says 自带连接.
//   'internal'       — no external connection at all; the "system" is this product's own tables.
// ---------------------------------------------------------------------------
const CONNECTOR_KIND_REGISTER = Object.freeze({
  'data-source:sql-readonly': {
    label: { zh: '只读数据库桥接', en: 'Read-only database bridge' },
    connection: 'data-source',
  },
  'data-source:sql-write-gated': {
    label: { zh: '写入受闸数据库桥接', en: 'Write-gated database bridge' },
    connection: 'data-source',
  },
  'erp:k3-wise-webapi': {
    label: { zh: '金蝶 K3 WISE 接口', en: 'Kingdee K3 WISE WebAPI' },
    connection: 'self-contained',
  },
  'erp:k3-wise-sqlserver': {
    label: { zh: '金蝶 K3 数据库通道', en: 'K3 SQL Server channel' },
    connection: 'self-contained',
  },
  'plm:yuantus-wrapper': {
    label: { zh: '元图 PLM 接口', en: 'Yuantus PLM' },
    connection: 'self-contained',
  },
  'bridge:legacy-sql-readonly': {
    label: { zh: '旧库只读桥接 (Bridge Agent)', en: 'Legacy read-only bridge (Bridge Agent)' },
    connection: 'self-contained',
  },
  'metasheet:staging': {
    label: { zh: '本系统暂存表', en: 'Metasheet staging tables' },
    connection: 'internal',
  },
  'metasheet:multitable': {
    label: { zh: '本系统多维表', en: 'Metasheet multitable' },
    connection: 'internal',
  },
  http: {
    label: { zh: '通用 HTTP 接口', en: 'Generic HTTP endpoint' },
    connection: 'self-contained',
  },
})

const UNREGISTERED_KIND = Object.freeze({
  label: { zh: '自定义连接器', en: 'Custom connector' },
  connection: 'self-contained',
})

// ---------------------------------------------------------------------------
// Write capability, per kind — and the honest 'unregistered' state.
//
// The temptation on a summary screen is to print 只读 for every kind whose adapter looks read-only.
// That would be an ABSOLUTE CLAIM, and two kinds falsify it: `http` declares roles
// source/target/bidirectional and has a real upsert path behind the outbound write gate, and
// `erp:k3-wise-sqlserver` declares a middle-table write mode in its own adapter metadata. So this
// register states only what it can defend, and says 'unregistered' — rendered as "以连接管理为准",
// not as 只读 — for everything else. A screen that says nothing is recoverable; a screen that says
// "this never writes" about something that does is not.
//
//   'none'         — the adapter has no write path at all (guardrails.write.supported === false).
//   'internal'     — writes land in THIS product's own multitable, never outside it.
//   'gated'        — writes exist but only through the C6 token-bound apply gate.
//   'fenced'       — K3 external write-back is permanently banned; see the fence module.
//   'unregistered' — this register makes no claim. Defer to 连接管理.
//
// READS are real for every kind — that is what all of these connectors are for — so `reads` is a
// constant and is stated once rather than per entry.
// ---------------------------------------------------------------------------
const WRITE_CAPABILITY_REGISTER = Object.freeze({
  'metasheet:multitable': 'internal',
  'data-source:sql-write-gated': 'gated',
  'data-source:sql-readonly': 'none',
  'bridge:legacy-sql-readonly': 'none',
  'metasheet:staging': 'none',
  'plm:yuantus-wrapper': 'none',
})

// §10.1 of the Human-Governance solution v1.2, restated for an operator rather than for a log line.
// Sourced against `isK3ExternalWriteTargetKind` so the sentence and the actual runtime fence can
// never name different kinds.
const K3_FENCE_NOTICE = Object.freeze({
  zh: '只读·永不写入',
  en: 'Read-only · never writes',
})

const WRITE_NOTICE = Object.freeze({
  none: { zh: '只读', en: 'Read-only' },
  internal: { zh: '仅写入本系统表', en: 'Writes only to Metasheet tables' },
  gated: { zh: '写入需 C6 审批闸门', en: 'Writes require the C6 apply gate' },
  fenced: K3_FENCE_NOTICE,
  unregistered: { zh: '写入能力以连接管理为准', en: 'See Connections for write capability' },
})

const TABLE_ACTION_LABELS = Object.freeze({
  'plm.stock-preparation.pull-bom.v1': { zh: 'BOM备料·同步', en: 'BOM stock-prep · sync' },
})

const GENERIC_TABLE_ACTION_LABEL = Object.freeze({ zh: '表格操作', en: 'Table action' })

const CONSUMER_LABELS = Object.freeze({
  'read-source-config': { zh: '已审批读取源', en: 'Approved read sources' },
  'read-source-composition': { zh: '已审批读取组合', en: 'Approved read compositions' },
})

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function trimmedString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function describeConnectorKind(kind) {
  const key = typeof kind === 'string' ? kind.trim() : ''
  const entry = Object.prototype.hasOwnProperty.call(CONNECTOR_KIND_REGISTER, key)
    ? CONNECTOR_KIND_REGISTER[key]
    : null
  return {
    // The RAW token, verbatim, for the 技术详情 disclosure. Never "prettified".
    kind: key,
    label: { ...(entry || UNREGISTERED_KIND).label },
    connectionModel: (entry || UNREGISTERED_KIND).connection,
    registered: Boolean(entry),
  }
}

function describeWriteCapability(kind) {
  const key = typeof kind === 'string' ? kind.trim() : ''
  // The fence is asked FIRST and it is asked through the fence module's own predicate, so this
  // screen can never disagree with the runtime about which kind is banned.
  const writes = isK3ExternalWriteTargetKind(key)
    ? 'fenced'
    : (Object.prototype.hasOwnProperty.call(WRITE_CAPABILITY_REGISTER, key)
      ? WRITE_CAPABILITY_REGISTER[key]
      : 'unregistered')
  return {
    reads: 'real',
    writes,
    fenced: writes === 'fenced',
    notice: { ...WRITE_NOTICE[writes] },
  }
}

/**
 * The `data-source:*` bridge pointer, and ONLY the pointer.
 *
 * `config` on a public external-system row has already been through `sanitizeIntegrationPayload`,
 * but that sanitizer targets SECRET-shaped keys (token/password/connectionString/...). It does NOT
 * strip `baseUrl`, `host`, `port`, `database` or `username` — those are not secrets, they are
 * connection details, and this screen has no business showing them either. So nothing here reads
 * `config` as an object: it pulls one string by name and drops the rest on the floor.
 */
function readDataSourcePointer(system) {
  const canonical = trimmedString(system && system.connectionId)
  if (canonical) return canonical
  const config = isPlainObject(system && system.config) ? system.config : null
  if (!config) return null
  return trimmedString(config.dataSourceId)
}

function projectConnection({ kindInfo, dataSourceId, descriptor, directoryAvailable }) {
  if (kindInfo.connectionModel === 'internal') {
    return { model: 'internal', bound: false, dataSourceId: null, resolved: false, name: null, type: null, status: null, unresolvedReason: null }
  }
  if (kindInfo.connectionModel === 'self-contained') {
    return { model: 'self-contained', bound: true, dataSourceId: null, resolved: false, name: null, type: null, status: null, unresolvedReason: null }
  }
  if (!dataSourceId) {
    return { model: 'data-source', bound: false, dataSourceId: null, resolved: false, name: null, type: null, status: null, unresolvedReason: 'not_bound' }
  }
  if (descriptor && descriptor.resolved === true) {
    return {
      model: 'data-source',
      bound: true,
      dataSourceId,
      resolved: true,
      // Exactly three fields, named one by one. A descriptor that grew a `connection` key
      // tomorrow would still not reach this response.
      name: trimmedString(descriptor.name),
      type: trimmedString(descriptor.type),
      status: trimmedString(descriptor.status),
      unresolvedReason: null,
    }
  }
  return {
    model: 'data-source',
    bound: true,
    dataSourceId,
    resolved: false,
    name: null,
    type: null,
    status: null,
    // 'not_visible' — the row exists but is owned by someone else (data_sources rows are
    // per-user-owned; the host facade's assertAccess deliberately does not distinguish
    // "deleted" from "not yours", and neither does this screen). The card says
    // 连接:已配置(他人管理) rather than inventing a name it is not allowed to see.
    // 'directory_unavailable' — this deployment's host exposes no descriptor seam at all, so
    // NOTHING is being said about ownership.
    unresolvedReason: directoryAvailable ? 'not_visible' : 'directory_unavailable',
  }
}

function tableActionLabel(actionId) {
  return Object.prototype.hasOwnProperty.call(TABLE_ACTION_LABELS, actionId)
    ? { ...TABLE_ACTION_LABELS[actionId] }
    : { ...GENERIC_TABLE_ACTION_LABEL }
}

/**
 * WHO IS USING THIS SYSTEM — the half of the join that is genuinely server-side.
 *
 * A consumer is anything that would BREAK if the system were deleted or repointed. Four kinds
 * exist today and all four are named in plain words, because "谁在用" is the question an operator
 * actually asks before touching a connection.
 */
function collectConsumers({ systemId, tableActionBindings, pipelines, readSourceConfigs, compositionsBySystemId }) {
  const consumers = []

  for (const binding of tableActionBindings) {
    if (binding.externalSystemId !== systemId) continue
    consumers.push({
      type: 'table-action',
      id: binding.actionId,
      name: null,
      label: tableActionLabel(binding.actionId),
      role: 'source',
      count: 1,
    })
  }

  for (const pipeline of pipelines) {
    // A pipeline can name the same system on BOTH ends (a self-referential move). Emit one entry
    // per END rather than per pipeline, so the card does not silently drop the second reference.
    if (pipeline.sourceSystemId === systemId) {
      consumers.push({ type: 'pipeline', id: pipeline.id, name: pipeline.name || null, label: { zh: '流程(源)', en: 'Pipeline (source)' }, role: 'source', count: 1 })
    }
    if (pipeline.targetSystemId === systemId) {
      consumers.push({ type: 'pipeline', id: pipeline.id, name: pipeline.name || null, label: { zh: '流程(目标)', en: 'Pipeline (target)' }, role: 'target', count: 1 })
    }
  }

  const approvedReadConfigs = readSourceConfigs.filter((config) => config.systemId === systemId).length
  if (approvedReadConfigs > 0) {
    consumers.push({
      type: 'read-source-config',
      id: null,
      name: null,
      label: { ...CONSUMER_LABELS['read-source-config'] },
      role: 'source',
      count: approvedReadConfigs,
    })
  }

  const approvedCompositions = compositionsBySystemId.get(systemId)
  if (approvedCompositions && approvedCompositions.size > 0) {
    consumers.push({
      type: 'read-source-composition',
      id: null,
      name: null,
      label: { ...CONSUMER_LABELS['read-source-composition'] },
      role: 'source',
      count: approvedCompositions.size,
    })
  }

  return consumers
}

/**
 * Approved compositions reach a system through TWO hops: a composition step names a read-source
 * config id, and that config names the system. Resolving it here (rather than pretending
 * compositions carry a system_id column, which they do not) is what makes the composition count
 * on the card true.
 */
function indexCompositionsBySystemId(compositions, readSourceConfigs) {
  const systemIdByConfigId = new Map()
  for (const config of readSourceConfigs) {
    const id = trimmedString(config && config.id)
    const systemId = trimmedString(config && config.systemId)
    if (id && systemId) systemIdByConfigId.set(id, systemId)
  }

  const bySystemId = new Map()
  for (const composition of compositions) {
    const compositionId = trimmedString(composition && composition.id)
    if (!compositionId) continue
    const config = isPlainObject(composition.config) ? composition.config : null
    const steps = config && Array.isArray(config.steps) ? config.steps : []
    for (const step of steps) {
      const configId = trimmedString(step && step.readSourceConfigId)
      if (!configId) continue
      const systemId = systemIdByConfigId.get(configId)
      if (!systemId) continue
      if (!bySystemId.has(systemId)) bySystemId.set(systemId, new Set())
      // A Set of composition ids, not a counter: a two-step composition whose BOTH steps read the
      // same system is ONE composition using it, not two.
      bySystemId.get(systemId).add(compositionId)
    }
  }
  return bySystemId
}

function projectSystem(system, context) {
  const kindInfo = describeConnectorKind(system.kind)
  const dataSourceId = kindInfo.connectionModel === 'data-source' ? readDataSourcePointer(system) : null
  const descriptor = dataSourceId ? context.dataSourceDescriptors.get(dataSourceId) : null
  const systemId = trimmedString(system.id) || ''

  return {
    id: systemId,
    // Operator-authored label. This is the one string on the card that makes the screen usable.
    name: trimmedString(system.name),
    kind: kindInfo.kind,
    kindLabel: kindInfo.label,
    kindRegistered: kindInfo.registered,
    role: trimmedString(system.role),
    status: trimmedString(system.status),
    lastTestedAt: system.lastTestedAt ?? null,
    // BOOLEAN, never the text. See the module header.
    hasLastError: Boolean(trimmedString(system.lastError)),
    connection: projectConnection({
      kindInfo,
      dataSourceId,
      descriptor,
      directoryAvailable: context.dataSourceDirectoryAvailable,
    }),
    writeCapability: describeWriteCapability(system.kind),
    consumers: collectConsumers({
      systemId,
      tableActionBindings: context.tableActionBindings,
      pipelines: context.pipelines,
      readSourceConfigs: context.readSourceConfigs,
      compositionsBySystemId: context.compositionsBySystemId,
    }),
    // The 技术详情(排障用) disclosure. Ids and enum tokens only — the same values already above,
    // restated unabbreviated so an operator reading a bug report can quote them without the
    // front end having to reach into the presentation fields.
    technical: {
      systemId,
      kind: kindInfo.kind,
      role: trimmedString(system.role),
      status: trimmedString(system.status),
      dataSourceId: dataSourceId || null,
      workspaceId: system.workspaceId ?? null,
      createdAt: system.createdAt ?? null,
      updatedAt: system.updatedAt ?? null,
    },
  }
}

/**
 * The whole projection. Pure: no I/O, no clock, no environment. Inputs are already-authorized,
 * already-tenant-scoped reads performed by the route.
 */
function buildIntegrationHubOverview(input = {}) {
  const systems = Array.isArray(input.systems) ? input.systems.filter(isPlainObject) : []
  const pipelines = (Array.isArray(input.pipelines) ? input.pipelines : []).filter(isPlainObject)
  const readSourceConfigs = (Array.isArray(input.readSourceConfigs) ? input.readSourceConfigs : []).filter(isPlainObject)
  const compositions = (Array.isArray(input.compositions) ? input.compositions : []).filter(isPlainObject)
  const tableActionBindings = (Array.isArray(input.tableActionBindings) ? input.tableActionBindings : [])
    .filter(isPlainObject)
    .map((binding) => ({
      actionId: trimmedString(binding.actionId) || '',
      externalSystemId: trimmedString(binding.externalSystemId) || '',
    }))
    .filter((binding) => binding.actionId && binding.externalSystemId)

  const dataSourceDescriptors = input.dataSourceDescriptors instanceof Map
    ? input.dataSourceDescriptors
    : new Map()

  const context = {
    tableActionBindings,
    pipelines,
    readSourceConfigs,
    compositionsBySystemId: indexCompositionsBySystemId(compositions, readSourceConfigs),
    dataSourceDescriptors,
    dataSourceDirectoryAvailable: input.dataSourceDirectoryAvailable === true,
  }

  const projected = systems.map((system) => projectSystem(system, context))

  return {
    systemCount: projected.length,
    systems: projected,
    dataSourceDirectory: { available: context.dataSourceDirectoryAvailable },
  }
}

/**
 * The distinct data source ids this system list would need resolved. The route calls this to know
 * what to ask the host for, so the "which kinds carry a pointer" rule lives in exactly one place.
 */
function collectDataSourcePointers(systems) {
  const ids = new Set()
  for (const system of Array.isArray(systems) ? systems : []) {
    if (!isPlainObject(system)) continue
    if (describeConnectorKind(system.kind).connectionModel !== 'data-source') continue
    const id = readDataSourcePointer(system)
    if (id) ids.add(id)
  }
  return Array.from(ids)
}

module.exports = {
  buildIntegrationHubOverview,
  collectDataSourcePointers,
  describeConnectorKind,
  describeWriteCapability,
  K3_FENCE_NOTICE,
  __internals: {
    CONNECTOR_KIND_REGISTER,
    WRITE_CAPABILITY_REGISTER,
    WRITE_NOTICE,
    indexCompositionsBySystemId,
    readDataSourcePointer,
  },
}
