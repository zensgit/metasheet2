/**
 * Length limits for a caller-supplied regular expression — browser copy.
 *
 * This is the public form's copy of the LENGTH GATE in
 * `packages/core-backend/src/formula/regex-safety.ts` (the two roots share no
 * import edge). The constants and `findUserRegexLengthRefusal` are kept
 * identical to that module and are pinned against it, and against the
 * integration plugin's copy, by
 * `packages/core-backend/tests/unit/user-regex-limits-three-copy-parity.test.ts`.
 * The sources of the two numbers are documented on the backend copy.
 *
 * The form runs a field's `validation.pattern` on the submitter's own thread,
 * so a value over the limit is refused here before the pattern runs on it.
 */

export const USER_REGEX_MAX_SUBJECT_LEN = 10000

export const USER_REGEX_MAX_PATTERN_LEN = 4000

export type UserRegexLengthRefusal =
  | { kind: 'pattern-too-long'; length: number; limit: number }
  | { kind: 'subject-too-long'; length: number; limit: number }

export function findUserRegexLengthRefusal(
  patternLength: number,
  subjectLength: number,
): UserRegexLengthRefusal | null {
  if (patternLength > USER_REGEX_MAX_PATTERN_LEN) {
    return { kind: 'pattern-too-long', length: patternLength, limit: USER_REGEX_MAX_PATTERN_LEN }
  }
  if (subjectLength > USER_REGEX_MAX_SUBJECT_LEN) {
    return { kind: 'subject-too-long', length: subjectLength, limit: USER_REGEX_MAX_SUBJECT_LEN }
  }
  return null
}
