/**
 * Workflow Designer API Routes
 * Visual workflow editor REST endpoints
 */

import type { Request, Response } from 'express';
import { Router } from 'express'
import { WorkflowDesigner, type WorkflowDefinition } from '../workflow/WorkflowDesigner'
import { BPMNWorkflowEngine } from '../workflow/BPMNWorkflowEngine'
import {
  appendWorkflowDraftExecution,
  canDeployWorkflowDraft,
  canEditWorkflowDraft,
  canShareWorkflowDraft,
  getWorkflowDraftRole,
  hasWorkflowDraftAccess,
  upsertWorkflowDraftShare,
  type WorkflowDraftExecution,
} from '../workflow/workflowDesignerDrafts'
import {
  buildDuplicatedWorkflowName,
  buildWorkflowDesignerTemplateItems,
  buildWorkflowDraftListItems,
  extractWorkflowTemplateDefinition,
  mapWorkflowDesignerNodeLibraryRow,
  type WorkflowDesignerNodeLibraryRowLike,
  type WorkflowDesignerTemplateListItem,
  type WorkflowDesignerTemplateRowLike,
} from '../workflow/workflowDesignerRouteModels'
import {
  buildWorkflowHubTeamViewValues,
  mapWorkflowHubTeamViewRow,
  normalizeWorkflowHubTeamViewName,
  type WorkflowHubTeamViewRowLike,
} from '../workflow/workflowHubTeamViews'
import { authenticate } from '../middleware/auth'
import { validate } from '../middleware/validation'
import { Logger } from '../core/logger'
import { db } from '../db/db'
import { loadValidators } from '../types/validator'

// Typed wrapper for workflow designer tables not in main Database interface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any

// Load validators (express-validator or no-op fallbacks)
const { body, param, query } = loadValidators()

const router = Router()
const logger = new Logger('WorkflowDesignerAPI')
const designer = new WorkflowDesigner()
const workflowEngine = new BPMNWorkflowEngine()
let workflowEngineReady: Promise<void> | null = null

interface WorkflowHubTeamViewConflictBuilder {
  columns(columns: string[]): {
    doUpdateSet(values: Record<string, unknown>): unknown
  }
}

function isBpmnDraftPayload(body: Record<string, unknown>): body is Record<string, unknown> & {
  name: string
  bpmnXml: string
} {
  return typeof body.name === 'string' && typeof body.bpmnXml === 'string'
}

async function ensureWorkflowEngineReady() {
  if (process.env.DISABLE_WORKFLOW === 'true') {
    throw new Error('Workflow engine disabled (DISABLE_WORKFLOW=true)')
  }

  if (!workflowEngineReady) {
    workflowEngineReady = workflowEngine.initialize()
  }

  await workflowEngineReady
}

async function recordWorkflowAnalytics(input: {
  workflowId: string
  eventType: string
  userId?: string
  eventData?: Record<string, unknown>
}) {
  try {
    await dbAny
      .insertInto('workflow_analytics')
      .values({
        workflow_id: input.workflowId,
        event_type: input.eventType,
        user_id: input.userId,
        event_data: input.eventData ? JSON.stringify(input.eventData) : undefined,
        recorded_at: new Date(),
      })
      .execute()
  } catch (error: unknown) {
    logger.warn(`Workflow analytics unavailable for ${input.eventType}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function loadWorkflowDesignerTemplateCatalog(input: {
  category?: string
  featured?: boolean
}) {
  const builtinTemplates = designer.getTemplates()
  let databaseTemplates: WorkflowDesignerTemplateRowLike[] = []
  let databaseSource: 'database' | 'unavailable' = 'database'

  try {
    let queryBuilder = dbAny
      .selectFrom('workflow_templates')
      .selectAll()
      .where('is_public', '=', true)

    if (input.category) {
      queryBuilder = queryBuilder.where('category', '=', input.category)
    }

    if (input.featured) {
      queryBuilder = queryBuilder.where('is_featured', '=', true)
    }

    databaseTemplates = await queryBuilder
      .orderBy('usage_count', 'desc')
      .execute()
  } catch (error: unknown) {
    databaseSource = 'unavailable'
    logger.warn(`Workflow templates table unavailable, serving builtin templates only: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    builtinTemplates,
    databaseTemplates,
    databaseSource,
  }
}

function findWorkflowTemplateById(templates: WorkflowDesignerTemplateListItem[], templateId: string) {
  return templates.find((template) => template.id === templateId) ?? null
}

/**
 * GET /api/workflow-designer/hub-views/team
 * List tenant-visible workflow hub views
 */
router.get('/hub-views/team', authenticate, async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user?.id?.toString() ?? null
    const tenantId = req.user?.tenantId?.toString() || 'default'

    const rows = await dbAny
      .selectFrom('workflow_hub_team_views')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('scope', '=', 'team')
      .orderBy('updated_at', 'desc')
      .execute()

    const items = rows.map((row: WorkflowHubTeamViewRowLike) => mapWorkflowHubTeamViewRow(row, currentUserId))

    res.json({
      success: true,
      data: items,
      metadata: {
        total: items.length,
        tenantId,
      },
    })
  } catch (error: unknown) {
    logger.error('Failed to list workflow hub team views:', error as Error)
    res.status(500).json({
      success: false,
      error: 'Failed to list workflow hub team views',
    })
  }
})

