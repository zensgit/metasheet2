/**
 * Task list routes (M4 PR-3a, design task-m4-pr3a-backend-design-20260930.md §3.2). Registered by
 * `tasksRouter()` onto its own router (no nested Router, no new mount, no new flag read), so they
 * exist only when that factory mounts.
 *
 * RULED(2026-10-07): [R13] lists are archived, never deleted: there is no DELETE route.
 * RULED(2026-10-07): [R18] no route here uses `tasks:admin`.
 * ASSUMPTION(task-m4): [own-19] with no org claim: a write is 422 ORG_MISSING, the "my lists"
 * collection and the two personal-group collections are the degraded 200 body, and a read under
 * one list id is 404 ([own-33] for events, [own-42] for the member roster, [own-43] for the items,
 * [own-48] for the groups and their placements).
 * Static segments are registered before parameter segments.
 */
import type { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import {
  addTaskListMember,
  addTaskToList,
  changeTaskListMemberRole,
  createTaskList,
  getTaskList,
  listTaskListEvents,
  listTaskListItems,
  listTaskListMembers,
  listTaskLists,
  removeTaskFromList,
  removeTaskListMember,
  renameTaskList,
  setTaskListArchived,
  transferTaskListOwner,
} from '../services/task-list-records'
import {
  createTaskListGroup,
  createUserTaskGroup,
  deleteTaskListGroup,
  deleteUserTaskGroup,
  listTaskListGroupItems,
  listTaskListGroups,
  listUserTaskGroupItems,
  listUserTaskGroups,
  placeTaskInListGroup,
  placeTaskInUserGroup,
  renameTaskListGroup,
  renameUserTaskGroup,
} from '../services/task-group-records'
import { actorId, orgId, sendError } from './tasks-http'

export function registerTaskListRoutes(router: Router): void {
  router.get('/api/task-lists', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.json({ items: [], degraded: true, reason: 'org_missing' })
        return
      }
      res.json(await listTaskLists({
        orgId: org,
        actorId: actorId(req),
        query: { limit: req.query.limit, offset: req.query.offset, includeArchived: req.query.includeArchived },
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/task-lists', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await createTaskList({ orgId: org, actorId: actorId(req), body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.get('/api/task-lists/:id/events', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      res.json(await listTaskListEvents({
        orgId: org,
        actorId: actorId(req),
        listId: req.params.id,
        query: { limit: req.query.limit, offset: req.query.offset },
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/task-lists/:id/archive', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await setTaskListArchived({ orgId: org, actorId: actorId(req), listId: req.params.id, archived: true }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/task-lists/:id/unarchive', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await setTaskListArchived({ orgId: org, actorId: actorId(req), listId: req.params.id, archived: false }))
    } catch (err) {
      sendError(res, err)
    }
  })

  // S6: members and ownership (design §3.3). The DELETE below removes a member of a list, which
  // [R13] leaves untouched: there is still no route that deletes a list.
  router.get('/api/task-lists/:id/members', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      res.json(await listTaskListMembers({
        orgId: org,
        actorId: actorId(req),
        listId: req.params.id,
        query: { limit: req.query.limit, offset: req.query.offset },
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/task-lists/:id/members', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await addTaskListMember({ orgId: org, actorId: actorId(req), listId: req.params.id, body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.patch('/api/task-lists/:id/members/:userId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await changeTaskListMemberRole({
        orgId: org,
        actorId: actorId(req),
        listId: req.params.id,
        userId: req.params.userId,
        body: req.body,
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/api/task-lists/:id/members/:userId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await removeTaskListMember({
        orgId: org,
        actorId: actorId(req),
        listId: req.params.id,
        userId: req.params.userId,
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/task-lists/:id/transfer-owner', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await transferTaskListOwner({ orgId: org, actorId: actorId(req), listId: req.params.id, body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })

  // S7: the list's items (design §3.4).
  router.get('/api/task-lists/:id/items', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      res.json(await listTaskListItems({
        orgId: org,
        actorId: actorId(req),
        listId: req.params.id,
        query: { limit: req.query.limit, offset: req.query.offset },
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/task-lists/:id/items', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await addTaskToList({ orgId: org, actorId: actorId(req), listId: req.params.id, body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/api/task-lists/:id/items/:taskId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await removeTaskFromList({
        orgId: org,
        actorId: actorId(req),
        listId: req.params.id,
        taskId: req.params.taskId,
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  // S8: the list's groups and the placements of its items (design §3.5).
  router.get('/api/task-lists/:id/groups', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      res.json(await listTaskListGroups({
        orgId: org,
        actorId: actorId(req),
        listId: req.params.id,
        query: { limit: req.query.limit, offset: req.query.offset },
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/task-lists/:id/groups', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await createTaskListGroup({ orgId: org, actorId: actorId(req), listId: req.params.id, body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.patch('/api/task-lists/:id/groups/:groupId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await renameTaskListGroup({
        orgId: org,
        actorId: actorId(req),
        listId: req.params.id,
        groupId: req.params.groupId,
        body: req.body,
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/api/task-lists/:id/groups/:groupId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await deleteTaskListGroup({ orgId: org, actorId: actorId(req), listId: req.params.id, groupId: req.params.groupId }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.get('/api/task-lists/:id/group-items', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      res.json(await listTaskListGroupItems({
        orgId: org,
        actorId: actorId(req),
        listId: req.params.id,
        query: { limit: req.query.limit, offset: req.query.offset },
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.put('/api/task-lists/:id/group-items/:taskId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await placeTaskInListGroup({
        orgId: org,
        actorId: actorId(req),
        listId: req.params.id,
        taskId: req.params.taskId,
        body: req.body,
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.get('/api/task-lists/:id', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      res.json(await getTaskList({ orgId: org, actorId: actorId(req), listId: req.params.id }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.patch('/api/task-lists/:id', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await renameTaskList({ orgId: org, actorId: actorId(req), listId: req.params.id, body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })

  // S8: the caller's personal groups in the token's org (design §3.5). The static `items` segment is
  // registered before `/:groupId`; the two share no method.
  router.get('/api/task-groups', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.json({ items: [], degraded: true, reason: 'org_missing' })
        return
      }
      res.json(await listUserTaskGroups({
        orgId: org,
        actorId: actorId(req),
        query: { limit: req.query.limit, offset: req.query.offset },
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/task-groups', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await createUserTaskGroup({ orgId: org, actorId: actorId(req), body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.get('/api/task-groups/items', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.json({ items: [], degraded: true, reason: 'org_missing' })
        return
      }
      res.json(await listUserTaskGroupItems({
        orgId: org,
        actorId: actorId(req),
        query: { limit: req.query.limit, offset: req.query.offset },
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.put('/api/task-groups/items/:taskId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await placeTaskInUserGroup({ orgId: org, actorId: actorId(req), taskId: req.params.taskId, body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.patch('/api/task-groups/:groupId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await renameUserTaskGroup({ orgId: org, actorId: actorId(req), groupId: req.params.groupId, body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/api/task-groups/:groupId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await deleteUserTaskGroup({ orgId: org, actorId: actorId(req), groupId: req.params.groupId }))
    } catch (err) {
      sendError(res, err)
    }
  })
}
