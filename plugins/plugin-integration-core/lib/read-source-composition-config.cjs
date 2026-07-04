'use strict'

// Read-source resolver composition — C-R1: chain CONFIG MODEL + save-time VALIDATOR ONLY (#1709).
//
// Scope fence: this module validates the ordered approved-read composition config. It does NOT
// execute the chain, call a route, call a network, create an adapter, or touch any write path.
// v1 is intentionally the concrete two-hop demand: step 1 resolves one scalar; step 2 consumes
// that scalar as its `key`. Recursive/fan-out BOM expansion is a separate later gate.

const COMPOSITION_MAX_STEPS = 2
const COMPOSITION_MIN_STEPS = 2
const COMPOSITION_OPERATIONS = Object.freeze(['read'])

const ROOT_KEYS = Object.freeze(new Set(['version', 'name', 'operations', 'steps']))
const STEP_KEYS = Object.freeze(new Set(['id', 'readSourceConfigId', 'input']))
const INPUT_KEYS = Object.freeze(new Set(['fromStep', 'sourceTarget', 'toInput']))
const WRITE_SHAPED_KEYS = Object.freeze(['savePath', 'submitPath', 'auditPath', 'deletePath', 'writePath', 'writeConfigId'])

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBoundedIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value.trim())
}

function isBoundedConfigId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.trim())
}

function freezeDeep(value) {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item)
    return Object.freeze(value)
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) freezeDeep(item)
    return Object.freeze(value)
  }
  return value
}

function normalizedStep(step, index) {
  const out = {
    id: step.id.trim(),
    readSourceConfigId: step.readSourceConfigId.trim(),
  }
  if (index > 0) {
    out.input = {
      fromStep: step.input.fromStep.trim(),
      sourceTarget: step.input.sourceTarget.trim(),
      toInput: step.input.toInput.trim(),
    }
  }
  return out
}

function normalizeReadSourceCompositionConfig(config) {
  return freezeDeep({
    version: config.version,
    name: config.name.trim(),
    operations: ['read'],
    steps: config.steps.map((step, index) => normalizedStep(step, index)),
  })
}

function readConfigById(readConfigsById, id) {
  if (!readConfigsById) return null
  if (readConfigsById instanceof Map) return readConfigsById.get(id) || null
  if (isPlainObject(readConfigsById)) return readConfigsById[id] || null
  return null
}

function validateReferencedReadConfigs(config, push, options) {
  const readConfigsById = options && options.readConfigsById
  if (!readConfigsById || !Array.isArray(config.steps)) return
  for (let index = 0; index < config.steps.length; index += 1) {
    const step = config.steps[index]
    if (!isPlainObject(step) || !isBoundedConfigId(step.readSourceConfigId)) continue
    const ref = readConfigById(readConfigsById, step.readSourceConfigId.trim())
    if (!ref) {
      push('READ_SOURCE_COMPOSITION_STEP_NOT_APPROVED', `steps.${index}.readSourceConfigId`, 'approved_read_config_required')
      continue
    }
    const refConfig = isPlainObject(ref.config) ? ref.config : ref
    if (ref.status !== undefined && ref.status !== 'approved') {
      push('READ_SOURCE_COMPOSITION_STEP_NOT_APPROVED', `steps.${index}.readSourceConfigId`, 'approved_read_config_required')
    }
    if (refConfig.mode !== 'resolver_lookup') {
      push('READ_SOURCE_COMPOSITION_STEP_MODE_INVALID', `steps.${index}.readSourceConfigId`, 'resolver_lookup_required')
    }
    if (!Array.isArray(refConfig.operations) || refConfig.operations.length !== 1 || refConfig.operations[0] !== 'read') {
      push('READ_SOURCE_COMPOSITION_WRITE_CONFIG_REJECTED', `steps.${index}.readSourceConfigId`, 'step_must_be_read_only')
    }
    const fieldMap = refConfig.fieldMap
    if (!Array.isArray(fieldMap) || fieldMap.length !== 1 || !isBoundedIdentifier(fieldMap[0] && fieldMap[0].target)) {
      push('READ_SOURCE_COMPOSITION_STEP_OUTPUT_INVALID', `steps.${index}.readSourceConfigId`, 'single_resolver_output_required')
      continue
    }
    const next = config.steps[index + 1]
    if (next && isPlainObject(next) && isPlainObject(next.input) && typeof next.input.sourceTarget === 'string') {
      if (fieldMap[0].target !== next.input.sourceTarget.trim()) {
        push('READ_SOURCE_COMPOSITION_HANDOFF_INVALID', `steps.${index + 1}.input.sourceTarget`, 'source_target_must_match_previous_output')
      }
    }
  }
}