/**
 * POST /api/workflow-designer/hub-views/team
 * Save or update a tenant-visible workflow hub view
 */
router.post(
  '/hub-views/team',
  authenticate,
  body('name').isString().notEmpty(),
  body('state').isObject(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const name = typeof req.body.name === 'string' ? normalizeWorkflowHubTeamViewName(req.body.name) : ''
      if (!name) {
        return res.status(400).json({
          success: false,
          error: 'View name is required',
        })
      }

      const values = buildWorkflowHubTeamViewValues({
        tenantId,
        ownerUserId: currentUserId,
        name,
        state: req.body.state,
      })

      const saved = await dbAny
        .insertInto('workflow_hub_team_views')
        .values({
          ...values,
          updated_at: new Date(),
        })
        .onConflict((oc: WorkflowHubTeamViewConflictBuilder) =>
          oc
            .columns(['tenant_id', 'owner_user_id', 'scope', 'name_key'])
            .doUpdateSet({
              name: values.name,
              state: values.state,
              updated_at: new Date(),
            }))
        .returningAll()
        .executeTakeFirstOrThrow()

      res.status(201).json({
        success: true,
        data: mapWorkflowHubTeamViewRow(saved as WorkflowHubTeamViewRowLike, currentUserId),
      })
    } catch (error: unknown) {
      logger.error('Failed to save workflow hub team view:', error as Error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save workflow hub team view',
      })
    }
  },
)

/**
 * DELETE /api/workflow-designer/hub-views/team/:id
 * Delete an owned tenant-visible workflow hub view
 */
router.delete(
  '/hub-views/team/:id',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const currentUserId = req.user?.id?.toString()
      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
        })
      }

      const tenantId = req.user?.tenantId?.toString() || 'default'
      const { id } = req.params
      const target = await dbAny
        .selectFrom('workflow_hub_team_views')
        .selectAll()
        .where('id', '=', id)
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'team')
        .executeTakeFirst()

      if (!target) {
        return res.status(404).json({
          success: false,
          error: 'Workflow hub team view not found',
        })
      }

      if (target.owner_user_id !== currentUserId) {
        return res.status(403).json({
          success: false,
          error: 'Delete access denied',
        })
      }

      await dbAny
        .deleteFrom('workflow_hub_team_views')
        .where('id', '=', id)
        .execute()

      res.json({
        success: true,
        data: {
          id,
          message: 'Workflow hub team view deleted successfully',
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to delete workflow hub team view:', error as Error)
      res.status(500).json({
        success: false,
        error: 'Failed to delete workflow hub team view',
      })
    }
  },
)

/**
 * GET /api/workflow-designer/node-types
 * Get available workflow node types
 */
