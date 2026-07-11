export type CommentRecordRoomScope = {
  spreadsheetId: string
  rowId: string
}

export function buildCommentRecordRoom(scope: CommentRecordRoomScope): string {
  return `comments:${scope.spreadsheetId}:${scope.rowId}`
}

export type CommentSheetRoomScope = {
  spreadsheetId: string
}

export function buildCommentSheetRoom(scope: CommentSheetRoomScope): string {
  return `comments-sheet:${scope.spreadsheetId}`
}

export type CommentInboxRoomScope = {
  userId: string
}

export function buildCommentInboxRoom(scope: CommentInboxRoomScope): string {
  return `comments-inbox:${scope.userId}`
}
