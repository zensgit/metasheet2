export class DirectoryUserPaginationError extends Error {
  readonly code = 'DIRECTORY_USER_PAGINATION_INCOMPLETE'

  constructor() {
    super('Directory sync user pagination is incomplete')
    this.name = 'DirectoryUserPaginationError'
  }
}

export function getNextDirectoryUserCursor(
  page: { hasMore: boolean; nextCursor: number | null },
  seenCursors: ReadonlySet<number>,
): number | null {
  if (!page.hasMore) return null

  const nextCursor = page.nextCursor
  if (nextCursor === null || !Number.isSafeInteger(nextCursor) || nextCursor < 0 || seenCursors.has(nextCursor)) {
    throw new DirectoryUserPaginationError()
  }
  return nextCursor
}