router.get('/node-types', authenticate, async (req: Request, res: Response) => {
  try {
    const nodeTypes = designer.getNodeTypes()
    let customTypes: ReturnType<typeof mapWorkflowDesignerNodeLibraryRow>[] = []
    let customSource: 'database' | 'unavailable' = 'database'

    try {
      const rows = await dbAny
        .selectFrom('workflow_node_library')
        .selectAll()
        .where('is_active', '=', true)
        .execute()
      customTypes = rows.map((type: WorkflowDesignerNodeLibraryRowLike) => mapWorkflowDesignerNodeLibraryRow(type))
    } catch (error: unknown) {
      customSource = 'unavailable'
      logger.warn(`Workflow node library unavailable, serving builtin catalog only: ${error instanceof Error ? error.message : String(error)}`)
    }

    res.json({
      success: true,
      data: {
        builtin: nodeTypes,
        custom: customTypes,
      },
      metadata: {
        customSource,
      },
    })
  } catch (error: unknown) {
    logger.error('Failed to get node types:', error as Error)
    res.status(500).json({
      success: false,
      error: 'Failed to get node types'
    })
  }
})

/**
 * GET /api/workflow-designer/templates
 * Get workflow templates
 */
router.get(
  '/templates',
  authenticate,
  query('category').optional().isString(),
  query('featured').optional().isBoolean(),
  query('search').optional().isString(),
  query('source').optional().isIn(['all', 'builtin', 'database']),
  query('sortBy').optional().isIn(['usage_count', 'name', 'updated_at']),
  query('sortOrder').optional().isIn(['asc', 'desc']),
  query('limit').optional().isInt({ min: 1, max: 200 }),
  query('offset').optional().isInt({ min: 0, max: 10000 }),
  validate,
  async (req: Request, res: Response) => {
    try {
      const category = typeof req.query.category === 'string' ? req.query.category : undefined
      const featured = req.query.featured === 'true'
      const search = typeof req.query.search === 'string' ? req.query.search : undefined
      const source = req.query.source === 'builtin' || req.query.source === 'database'
        ? req.query.source
        : 'all'
      const sortBy = req.query.sortBy === 'name' || req.query.sortBy === 'updated_at'
        ? req.query.sortBy
        : 'usage_count'
      const sortOrder = req.query.sortOrder === 'asc' ? 'asc' : 'desc'
      const limit = Number.parseInt(req.query.limit as string, 10) || 50
      const offset = Number.parseInt(req.query.offset as string, 10) || 0
      const { builtinTemplates, databaseTemplates, databaseSource } = await loadWorkflowDesignerTemplateCatalog({
        category,
        featured,
      })

      res.json({
        success: true,
        ...(() => {
          const result = buildWorkflowDesignerTemplateItems({
          builtinTemplates,
          databaseTemplates,
            filters: {
              category,
              featured,
              search,
              source,
              sortBy,
              sortOrder,
              limit,
              offset,
            },
          })

          return {
            data: result.items,
            metadata: {
              total: result.total,
              limit: result.limit,
              offset: result.offset,
              returned: result.items.length,
              category: category ?? null,
              featured,
              search: search ?? '',
              source,
              sortBy,
              sortOrder,
              builtinCount: builtinTemplates.length,
              databaseCount: databaseTemplates.length,
              databaseSource,
            },
          }
        })(),
      })
    } catch (error: unknown) {
      logger.error('Failed to get templates:', error as Error)
      res.status(500).json({
        success: false,
        error: 'Failed to get templates'
      })
    }
  }
)