function validateReadSourceCompositionConfig(config, options = {}) {
  if (!isPlainObject(config)) {
    return { valid: false, errors: [{ code: 'READ_SOURCE_COMPOSITION_CONFIG_NOT_OBJECT', field: '(root)', reason: 'not_object' }] }
  }
  const errors = []
  const push = (code, field, reason) => errors.push({ code, field, reason })

  for (const key of Object.keys(config)) {
    if (!ROOT_KEYS.has(key)) push('READ_SOURCE_COMPOSITION_UNEXPECTED_FIELD', '(unexpected)', 'not_allowlisted')
  }
  for (const key of WRITE_SHAPED_KEYS) {
    if (config[key] !== undefined) push('READ_SOURCE_COMPOSITION_WRITE_CONFIG_REJECTED', key, 'write_shaped_key')
  }

  if (!Number.isInteger(config.version) || config.version < 1) {
    push('READ_SOURCE_COMPOSITION_VERSION_INVALID', 'version', 'must_be_positive_integer')
  }
  if (!isBoundedIdentifier(config.name)) {
    push('READ_SOURCE_COMPOSITION_NAME_INVALID', 'name', 'invalid_identifier')
  }
  if (!Array.isArray(config.operations) || config.operations.length !== 1 || config.operations[0] !== 'read') {
    push('READ_SOURCE_COMPOSITION_WRITE_CONFIG_REJECTED', 'operations', 'operations_must_be_read_only')
  }

  if (!Array.isArray(config.steps) || config.steps.length < COMPOSITION_MIN_STEPS || config.steps.length > COMPOSITION_MAX_STEPS) {
    push('READ_SOURCE_COMPOSITION_STEPS_INVALID', 'steps', 'exactly_two_steps_required')
  } else {
    const seenStepIds = new Set()
    const seenConfigIds = new Set()
    for (let index = 0; index < config.steps.length; index += 1) {
      const step = config.steps[index]
      if (!isPlainObject(step)) {
        push('READ_SOURCE_COMPOSITION_STEP_INVALID', `steps.${index}`, 'not_object')
        continue
      }
      for (const key of Object.keys(step)) {
        if (!STEP_KEYS.has(key)) push('READ_SOURCE_COMPOSITION_STEP_INVALID', `steps.${index}.(unexpected)`, 'not_allowlisted')
      }
      for (const key of WRITE_SHAPED_KEYS) {
        if (step[key] !== undefined) push('READ_SOURCE_COMPOSITION_WRITE_CONFIG_REJECTED', `steps.${index}.${key}`, 'write_shaped_key')
      }
      if (!isBoundedIdentifier(step.id)) {
        push('READ_SOURCE_COMPOSITION_STEP_INVALID', `steps.${index}.id`, 'invalid_identifier')
      } else if (seenStepIds.has(step.id.trim())) {
        push('READ_SOURCE_COMPOSITION_STEP_INVALID', `steps.${index}.id`, 'duplicate_step_id')
      } else {
        seenStepIds.add(step.id.trim())
      }
      if (!isBoundedConfigId(step.readSourceConfigId)) {
        push('READ_SOURCE_COMPOSITION_STEP_REF_INVALID', `steps.${index}.readSourceConfigId`, 'invalid_reference')
      } else if (seenConfigIds.has(step.readSourceConfigId.trim())) {
        push('READ_SOURCE_COMPOSITION_STEP_REF_INVALID', `steps.${index}.readSourceConfigId`, 'duplicate_read_config_reference')
      } else {
        seenConfigIds.add(step.readSourceConfigId.trim())
      }

      if (index === 0) {
        if (step.input !== undefined) {
          push('READ_SOURCE_COMPOSITION_HANDOFF_INVALID', `steps.${index}.input`, 'first_step_has_no_handoff')
        }
        continue
      }

      if (!isPlainObject(step.input)) {
        push('READ_SOURCE_COMPOSITION_HANDOFF_INVALID', `steps.${index}.input`, 'handoff_required')
        continue
      }
      for (const key of Object.keys(step.input)) {
        if (!INPUT_KEYS.has(key)) push('READ_SOURCE_COMPOSITION_HANDOFF_INVALID', `steps.${index}.input.(unexpected)`, 'not_allowlisted')
      }
      const previous = config.steps[index - 1]
      const previousId = isPlainObject(previous) && typeof previous.id === 'string' ? previous.id.trim() : null
      if (step.input.fromStep !== previousId) {
        push('READ_SOURCE_COMPOSITION_HANDOFF_INVALID', `steps.${index}.input.fromStep`, 'must_reference_previous_step')
      }
      if (!isBoundedIdentifier(step.input.sourceTarget)) {
        push('READ_SOURCE_COMPOSITION_HANDOFF_INVALID', `steps.${index}.input.sourceTarget`, 'invalid_source_target')
      }
      if (step.input.toInput !== 'key') {
        push('READ_SOURCE_COMPOSITION_HANDOFF_INVALID', `steps.${index}.input.toInput`, 'to_input_must_be_key')
      }
    }
    validateReferencedReadConfigs(config, push, options)
  }

  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, normalized: normalizeReadSourceCompositionConfig(config) }
}

module.exports = {
  COMPOSITION_MAX_STEPS,
  COMPOSITION_MIN_STEPS,
  validateReadSourceCompositionConfig,
  normalizeReadSourceCompositionConfig,
}
