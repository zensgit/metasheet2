// @ts-nocheck
/**
 * Workflow Designer API Routes
 * Visual workflow editor REST endpoints
 */

import { Router, Request, Response } from 'express'
import { WorkflowDesigner } from '../workflow/WorkflowDesigner'
import { authenticate } from '../middleware/auth'
import { validate } from '../middleware/validation'
import { body, param, query } from 'express-validator'
import { Logger } from '../core/logger'
import { db } from '../db/db'

const router = Router()
const logger = new Logger('WorkflowDesignerAPI')
const designer = new WorkflowDesigner()

/**
 * GET /api/workflow-designer/node-types
 * Get available workflow node types
 */
router.get('/node-types', authenticate, async (req: Request, res: Response) => {
  try {
    const nodeTypes = designer.getNodeTypes()

    // Also get from database for custom node types
    const customTypes = await db
      .selectFrom('workflow_node_library')
      .selectAll()
      .where('is_active', '=', true)
      .execute()

    res.json({
      success: true,
      data: {
        builtin: nodeTypes,
        custom: customTypes.map(type => ({
          ...type,
          properties_schema: type.properties_schema ? JSON.parse(type.properties_schema as string) : {},
          default_properties: type.default_properties ? JSON.parse(type.default_properties as string) : {},
          validation_rules: type.validation_rules ? JSON.parse(type.validation_rules as string) : {},
          visual_config: type.visual_config ? JSON.parse(type.visual_config as string) : {}
        }))
      }
    })
  } catch (error) {
    logger.error('Failed to get node types:', error)
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
  validate,
  async (req: Request, res: Response) => {
    try {
      const { category, featured } = req.query

      let query = db
        .selectFrom('workflow_templates')
        .selectAll()
        .where('is_public', '=', true)

      if (category) {
        query = query.where('category', '=', category as string)
      }

      if (featured === 'true') {
        query = query.where('is_featured', '=', true)
      }

      const templates = await query
        .orderBy('usage_count', 'desc')
        .execute()

      res.json({
        success: true,
        data: templates.map(template => ({
          ...template,
          template_definition: template.template_definition ? JSON.parse(template.template_definition as string) : {},
          required_variables: template.required_variables ? JSON.parse(template.required_variables as string) : [],
          optional_variables: template.optional_variables ? JSON.parse(template.optional_variables as string) : [],
          tags: template.tags ? JSON.parse(template.tags as string) : []
        }))
      })
    } catch (error) {
      logger.error('Failed to get templates:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to get templates'
      })
    }
  }
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
  body('nodes').isArray(),
  body('edges').isArray(),
  body('variables').optional().isObject(),
  body('tags').optional().isArray(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id
      const workflowDefinition = req.body

      // Validate workflow structure
      const validation = designer.validateWorkflow(workflowDefinition)
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: 'Workflow validation failed',
          details: validation.errors
        })
      }

      const workflowId = await designer.saveWorkflow(workflowDefinition)

      // Log creation
      await db
        .insertInto('workflow_analytics')
        .values({
          workflow_id: workflowId,
          event_type: 'created',
          user_id: userId,
          event_data: JSON.stringify({
            nodes_count: workflowDefinition.nodes.length,
            edges_count: workflowDefinition.edges.length
          }),
          recorded_at: new Date()
        })
        .execute()

      res.status(201).json({
        success: true,
        data: {
          workflowId,
          message: 'Workflow created successfully'
        }
      })
    } catch (error) {
      logger.error('Failed to create workflow:', error)
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
  validate,
  async (req: Request, res: Response) => {
    try {
      const { category, status, search } = req.query
      const userId = (req as any).user?.id

      let query = db
        .selectFrom('workflow_designer_definitions')
        .leftJoin('workflow_collaboration', 'workflow_designer_definitions.id', 'workflow_collaboration.workflow_id')
        .select([
          'workflow_designer_definitions.id',
          'workflow_designer_definitions.name',
          'workflow_designer_definitions.description',
          'workflow_designer_definitions.category',
          'workflow_designer_definitions.status',
          'workflow_designer_definitions.created_at',
          'workflow_designer_definitions.updated_at',
          'workflow_collaboration.role'
        ])
        .where((eb) =>
          eb.or([
            eb('workflow_designer_definitions.created_by', '=', userId),
            eb('workflow_collaboration.user_id', '=', userId)
          ])
        )

      if (category) {
        query = query.where('workflow_designer_definitions.category', '=', category as string)
      }

      if (status) {
        query = query.where('workflow_designer_definitions.status', '=', status as string)
      }

      if (search) {
        query = query.where((eb) =>
          eb.or([
            eb('workflow_designer_definitions.name', 'ilike', `%${search}%`),
            eb('workflow_designer_definitions.description', 'ilike', `%${search}%`)
          ])
        )
      }

      const workflows = await query
        .orderBy('workflow_designer_definitions.updated_at', 'desc')
        .execute()

      res.json({
        success: true,
        data: workflows
      })
    } catch (error) {
      logger.error('Failed to list workflows:', error)
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
      const userId = (req as any).user?.id

      const workflow = await designer.loadWorkflow(id)
      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: 'Workflow not found'
        })
      }

      // Check access permissions
      const collaboration = await db
        .selectFrom('workflow_collaboration')
        .selectAll()
        .where('workflow_id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst()

      const workflowInfo = await db
        .selectFrom('workflow_designer_definitions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()

      if (!workflowInfo || (workflowInfo.created_by !== userId && !collaboration)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        })
      }

      // Log access
      await db
        .insertInto('workflow_analytics')
        .values({
          workflow_id: id,
          event_type: 'opened',
          user_id: userId,
          recorded_at: new Date()
        })
        .execute()

      res.json({
        success: true,
        data: {
          ...workflow,
          metadata: {
            created_by: workflowInfo.created_by,
            created_at: workflowInfo.created_at,
            updated_at: workflowInfo.updated_at,
            status: workflowInfo.status,
            user_role: collaboration?.role || 'owner'
          }
        }
      })
    } catch (error) {
      logger.error('Failed to get workflow:', error)
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
  body('variables').optional().isObject(),
  validate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const userId = (req as any).user?.id
      const updates = req.body

      // Check permissions
      const collaboration = await db
        .selectFrom('workflow_collaboration')
        .selectAll()
        .where('workflow_id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst()

      const workflow = await db
        .selectFrom('workflow_designer_definitions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()

      if (!workflow || (workflow.created_by !== userId && (!collaboration || !collaboration.can_edit))) {
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        })
      }

      // Load current workflow and merge updates
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

      // Validate updated workflow
      const validation = designer.validateWorkflow(updatedDefinition)
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: 'Workflow validation failed',
          details: validation.errors
        })
      }

      await designer.saveWorkflow(updatedDefinition)

      // Log update
      await db
        .insertInto('workflow_analytics')
        .values({
          workflow_id: id,
          event_type: 'edited',
          user_id: userId,
          event_data: JSON.stringify({
            fields_updated: Object.keys(updates)
          }),
          recorded_at: new Date()
        })
        .execute()

      res.json({
        success: true,
        data: { message: 'Workflow updated successfully' }
      })
    } catch (error) {
      logger.error('Failed to update workflow:', error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update workflow'
      })
    }
  }
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

      const workflow = await designer.loadWorkflow(id)
      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: 'Workflow not found'
        })
      }

      const validation = designer.validateWorkflow(workflow)

      res.json({
        success: true,
        data: validation
      })
    } catch (error) {
      logger.error('Failed to validate workflow:', error)
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
      const userId = (req as any).user?.id

      // Check deployment permissions
      const collaboration = await db
        .selectFrom('workflow_collaboration')
        .selectAll()
        .where('workflow_id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst()

      const workflow = await db
        .selectFrom('workflow_designer_definitions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()

      if (!workflow || (workflow.created_by !== userId && (!collaboration || !collaboration.can_deploy))) {
        return res.status(403).json({
          success: false,
          error: 'Deployment access denied'
        })
      }

      const deploymentId = await designer.deployWorkflow(id)

      // Update workflow status
      await db
        .updateTable('workflow_designer_definitions')
        .set({
          status: 'published',
          updated_at: new Date()
        })
        .where('id', '=', id)
        .execute()

      // Log deployment
      await db
        .insertInto('workflow_analytics')
        .values({
          workflow_id: id,
          event_type: 'deployed',
          user_id: userId,
          recorded_at: new Date()
        })
        .execute()

      res.json({
        success: true,
        data: {
          deploymentId,
          message: 'Workflow deployed successfully'
        }
      })
    } catch (error) {
      logger.error('Failed to deploy workflow:', error)
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
      const userId = (req as any).user?.id

      const workflow = await designer.loadWorkflow(id)
      if (!workflow) {
        return res.status(404).json({
          success: false,
          error: 'Workflow not found'
        })
      }

      // Create test execution record
      const executionId = await db
        .insertInto('workflow_execution_history')
        .values({
          designer_workflow_id: id,
          execution_type: 'test',
          triggered_by: userId,
          trigger_context: JSON.stringify(variables),
          status: 'running'
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      // Here you would integrate with actual workflow engine for test execution
      // For now, we'll simulate a successful test
      setTimeout(async () => {
        await db
          .updateTable('workflow_execution_history')
          .set({
            status: 'completed',
            end_time: new Date(),
            result_data: JSON.stringify({ test: 'successful', nodes_executed: workflow.nodes.length })
          })
          .where('id', '=', executionId.id)
          .execute()
      }, 1000)

      res.json({
        success: true,
        data: {
          executionId: executionId.id,
          message: 'Test execution started'
        }
      })
    } catch (error) {
      logger.error('Failed to test workflow:', error)
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

      const executions = await db
        .selectFrom('workflow_execution_history')
        .selectAll()
        .where('designer_workflow_id', '=', id)
        .orderBy('start_time', 'desc')
        .limit(limit)
        .execute()

      res.json({
        success: true,
        data: executions.map(execution => ({
          ...execution,
          trigger_context: execution.trigger_context ? JSON.parse(execution.trigger_context as string) : {},
          result_data: execution.result_data ? JSON.parse(execution.result_data as string) : null
        }))
      })
    } catch (error) {
      logger.error('Failed to get execution history:', error)
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
      const { userId: targetUserId, role, permissions } = req.body
      const currentUserId = (req as any).user?.id

      // Check if user is owner or has sharing permissions
      const workflow = await db
        .selectFrom('workflow_designer_definitions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()

      if (!workflow || workflow.created_by !== currentUserId) {
        const collaboration = await db
          .selectFrom('workflow_collaboration')
          .selectAll()
          .where('workflow_id', '=', id)
          .where('user_id', '=', currentUserId)
          .executeTakeFirst()

        if (!collaboration || !collaboration.can_share) {
          return res.status(403).json({
            success: false,
            error: 'Sharing access denied'
          })
        }
      }

      // Create or update collaboration record
      await db
        .insertInto('workflow_collaboration')
        .values({
          workflow_id: id,
          user_id: targetUserId,
          role,
          can_edit: role === 'editor' || permissions?.canEdit || false,
          can_deploy: permissions?.canDeploy || false,
          can_share: permissions?.canShare || false,
          can_delete: false,
          shared_by: currentUserId,
          shared_at: new Date()
        })
        .onConflict((oc) => oc.columns(['workflow_id', 'user_id']).doUpdateSet({
          role,
          can_edit: role === 'editor' || permissions?.canEdit || false,
          can_deploy: permissions?.canDeploy || false,
          can_share: permissions?.canShare || false,
          shared_by: currentUserId,
          shared_at: new Date()
        }))
        .execute()

      // Log sharing
      await db
        .insertInto('workflow_analytics')
        .values({
          workflow_id: id,
          event_type: 'shared',
          user_id: currentUserId,
          event_data: JSON.stringify({ shared_with: targetUserId, role }),
          recorded_at: new Date()
        })
        .execute()

      res.json({
        success: true,
        data: { message: 'Workflow shared successfully' }
      })
    } catch (error) {
      logger.error('Failed to share workflow:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to share workflow'
      })
    }
  }
)

export default router