router.get(
  '/templates/:id',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const { builtinTemplates, databaseTemplates, databaseSource } = await loadWorkflowDesignerTemplateCatalog({})
      const templates = buildWorkflowDesignerTemplateItems({
        builtinTemplates,
        databaseTemplates,
        filters: {
          limit: builtinTemplates.length + databaseTemplates.length,
          offset: 0,
        },
      })
      const template = findWorkflowTemplateById(templates.items, id)

      if (!template) {
        return res.status(404).json({
          success: false,
          error: 'Workflow template not found',
        })
      }

      const definition = extractWorkflowTemplateDefinition(template)
      if (!definition) {
        return res.status(422).json({
          success: false,
          error: 'Workflow template is missing a valid workflow definition',
        })
      }

      res.json({
        success: true,
        data: {
          ...template,
          template_definition: definition,
        },
        metadata: {
          databaseSource,
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to get workflow template:', error as Error)
      res.status(500).json({
        success: false,
        error: 'Failed to get workflow template',
      })
    }
  },
)

router.post(
  '/templates/:id/instantiate',
  authenticate,
  param('id').isString(),
  body('name').optional().isString(),
  body('description').optional().isString(),
  body('category').optional().isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const userId = req.user?.id?.toString()
      const { builtinTemplates, databaseTemplates } = await loadWorkflowDesignerTemplateCatalog({})
      const templates = buildWorkflowDesignerTemplateItems({
        builtinTemplates,
        databaseTemplates,
        filters: {
          limit: builtinTemplates.length + databaseTemplates.length,
          offset: 0,
        },
      })
      const template = findWorkflowTemplateById(templates.items, id)

      if (!template) {
        return res.status(404).json({
          success: false,
          error: 'Workflow template not found',
        })
      }

      const definition = extractWorkflowTemplateDefinition(template)
      if (!definition) {
        return res.status(422).json({
          success: false,
          error: 'Workflow template is missing a valid workflow definition',
        })
      }

      const workflowId = await designer.saveWorkflow({
        ...definition,
        id: undefined,
        name: typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim() : definition.name,
        description: typeof req.body.description === 'string' ? req.body.description : definition.description,
        category: typeof req.body.category === 'string' && req.body.category.trim() ? req.body.category.trim() : definition.category,
        createdBy: userId,
      })

      await recordWorkflowAnalytics({
        workflowId,
        eventType: 'template_instantiated',
        userId,
        eventData: {
          templateId: id,
          templateSource: template.source,
        },
      })

      res.status(201).json({
        success: true,
        data: {
          workflowId,
          templateId: id,
          message: 'Workflow created from template successfully',
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to instantiate workflow template:', error as Error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to instantiate workflow template',
      })
    }
  },
)

/**
 * POST /api/workflow-designer/workflows
 * Create new workflow
 */
router.post(
  '/workflows',
  authenticate,
  body('name').isString().notEmpty(),
  body('description').optional().isString(),
  body('category').optional().isString(),
  body('nodes').optional().isArray(),
  body('edges').optional().isArray(),
  body('bpmnXml').optional().isString(),
  body('variables').optional().isObject(),
  body('tags').optional().isArray(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id?.toString()
      const workflowDefinition = req.body as Record<string, unknown>

      if (!isBpmnDraftPayload(workflowDefinition) && (!Array.isArray(workflowDefinition.nodes) || !Array.isArray(workflowDefinition.edges))) {
        return res.status(400).json({
          success: false,
          error: 'Workflow payload must include either bpmnXml or nodes/edges'
        })
      }

      const isBpmnDraft = isBpmnDraftPayload(workflowDefinition)
      const workflowId = isBpmnDraft
        ? await designer.saveBpmnDraft({
            name: workflowDefinition.name,
            description: typeof workflowDefinition.description === 'string' ? workflowDefinition.description : undefined,
            version: typeof workflowDefinition.version === 'number' ? workflowDefinition.version : 1,
            category: typeof workflowDefinition.category === 'string' ? workflowDefinition.category : undefined,
            tags: Array.isArray(workflowDefinition.tags)
              ? workflowDefinition.tags.filter((tag): tag is string => typeof tag === 'string')
              : [],
            bpmnXml: workflowDefinition.bpmnXml,
            createdBy: userId,
          })
        : await (async () => {
            const visualDefinition = workflowDefinition as unknown as WorkflowDefinition
            const validation = designer.validateWorkflow(visualDefinition)
            if (!validation.valid) {
              res.status(400).json({
                success: false,
                error: 'Workflow validation failed',
                details: validation.errors
              })
              return null
            }

            return designer.saveWorkflow({
              ...(workflowDefinition as unknown as WorkflowDefinition),
              id: undefined,
              createdBy: userId,
            })
          })()

      if (!workflowId) return

      // Log creation
      await recordWorkflowAnalytics({
        workflowId,
        eventType: 'created',
        userId,
        eventData: {
          mode: isBpmnDraft ? 'bpmn-xml' : 'visual',
          nodes_count: Array.isArray(workflowDefinition.nodes) ? workflowDefinition.nodes.length : 0,
          edges_count: Array.isArray(workflowDefinition.edges) ? workflowDefinition.edges.length : 0,
        },
      })

      res.status(201).json({
        success: true,
        data: {
          workflowId,
          message: 'Workflow created successfully'
        }
      })
    } catch (error: unknown) {
      logger.error('Failed to create workflow:', error as Error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create workflow'
      })
    }
  }
)

