import { normalizeUserText } from './tasksDraft'

/**
 * The list page's title search box. The page sends the box's text normalized as the server normalizes
 * it (`GET /api/tasks?q=`: a literal, case-insensitive substring of the title, at most 100 code points
 * after normalization, 422 otherwise). The input's limit counts UTF-16 units; the server's answer
 * decides, and the page shows its message when text is refused.
 */
export const TASK_SEARCH_DEBOUNCE_MS = 300

export const TASK_SEARCH_MAX_LENGTH = 100

/** The term the box's text searches for, the server's own after its normalization; `''` when nothing
 *  is left, which the page reads as no search. */
export function taskSearchTerm(raw: string): string {
  return normalizeUserText(raw) ?? ''
}

/**
 * Whether a title the create form just sent holds the active query, for the notice that says a new
 * task is not in the searched list. Decided here rather than from the reloaded rows, like the status
 * filter's notice, so a page that stops short of the new row is not mistaken for a query that leaves
 * it out. Both sides are normalized as the server normalizes them. For non-ASCII letters, case folding
 * follows the database locale on the server, and the list read stays the authority on which rows show.
 */
export function titleHoldsTaskSearch(title: string, query: string): boolean {
  return taskSearchTerm(title).toLowerCase().includes(taskSearchTerm(query).toLowerCase())
}
