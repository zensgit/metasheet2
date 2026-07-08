'use strict'

// Bridge Agent controlled apply — BA-APPLY-2a: CONTRACT / VALIDATOR ONLY (design-lock
// docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2 形态 B backend channel,
// §4 hard locks).
//
// Scope fence: this module is PURE. It validates a submitted "implementation checklist" — the SAME
// values-free, machine-readable artifact BA-APPLY-1's `buildImplementationChecklist` renders
// (apps/web/src/services/integration/bridgeAgentConfigCheck.ts: `{ schemaVersion, operations }`) —
// and returns a normalized value or fail-closed, values-free errors. It does NOT persist, audit-log,
// wire a route, call any network, create an adapter, resolve an external system, or touch ANY write
// path. There is no apply here, and never will be in this module: applying a checklist to the Bridge
// Agent is a human/ops-script action per the design-lock's form-A handoff (form B's "backend writes
// the Agent's readonly config" capability does not exist — the Agent has no config-write endpoint;
// see the BA-APPLY-2a verification MD for that blocker).
//
// Hard lock (§4 "只读不变式" / this slice's op whitelist): the operation enum is EXACT and CLOSED —
// `add_readonly_object` / `add_readonly_field` only. A write/delete/make-writable-shaped operation
// (e.g. `delete_object`, `make_writable`, `write_object`) is REJECTED, never accepted, never echoed.
// Widening ALLOWED_OPS to include a third literal is NOT authorized by this slice.
//
// Values-free discipline: every rejection is `{ code, field, reason }` where `field` is a STRUCTURAL
// PATH (e.g. `operations[0].objectName`), never the submitted value — a secret/host/connection-string
// pasted into an object/field-key name is dropped at the identifier gate and never rides into an
// error, a persisted row, or an audit entry (the store layer never even sees invalid content: this
// contract is the sole gate, called before any persistence).
//
// All-or-nothing (deliberately stricter than BA-APPLY-1's UX-friendly drop-and-count): the frontend
// silently drops an unsafe name and keeps the rest so an operator can keep working; this BACKEND
// CONTROLLED CHANNEL fails the ENTIRE submission closed if ANY operation is non-conforming — a draft
// never partially persists a mix of clean and rejected operations. Mirrors validateReadSourceConfig's
// collect-all-errors-then-reject discipline (lib/read-source-config.cjs).

// Mirrors bridgeAgentConfigCheck.ts's SAFE_IDENTIFIER_PATTERN / bridge-agent-readonly-adapter.cjs's
// SAFE_OBJECT_NAME_PATTERN — applied to BOTH object names and field-key names. A secret, host,
// connection string, or token is essentially guaranteed to contain a character outside
// `[A-Za-z0-9_]` (`=`, `;`, `:`, `.`, whitespace, …), so it fails this pattern and is rejected.
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_IDENTIFIER_LENGTH = 64

// Exact-registered, closed operation enum (design-lock §4 hard lock). This is the ONLY place the
// whitelist is declared; every consumer (validator below, the store, the routes) trusts this module's
// verdict rather than re-declaring the set.
const ALLOWED_OPS = Object.freeze(['add_readonly_object', 'add_readonly_field'])
const ALLOWED_OPS_SET = new Set(ALLOWED_OPS)

const CHECKLIST_SCHEMA_VERSION = 1
const MAX_OPERATIONS = 200
const MAX_FIELD_KEYS_PER_OPERATION = 100

const TOP_LEVEL_ALLOWED_KEYS = Object.freeze(['schemaVersion', 'operations'])
const OPERATION_ALLOWED_KEYS = Object.freeze(['op', 'objectName', 'fieldKeys'])

// Exact-registered coarse-code family (mirrors the safeErrorCode discipline in
// lib/read-source-probe-contract.cjs) — every code this validator can produce is a member of this
// frozen set. Codes are self-produced/deterministic here (never echoed from an external source), so
// no egress clamp is needed; the frozen registry exists so a test can assert completeness and so a
// future consumer never has to guess a code string.
const BRIDGE_AGENT_CHECKLIST_ERROR_CODES = Object.freeze([
  'BRIDGE_AGENT_CHECKLIST_NOT_OBJECT',
  'BRIDGE_AGENT_CHECKLIST_UNEXPECTED_FIELD',
  'BRIDGE_AGENT_CHECKLIST_SCHEMA_VERSION_INVALID',
  'BRIDGE_AGENT_CHECKLIST_OPERATIONS_INVALID',
  'BRIDGE_AGENT_CHECKLIST_OP_NOT_ALLOWED',
  'BRIDGE_AGENT_CHECKLIST_OBJECT_NAME_INVALID',
  'BRIDGE_AGENT_CHECKLIST_FIELD_KEY_INVALID',
  'BRIDGE_AGENT_CHECKLIST_FIELD_KEYS_INVALID',
])
const BRIDGE_AGENT_CHECKLIST_ERROR_CODE_SET = new Set(BRIDGE_AGENT_CHECKLIST_ERROR_CODES)

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSafeIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    SAFE_IDENTIFIER_PATTERN.test(value)
  )
}

function onlyAllowedKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

/**
 * Validates a submitted implementation checklist. Returns `{ valid: true, normalized }` or
 * `{ valid: false, errors }` where every `errors[]` entry is `{ code, field, reason }` — `field` is
 * always a fixed structural path (never a submitted value/key), and `code` is always a member of
 * `BRIDGE_AGENT_CHECKLIST_ERROR_CODES`. Never throws.
 */
