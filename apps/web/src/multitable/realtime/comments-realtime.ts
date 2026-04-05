import { io } from 'socket.io-client'
import { getApiBase } from '../../utils/api'
import type { MultitableComment } from '../types'

export type MultitableCommentCreatedEvent = {
  spreadsheetId?: string
  comment?: Partial<MultitableComment> | null
}

export type MultitableCommentUpdatedEvent = {
  spreadsheetId?: string
  comment?: Partial<MultitableComment> | null
}

export type MultitableCommentResolvedEvent = {
  spreadsheetId?: string
  rowId?: string | null
  fieldId?: string | null
  commentId?: string | null
}

export type MultitableCommentDeletedEvent = {
  spreadsheetId?: string
  rowId?: string | null
  fieldId?: string | null
  commentId?: string | null
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