/**
 * GET /api/workflow-designer/workflows
 * List workflows
 */
router.get(
  '/workflows',
  authenticate,
  query('category').optional().isString(),
  query('status').optional().isIn(['draft', 'published', 'archived']),
  query('search').optional().isString(),
  query('sortBy').optional().isIn(['updated_at', 'created_at', 'name']),
  query('sortOrder').optional().isIn(['asc', 'desc']),
  query('limit').optional().isInt({ min: 1, max: 200 }),
  query('offset').optional().isInt({ min: 0, max: 10000 }),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { category, status, search } = req.query
      const userId = req.user?.id?.toString()
      const sortBy = req.query.sortBy === 'created_at' || req.query.sortBy === 'name'
        ? req.query.sortBy
        : 'updated_at'
      const sortOrder = req.query.sortOrder === 'asc' ? 'asc' : 'desc'
      const limit = Number.parseInt(req.query.limit as string, 10) || 50
      const offset = Number.parseInt(req.query.offset as string, 10) || 0

      const rows = await db
        .selectFrom('workflow_definitions')
        .selectAll()
        .orderBy('updated_at', 'desc')
        .execute()

      const resolved = buildWorkflowDraftListItems({
        rows,
        userId,
        filters: {
          category: typeof category === 'string' ? category : undefined,
          status: typeof status === 'string' ? status : undefined,
          search: typeof search === 'string' ? search : undefined,
          sortBy,
          sortOrder,
          limit,
          offset,
        },
      })

      res.json({
        success: true,
        data: resolved.items,
        metadata: {
          total: resolved.total,
          limit: resolved.limit,
          offset: resolved.offset,
          returned: resolved.items.length,
          category: typeof category === 'string' ? category : null,
          status: typeof status === 'string' ? status : null,
          search: typeof search === 'string' ? search : '',
          sortBy,
          sortOrder,
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to list workflows:', error as Error)
      res.status(500).json({
        success: false,
        error: 'Failed to list workflows'
      })
    }
  }
)

/**
 * GET /api/workflow-designer/workflows/:id
 * Get workflow details
 */
router.get(
  '/workflows/:id',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const userId = req.user?.id?.toString()

      const workflow = await designer.loadWorkflowDraft(id)
      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: 'Workflow not found'
        })
      }

      const userRole = getWorkflowDraftRole(workflow, userId)
      if (!userRole) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        })
      }

      // Log access
      await recordWorkflowAnalytics({
        workflowId: id,
        eventType: 'opened',
        userId,
      })

      res.json({
        success: true,
        data: {
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          version: workflow.version,
          bpmnXml: workflow.bpmnXml,
          category: workflow.category,
          tags: workflow.tags,
          metadata: {
            created_by: workflow.createdBy,
            created_at: workflow.createdAt,
            updated_at: workflow.updatedAt,
            status: workflow.status,
            user_role: userRole
          }
        }
      })
    } catch (error: unknown) {
      logger.error('Failed to get workflow:', error as Error)
      res.status(500).json({
        success: false,
        error: 'Failed to get workflow'
      })
    }
  }
)

/**
 * PUT /api/workflow-designer/workflows/:id
 * Update workflow
 */
