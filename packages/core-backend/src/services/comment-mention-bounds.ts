/**
 * #5795 — disclosure bounds for the comment @-mention candidate reads
 * (GET /api/comments/mention-candidates and GET /api/multitable/:spreadsheetId/mention-candidates,
 * both served by CommentService.listMentionCandidates).
 *
 * These are the SAME two numbers #5781 put on the person-field directory
 * (routes/univer-meta.ts PERSON_DIRECTORY_MAX_ITEMS / PERSON_DIRECTORY_MIN_QUERY_LENGTH), so the
 * roster-shaped reads cannot disclose different volumes. They live in their own module rather than in
 * the route or the service because BOTH need them (route = term gate + truncation signal, service =
 * the SQL LIMIT and a second term gate), and unit suites mock CommentService wholesale.
 *
 * Ceiling 50 (was 100 in the service, 200 via the route's generic clampLimit): the mention UIs render
 * at most 6 suggestions (MetaCommentComposer / MetaRichLongTextEditor), and the only caller that ever
 * asked for 100 was the workbench's term-less roster preload, which existed solely to filter the
 * roster client-side. With search now server-side, nothing in the UI needs more than the ceiling.
 *
 * Minimum term length 1: same reasoning as #5781 — the composer re-queries as the user types, and a
 * one-character CJK surname is a legitimate search.
 */
export const MENTION_CANDIDATES_MAX_ITEMS = 50
export const MENTION_CANDIDATES_MIN_QUERY_LENGTH = 1

/** Escapes the LIKE metacharacters so a term behaves as a literal substring (PG's default LIKE escape
 *  character is the backslash) — same convention as person-field-restriction.ts (#5781). Without it a
 *  bare `%` or `_` passes the one-character minimum yet matches EVERY active user, i.e. it would
 *  return exactly the unfiltered first page the term gate exists to refuse. */
export function escapeMentionLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
