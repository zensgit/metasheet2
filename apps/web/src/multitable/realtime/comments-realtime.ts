import { io } from 'socket.io-client'
import { getApiBase } from '../../utils/api'
import {
  normalizeMultitableComment,
  normalizeMultitableCommentFieldId,
  normalizeMultitableCommentIdentity,
} from '../api/client'
import type { MultitableComment } from '../types'

export type MultitableCommentCreatedEvent = {
  containerId?: string
  spreadsheetId?: string
  comment?: Partial<MultitableComment> | null
}

export type MultitableCommentUpdatedEvent = {
  containerId?: string
  spreadsheetId?: string
  comment?: Partial<MultitableComment> | null
}

export type MultitableCommentResolvedEvent = {
  containerId?: string
  spreadsheetId?: string
  targetId?: string | null
  rowId?: string | null
  targetFieldId?: string | null
  fieldId?: string | null
  commentId?: string | null
}

export type MultitableCommentDeletedEvent = {
  containerId?: string
  spreadsheetId?: string
  targetId?: string | null
  rowId?: string | null
  targetFieldId?: string | null
  fieldId?: string | null
  commentId?: string | null
}

export type NormalizedMultitableCommentRealtimeEvent = {
  spreadsheetId: string
  comment: MultitableComment
}

export type NormalizedMultitableCommentMutationEvent = {
  spreadsheetId: string
  rowId: string
  fieldId: string | null
  commentId: string | null
}

export type MultitableCommentsRealtimeHandlers = {
  onCommentCreated?: (payload: MultitableCommentCreatedEvent) => void
  onCommentUpdated?: (payload: MultitableCommentUpdatedEvent) => void
  onCommentResolved?: (payload: MultitableCommentResolvedEvent) => void
  onCommentDeleted?: (payload: MultitableCommentDeletedEvent) => void
}

export type MultitableCommentsRealtimeScope = {
  containerId: string
  targetIds: string[]
}

export type MultitableCommentsRealtimeSubscribe = (
  scope: MultitableCommentsRealtimeScope,
  handlers: MultitableCommentsRealtimeHandlers,
) => () => void

function stripApiSuffix(pathname: string): string {
  if (pathname === '/api') return '/'
  if (pathname.endsWith('/api')) return pathname.slice(0, -4) || '/'
  return pathname
}

export function resolveMultitableCommentsRealtimeBaseUrl(apiBase = getApiBase()): string {
  const fallbackOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8900'
  const url = new URL(apiBase, fallbackOrigin)
  url.pathname = stripApiSuffix(url.pathname)
  return url.toString().replace(/\/$/, '')
}

function emitRoomSubscription(
  socket: ReturnType<typeof io>,
  event: 'join-comment-record' | 'leave-comment-record',
  scope: MultitableCommentsRealtimeScope,
) {
  for (const rowId of scope.targetIds) {
    socket.emit(event, {
      spreadsheetId: scope.containerId,
      rowId,
    })
  }
}

function normalizeCommentId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function normalizeMultitableCommentRealtimeEvent(
  payload: MultitableCommentCreatedEvent | MultitableCommentUpdatedEvent | null | undefined,
): NormalizedMultitableCommentRealtimeEvent | null {
  const comment = payload?.comment
    ? normalizeMultitableComment({
        ...payload.comment,
        containerId: payload.comment.containerId ?? payload.containerId ?? payload.spreadsheetId,
        spreadsheetId: payload.comment.spreadsheetId ?? payload.containerId ?? payload.spreadsheetId,
      })
    : null

  if (!comment) return null
  if (!comment.containerId || !comment.targetId) return null

  const identity = normalizeMultitableCommentIdentity({
    containerId: payload?.containerId ?? payload?.spreadsheetId,
    spreadsheetId: payload?.containerId ?? payload?.spreadsheetId,
    targetId: comment.targetId,
    rowId: comment.rowId ?? comment.targetId,
  })

  return {
    spreadsheetId: identity.containerId || comment.containerId,
    comment,
  }
}