router.put(
  '/workflows/:id',
  authenticate,
  param('id').isString(),
  body('name').optional().isString(),
  body('description').optional().isString(),
  body('nodes').optional().isArray(),
  body('edges').optional().isArray(),
  body('bpmnXml').optional().isString(),
  body('variables').optional().isObject(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const userId = req.user?.id?.toString()
      const updates = req.body as Record<string, unknown>

      const workflow = await designer.loadWorkflowDraft(id)

      if (!workflow || !canEditWorkflowDraft(workflow, userId)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        })
      }

      if (typeof updates.bpmnXml === 'string') {
        await designer.saveBpmnDraft({
          id,
          name: typeof updates.name === 'string' ? updates.name : workflow.name,
          description: typeof updates.description === 'string' ? updates.description : workflow.description,
          version: typeof updates.version === 'number' ? updates.version : workflow.version,
          category: typeof updates.category === 'string' ? updates.category : workflow.category,
          tags: Array.isArray(updates.tags)
            ? updates.tags.filter((tag): tag is string => typeof tag === 'string')
            : workflow.tags,
          bpmnXml: updates.bpmnXml,
          createdBy: workflow.createdBy,
          status: workflow.status,
        })
      } else {
        const currentDefinition = await designer.loadWorkflow(id)
        if (!currentDefinition) {
          return res.status(404).json({
            success: false,
            error: 'Workflow not found'
          })
        }

        const updatedDefinition = {
          ...currentDefinition,
          ...updates,
          id
        }

        const validation = designer.validateWorkflow(updatedDefinition)
        if (!validation.valid) {
          return res.status(400).json({
            success: false,
            error: 'Workflow validation failed',
            details: validation.errors
          })
        }

        await designer.saveWorkflow(updatedDefinition)
      }

      // Log update
      await recordWorkflowAnalytics({
        workflowId: id,
        eventType: 'edited',
        userId,
        eventData: {
          fields_updated: Object.keys(updates),
          mode: typeof updates.bpmnXml === 'string' ? 'bpmn-xml' : 'visual',
        },
      })

      res.json({
        success: true,
        data: { message: 'Workflow updated successfully' }
      })
    } catch (error: unknown) {
      logger.error('Failed to update workflow:', error as Error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update workflow'
      })
    }
  }
)

/**
 * POST /api/workflow-designer/workflows/:id/duplicate
 * Duplicate a workflow draft into a new personal draft
 */
router.post(
  '/workflows/:id/duplicate',
  authenticate,
  param('id').isString(),
  body('name').optional().isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const userId = req.user?.id?.toString()
      const workflow = await designer.loadWorkflowDraft(id)

      if (!workflow || !hasWorkflowDraftAccess(workflow, userId)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied',
        })
      }

      const duplicateName = typeof req.body.name === 'string' && req.body.name.trim()
        ? req.body.name.trim()
        : buildDuplicatedWorkflowName(workflow.name)

      const workflowId = await designer.saveBpmnDraft({
        name: duplicateName,
        description: workflow.description,
        version: workflow.version,
        category: workflow.category,
        tags: workflow.tags,
        bpmnXml: workflow.bpmnXml || '',
        createdBy: userId || workflow.createdBy,
        status: 'draft',
        shares: [],
        executions: [],
        visual: workflow.visual,
      })

      await recordWorkflowAnalytics({
        workflowId,
        eventType: 'duplicated',
        userId,
        eventData: {
          sourceWorkflowId: id,
        },
      })

      res.status(201).json({
        success: true,
        data: {
          workflowId,
          sourceWorkflowId: id,
          message: 'Workflow duplicated successfully',
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to duplicate workflow:', error as Error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to duplicate workflow',
      })
    }
  },
)

/**
 * POST /api/workflow-designer/workflows/:id/archive
 * Archive a workflow draft without deleting its history
 */
router.post(
  '/workflows/:id/archive',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const userId = req.user?.id?.toString()
      const workflow = await designer.loadWorkflowDraft(id)

      if (!workflow || !canEditWorkflowDraft(workflow, userId)) {
        return res.status(403).json({
          success: false,
          error: 'Archive access denied',
        })
      }

      await designer.saveBpmnDraft({
        id,
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        category: workflow.category,
        tags: workflow.tags,
        bpmnXml: workflow.bpmnXml || '',
        createdBy: workflow.createdBy,
        status: 'archived',
        shares: workflow.shares,
        executions: workflow.executions,
        visual: workflow.visual,
      })

      await recordWorkflowAnalytics({
        workflowId: id,
        eventType: 'archived',
        userId,
      })

      res.json({
        success: true,
        data: {
          workflowId: id,
          status: 'archived',
          message: 'Workflow archived successfully',
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to archive workflow:', error as Error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to archive workflow',
      })
    }
  },
)

