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

export function buildCommentInboxRoom(): string {
  return 'comments-inbox'
}
