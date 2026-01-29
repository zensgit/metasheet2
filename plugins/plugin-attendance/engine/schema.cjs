const { z } = require('zod')

const RuleConditionSchema = z.record(z.any())
const RuleActionSchema = z
  .object({
    overtime_hours: z.number().optional(),
    overtime_add: z.number().optional(),
    required_hours: z.number().optional(),
    actual_hours: z.number().optional(),
    warning: z.string().optional(),
    warnings: z.array(z.string()).optional(),
    reason: z.string().optional(),
    reasons: z.array(z.string()).optional(),
  })
  .passthrough()

const RuleSchema = z.object({
  id: z.string(),
  when: RuleConditionSchema,
  then: RuleActionSchema,
})

const TemplateSchema = z.object({
  name: z.string(),
  scope: z.record(z.any()).optional(),
  rules: z.array(RuleSchema),
})

const MappingSchema = z
  .object({
    source: z.string().optional(),
    dateField: z.string().optional(),
    columns: z.record(z.union([z.string(), z.number()])).optional(),
    extraFields: z.record(z.string()).optional(),
  })
  .partial()

const CoreRulesSchema = z
  .object({
    overtime: z
      .object({
        merge_overlaps: z.boolean().optional(),
        deduct_step_hours: z.number().optional(),
      })
      .partial()
      .optional(),
    overnight: z
      .object({
        detect_cross_day: z.boolean().optional(),
        next_day_policy: z.string().optional(),
      })
      .partial()
      .optional(),
    leave: z
      .object({
        warn_if_leave_but_all_punches: z.boolean().optional(),
        warn_if_actual_plus_leave_less_than_required: z.boolean().optional(),
      })
      .partial()
      .optional(),
  })
  .partial()

const EngineConfigSchema = z.object({
  mapping: MappingSchema.optional(),
  coreRules: CoreRulesSchema.optional(),
  templates: z.array(TemplateSchema).default([]),
})

function validateConfig(input) {
  const parsed = EngineConfigSchema.safeParse(input || {})
  if (!parsed.success) {
    const details = parsed.error.errors.map((err) => ({
      path: err.path.join('.'),
      message: err.message,
    }))
    const error = new Error('Invalid attendance rule engine config')
    error.details = details
    throw error
  }
  return parsed.data
}

module.exports = {
  validateConfig,
}