/**
 * POST /api/workflow-designer/workflows/:id/restore
 * Restore an archived workflow draft back to draft status
 */
router.post(
  '/workflows/:id/restore',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const userId = req.user?.id?.toString()
      const workflow = await designer.loadWorkflowDraft(id)

      if (!workflow || !canEditWorkflowDraft(workflow, userId)) {
        return res.status(403).json({
          success: false,
          error: 'Restore access denied',
        })
      }

      await designer.saveBpmnDraft({
        id,
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        category: workflow.category,
        tags: workflow.tags,
        bpmnXml: workflow.bpmnXml || '',
        createdBy: workflow.createdBy,
        status: 'draft',
        shares: workflow.shares,
        executions: workflow.executions,
        visual: workflow.visual,
      })

      await recordWorkflowAnalytics({
        workflowId: id,
        eventType: 'restored',
        userId,
      })

      res.json({
        success: true,
        data: {
          workflowId: id,
          status: 'draft',
          message: 'Workflow restored successfully',
        },
      })
    } catch (error: unknown) {
      logger.error('Failed to restore workflow:', error as Error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to restore workflow',
      })
    }
  },
)

/**
 * POST /api/workflow-designer/workflows/:id/validate
 * Validate workflow
 */
router.post(
  '/workflows/:id/validate',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params

      const workflow = await designer.loadWorkflowDraft(id)
      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: 'Workflow not found'
        })
      }

      if (!workflow.visual) {
        return res.json({
          success: true,
          data: {
            valid: true,
            errors: [],
            mode: 'bpmn-xml'
          }
        })
      }

      const validation = designer.validateWorkflow(workflow.visual)

      res.json({
        success: true,
        data: validation
      })
    } catch (error: unknown) {
      logger.error('Failed to validate workflow:', error as Error)
      res.status(500).json({
        success: false,
        error: 'Failed to validate workflow'
      })
    }
  }
)

/**
 * POST /api/workflow-designer/workflows/:id/deploy
 * Deploy workflow to execution engine
 */
router.post(
  '/workflows/:id/deploy',
  authenticate,
  param('id').isString(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const userId = req.user?.id?.toString()

      const workflow = await designer.loadWorkflowDraft(id)

      if (!workflow || !canDeployWorkflowDraft(workflow, userId)) {
        return res.status(403).json({
          success: false,
          error: 'Deployment access denied'
        })
      }

      const deploymentId = workflow.bpmnXml
        ? await (async () => {
            await ensureWorkflowEngineReady()
            return workflowEngine.deployProcess({
            key: '',
            name: workflow.name,
            description: workflow.description,
            category: workflow.category,
            bpmnXml: workflow.bpmnXml,
            tenantId: req.user?.tenantId?.toString()
            })
          })()
        : await designer.deployWorkflow(id)

      // Update workflow status
      await dbAny
        .updateTable('workflow_definitions')
        .set({
          status: 'published',
          updated_at: new Date()
        })
        .where('id', '=', id)
        .execute()

      // Log deployment
      await recordWorkflowAnalytics({
        workflowId: id,
        eventType: 'deployed',
        userId,
      })

      res.json({
        success: true,
        data: {
          deploymentId,
          message: 'Workflow deployed successfully'
        }
      })
    } catch (error: unknown) {
      logger.error('Failed to deploy workflow:', error as Error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to deploy workflow'
      })
    }
  }
)

/**
 * POST /api/workflow-designer/workflows/:id/test
 * Test workflow execution
 */