function validateBridgeAgentChangeChecklist(input) {
  if (!isPlainObject(input)) {
    return {
      valid: false,
      errors: [{ code: 'BRIDGE_AGENT_CHECKLIST_NOT_OBJECT', field: '(root)', reason: 'not_object' }],
    }
  }

  const errors = []
  const push = (code, field, reason) => errors.push({ code, field, reason })

  // Strict top-level key allowlist — an unexpected key NAME is potentially attacker-controlled (a
  // secret/host/URL could be smuggled in as a JSON key rather than a value), so it is coarsened to a
  // fixed sentinel rather than echoed.
  if (!onlyAllowedKeys(input, TOP_LEVEL_ALLOWED_KEYS)) {
    push('BRIDGE_AGENT_CHECKLIST_UNEXPECTED_FIELD', '(unexpected)', 'not_allowlisted')
  }

  if (input.schemaVersion !== CHECKLIST_SCHEMA_VERSION) {
    push('BRIDGE_AGENT_CHECKLIST_SCHEMA_VERSION_INVALID', 'schemaVersion', 'must_be_1')
  }

  const operations = input.operations
  const normalizedOperations = []
  if (!Array.isArray(operations)) {
    push('BRIDGE_AGENT_CHECKLIST_OPERATIONS_INVALID', 'operations', 'must_be_array')
  } else if (operations.length > MAX_OPERATIONS) {
    push('BRIDGE_AGENT_CHECKLIST_OPERATIONS_INVALID', 'operations', 'too_many_operations')
  } else {
    operations.forEach((entry, index) => {
      const fieldPrefix = `operations[${index}]`
      if (!isPlainObject(entry)) {
        push('BRIDGE_AGENT_CHECKLIST_OPERATIONS_INVALID', fieldPrefix, 'entry_not_object')
        return
      }
      if (!onlyAllowedKeys(entry, OPERATION_ALLOWED_KEYS)) {
        push('BRIDGE_AGENT_CHECKLIST_UNEXPECTED_FIELD', `${fieldPrefix}.(unexpected)`, 'not_allowlisted')
      }

      // THE hard lock: op must be an EXACT member of the closed, registered allowlist. A
      // write/delete/make-writable-shaped literal is rejected here, unconditionally.
      const opValid = typeof entry.op === 'string' && ALLOWED_OPS_SET.has(entry.op)
      if (!opValid) {
        push('BRIDGE_AGENT_CHECKLIST_OP_NOT_ALLOWED', `${fieldPrefix}.op`, 'not_allowlisted')
      }

      const objectNameValid = isSafeIdentifier(entry.objectName)
      if (!objectNameValid) {
        push('BRIDGE_AGENT_CHECKLIST_OBJECT_NAME_INVALID', `${fieldPrefix}.objectName`, 'invalid_identifier')
      }

      const rawFieldKeys = entry.fieldKeys
      let fieldKeysShapeValid = Array.isArray(rawFieldKeys) && rawFieldKeys.length <= MAX_FIELD_KEYS_PER_OPERATION
      if (!Array.isArray(rawFieldKeys)) {
        push('BRIDGE_AGENT_CHECKLIST_FIELD_KEYS_INVALID', `${fieldPrefix}.fieldKeys`, 'must_be_array')
      } else if (rawFieldKeys.length > MAX_FIELD_KEYS_PER_OPERATION) {
        push('BRIDGE_AGENT_CHECKLIST_FIELD_KEYS_INVALID', `${fieldPrefix}.fieldKeys`, 'too_many_field_keys')
        fieldKeysShapeValid = false
      }
      const fieldKeys = []
      if (fieldKeysShapeValid) {
        rawFieldKeys.forEach((key, keyIndex) => {
          if (isSafeIdentifier(key)) {
            fieldKeys.push(key)
          } else {
            push('BRIDGE_AGENT_CHECKLIST_FIELD_KEY_INVALID', `${fieldPrefix}.fieldKeys[${keyIndex}]`, 'invalid_identifier')
          }
        })
      }

      // op <-> fieldKeys invariant (mirrors BA-APPLY-1's derivation rule, enforced here as a
      // validation invariant rather than derived): add_readonly_object carries NO field keys;
      // add_readonly_field carries at least one.
      if (opValid && fieldKeysShapeValid) {
        if (entry.op === 'add_readonly_object' && fieldKeys.length !== 0) {
          push('BRIDGE_AGENT_CHECKLIST_FIELD_KEYS_INVALID', `${fieldPrefix}.fieldKeys`, 'not_allowed_for_add_readonly_object')
        }
        if (entry.op === 'add_readonly_field' && fieldKeys.length === 0) {
          push('BRIDGE_AGENT_CHECKLIST_FIELD_KEYS_INVALID', `${fieldPrefix}.fieldKeys`, 'required_for_add_readonly_field')
        }
      }

      if (opValid && objectNameValid && fieldKeysShapeValid) {
        normalizedOperations.push(Object.freeze({
          op: entry.op,
          objectName: entry.objectName,
          fieldKeys: Object.freeze(fieldKeys.slice()),
        }))
      }
    })
  }

  if (errors.length > 0) return { valid: false, errors }

  return {
    valid: true,
    normalized: Object.freeze({
      schemaVersion: CHECKLIST_SCHEMA_VERSION,
      operations: Object.freeze(normalizedOperations),
    }),
  }
}

module.exports = {
  ALLOWED_OPS,
  CHECKLIST_SCHEMA_VERSION,
  MAX_OPERATIONS,
  MAX_FIELD_KEYS_PER_OPERATION,
  BRIDGE_AGENT_CHECKLIST_ERROR_CODES,
  BRIDGE_AGENT_CHECKLIST_ERROR_CODE_SET,
  validateBridgeAgentChangeChecklist,
}