export function normalizeMultitableCommentMutationEvent(
  payload: MultitableCommentResolvedEvent | MultitableCommentDeletedEvent | null | undefined,
): NormalizedMultitableCommentMutationEvent | null {
  const identity = normalizeMultitableCommentIdentity({
    containerId: payload?.containerId ?? payload?.spreadsheetId,
    spreadsheetId: payload?.containerId ?? payload?.spreadsheetId,
    targetId: payload?.targetId ?? payload?.rowId,
    rowId: payload?.targetId ?? payload?.rowId,
  })

  if (!identity.containerId || !identity.targetId) return null

  return {
    spreadsheetId: identity.containerId,
    rowId: identity.targetId,
    fieldId: normalizeMultitableCommentFieldId({
      fieldId: payload?.fieldId ?? payload?.targetFieldId,
      targetFieldId: payload?.targetFieldId ?? payload?.fieldId,
    }),
    commentId: normalizeCommentId(payload?.commentId),
  }
}

export type MultitableCommentSheetRealtimeSubscribe = (
  spreadsheetId: string,
  handlers: MultitableCommentsRealtimeHandlers,
) => () => void

export const subscribeToMultitableCommentSheetRealtime: MultitableCommentSheetRealtimeSubscribe = (spreadsheetId, handlers) => {
  if (typeof window === 'undefined' || !spreadsheetId) return () => {}

  const socket = io(resolveMultitableCommentsRealtimeBaseUrl(), {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
  })
  const handleConnect = () => {
    socket.emit('join-comment-sheet', { spreadsheetId })
  }

  socket.on('connect', handleConnect)
  if (handlers.onCommentCreated) socket.on('comment:created', handlers.onCommentCreated)
  if (handlers.onCommentUpdated) socket.on('comment:updated', handlers.onCommentUpdated)
  if (handlers.onCommentResolved) socket.on('comment:resolved', handlers.onCommentResolved)
  if (handlers.onCommentDeleted) socket.on('comment:deleted', handlers.onCommentDeleted)
  if (socket.connected) handleConnect()

  return () => {
    if (socket.connected) {
      socket.emit('leave-comment-sheet', { spreadsheetId })
    }
    socket.off('connect', handleConnect)
    if (handlers.onCommentCreated) socket.off('comment:created', handlers.onCommentCreated)
    if (handlers.onCommentUpdated) socket.off('comment:updated', handlers.onCommentUpdated)
    if (handlers.onCommentResolved) socket.off('comment:resolved', handlers.onCommentResolved)
    if (handlers.onCommentDeleted) socket.off('comment:deleted', handlers.onCommentDeleted)
    socket.disconnect()
  }
}

export const subscribeToMultitableCommentsRealtime: MultitableCommentsRealtimeSubscribe = (scope, handlers) => {
  if (typeof window === 'undefined') return () => {}

  const socket = io(resolveMultitableCommentsRealtimeBaseUrl(), {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
  })
  const handleConnect = () => {
    emitRoomSubscription(socket, 'join-comment-record', scope)
  }

  socket.on('connect', handleConnect)
  if (handlers.onCommentCreated) socket.on('comment:created', handlers.onCommentCreated)
  if (handlers.onCommentUpdated) socket.on('comment:updated', handlers.onCommentUpdated)
  if (handlers.onCommentResolved) socket.on('comment:resolved', handlers.onCommentResolved)
  if (handlers.onCommentDeleted) socket.on('comment:deleted', handlers.onCommentDeleted)
  if (socket.connected) handleConnect()

  return () => {
    if (socket.connected) {
      emitRoomSubscription(socket, 'leave-comment-record', scope)
    }
    socket.off('connect', handleConnect)
    if (handlers.onCommentCreated) socket.off('comment:created', handlers.onCommentCreated)
    if (handlers.onCommentUpdated) socket.off('comment:updated', handlers.onCommentUpdated)
    if (handlers.onCommentResolved) socket.off('comment:resolved', handlers.onCommentResolved)
    if (handlers.onCommentDeleted) socket.off('comment:deleted', handlers.onCommentDeleted)
    socket.disconnect()
  }
}
