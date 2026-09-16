/**
 * #5795 — disclosure bounds for the comment @-mention candidate reads
 * (GET /api/comments/mention-candidates and GET /api/multitable/:spreadsheetId/mention-candidates,
 * both served by CommentService.listMentionCandidates).
 *
 * These are currently the SAME two numbers #5781 put on the person-field directory
 * (routes/univer-meta.ts PERSON_DIRECTORY_MAX_ITEMS / PERSON_DIRECTORY_MIN_QUERY_LENGTH). They are
 * separate literals, NOT aliases (a service module should not import a route module), so nothing ties
 * them by construction: tests/unit/multitable-form-share-candidates-bounded.test.ts asserts the two
 * pairs are equal, so a change to either side fails there until both move together. They live in their
 * own module rather than in the route or the service because BOTH need them (route = term gate +
 * truncation signal, service = the SQL LIMIT and a second term gate), and unit suites mock
 * CommentService wholesale.
 *
 * Ceiling 50 (was 100 in the service, 200 via the route's generic clampLimit): the mention UIs render
 * at most 6 suggestions (MetaCommentComposer / MetaRichLongTextEditor), and the only caller that ever
 * asked for 100 was the workbench's term-less roster preload, which existed solely to filter the
 * roster client-side. With search now server-side, nothing in the UI needs more than the ceiling.
 *
 * Minimum term length 1: same reasoning as #5781 — the composer re-queries as the user types, and a
 * one-character CJK surname is a legitimate search.
 *
 * WHAT THE TERM REQUIREMENT IS NOT: a narrowing guarantee. The term is matched as a substring of name,
 * email AND id, so a character (almost) every row contains (`-` is in every UUID-shaped id, `@` in
 * every well-formed email address) passes the minimum and returns essentially the first page a
 * term-less call used to (see residual (1) on the
 * person-directory route in routes/univer-meta.ts). It removes the UI's automatic term-less request;
 * against a deliberate caller the per-request bound is MENTION_CANDIDATES_MAX_ITEMS alone.
 */
export const MENTION_CANDIDATES_MAX_ITEMS = 50
export const MENTION_CANDIDATES_MIN_QUERY_LENGTH = 1

/** Escapes the LIKE metacharacters so a term behaves as a literal substring (PG's default LIKE escape
 *  character is the backslash) — same convention as person-field-restriction.ts (#5781). This is
 *  search correctness (a typed `%` or `_` searches for that character instead of matching anything),
 *  NOT a disclosure bound: `-` or `@` already match every row without any metacharacter (see above). */
export function escapeMentionLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