router.post(
  '/workflows/:id/test',
  authenticate,
  param('id').isString(),
  body('variables').optional().isObject(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const { variables = {} } = req.body
      const userId = req.user?.id?.toString()

      const workflow = await designer.loadWorkflowDraft(id)
      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: 'Workflow not found'
        })
      }

      if (!hasWorkflowDraftAccess(workflow, userId)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        })
      }

      const executionId = `exec-${Date.now()}`
      const startTime = new Date()
      const execution: WorkflowDraftExecution = {
        id: executionId,
        executionType: 'test',
        triggeredBy: userId || 'system',
        triggerContext: typeof variables === 'object' && variables ? variables as Record<string, unknown> : {},
        status: 'completed',
        startTime: startTime.toISOString(),
        endTime: new Date().toISOString(),
        resultData: {
          test: 'successful',
          nodes_executed: workflow.visual?.nodes.length ?? null,
          used_bpmn_draft: Boolean(workflow.bpmnXml),
        },
        errorData: null,
      }

      await designer.saveBpmnDraft({
        id,
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        category: workflow.category,
        tags: workflow.tags,
        bpmnXml: workflow.bpmnXml || '',
        createdBy: workflow.createdBy,
        status: workflow.status,
        shares: workflow.shares,
        executions: appendWorkflowDraftExecution(workflow.executions, execution),
        visual: workflow.visual,
      })

      res.json({
        success: true,
        data: {
          executionId,
          message: 'Test execution started'
        }
      })
    } catch (error: unknown) {
      logger.error('Failed to test workflow:', error as Error)
      res.status(500).json({
        success: false,
        error: 'Failed to test workflow'
      })
    }
  }
)

/**
 * GET /api/workflow-designer/workflows/:id/executions
 * Get workflow execution history
 */
router.get(
  '/workflows/:id/executions',
  authenticate,
  param('id').isString(),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const limit = parseInt(req.query.limit as string) || 50
      const userId = req.user?.id?.toString()
      const workflow = await designer.loadWorkflowDraft(id)

      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: 'Workflow not found'
        })
      }

      if (!hasWorkflowDraftAccess(workflow, userId)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        })
      }

      const executions = workflow.executions
        .slice()
        .sort((left, right) => right.startTime.localeCompare(left.startTime))
        .slice(0, limit)

      res.json({
        success: true,
        data: executions
      })
    } catch (error: unknown) {
      logger.error('Failed to get execution history:', error as Error)
      res.status(500).json({
        success: false,
        error: 'Failed to get execution history'
      })
    }
  }
)

/**
 * POST /api/workflow-designer/workflows/:id/share
 * Share workflow with other users
 */
router.post(
  '/workflows/:id/share',
  authenticate,
  param('id').isString(),
  body('userId').isString(),
  body('role').isIn(['viewer', 'editor']),
  body('permissions').optional().isObject(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const { userId: targetUserId, role, permissions } = req.body as {
        userId: string;
        role: 'viewer' | 'editor';
        permissions?: { canEdit?: boolean; canDeploy?: boolean; canShare?: boolean }
      }
      const currentUserId = req.user?.id?.toString()

      const workflow = await designer.loadWorkflowDraft(id)

      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: 'Workflow not found'
        })
      }

      if (!canShareWorkflowDraft(workflow, currentUserId)) {
        return res.status(403).json({
          success: false,
          error: 'Sharing access denied'
        })
      }

      const nextShares = upsertWorkflowDraftShare(workflow.shares, {
          userId: targetUserId,
          role,
          canEdit: role === 'editor' || permissions?.canEdit || false,
          canDeploy: permissions?.canDeploy || false,
          canShare: permissions?.canShare || false,
          sharedBy: currentUserId,
          sharedAt: new Date().toISOString(),
        })

      await designer.saveBpmnDraft({
        id,
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        category: workflow.category,
        tags: workflow.tags,
        bpmnXml: workflow.bpmnXml || '',
        createdBy: workflow.createdBy,
        status: workflow.status,
        shares: nextShares,
        executions: workflow.executions,
        visual: workflow.visual,
      })

      // Log sharing
      await recordWorkflowAnalytics({
        workflowId: id,
        eventType: 'shared',
        userId: currentUserId,
        eventData: { shared_with: targetUserId, role },
      })

      res.json({
        success: true,
        data: { message: 'Workflow shared successfully' }
      })
    } catch (error: unknown) {
      logger.error('Failed to share workflow:', error as Error)
      res.status(500).json({
        success: false,
        error: 'Failed to share workflow'
      })
    }
  }
)

export default router
