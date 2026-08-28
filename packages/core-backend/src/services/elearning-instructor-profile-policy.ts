/**
 * Pure L4-L5 instructor profile policy. Persistence, instructor/user binding,
 * management scope, content access evaluation, routes, UI, and flags belong to
 * later adapters. `visible` is a server-computed input; callers must recheck
 * content access before building each public profile.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ORG_ID_LENGTH = 256
const MAX_DISPLAY_NAME_LENGTH = 120
const MAX_BIO_LENGTH = 2_000
const MAX_LEVEL_NAME_LENGTH = 120
const MAX_CAPABILITY_REQUIREMENTS_LENGTH = 2_000
const MAX_CONTENT_TITLE_LENGTH = 300
const MAX_TEACHING_CONTENT = 500

const PROFILE_KEYS = [
  'avatarMediaId',
  'bio',
  'displayName',
  'instructorId',
  'level',
  'orgId',
  'profileRevisionId',
  'status',
] as const
const LEVEL_KEYS = ['capabilityRequirements', 'levelId', 'name'] as const
const PUBLIC_PROFILE_INPUT_KEYS = ['profile', 'teachingContent'] as const
const TEACHING_CONTENT_KEYS = ['contentId', 'contentKind', 'title', 'visible'] as const

export const ELEARNING_INSTRUCTOR_PROFILE_STATUSES = ['active', 'archived'] as const
export const ELEARNING_INSTRUCTOR_CONTENT_KINDS = [
  'course',
  'live',
  'offline_training',
] as const

export type ElearningInstructorProfileStatus =
  (typeof ELEARNING_INSTRUCTOR_PROFILE_STATUSES)[number]
export type ElearningInstructorContentKind =
  (typeof ELEARNING_INSTRUCTOR_CONTENT_KINDS)[number]

export type ElearningInstructorProfilePolicyErrorCode =
  | 'duplicate_content'
  | 'invalid_content'
  | 'invalid_level'
  | 'invalid_profile'
  | 'profile_unavailable'

export class ElearningInstructorProfilePolicyError extends Error {
  constructor(readonly code: ElearningInstructorProfilePolicyErrorCode) {
    super(code)
    this.name = 'ElearningInstructorProfilePolicyError'
  }
}

export interface ElearningInstructorLevelSnapshot {
  readonly capabilityRequirements: string
  readonly levelId: string
  readonly name: string
}

declare const normalizedInstructorProfile: unique symbol

export interface ElearningInstructorProfileSnapshot {
  readonly avatarMediaId: string | null
  readonly bio: string | null
  readonly displayName: string
  readonly instructorId: string
  readonly level: ElearningInstructorLevelSnapshot | null
  readonly orgId: string
  readonly profileRevisionId: string
  readonly status: ElearningInstructorProfileStatus
  readonly [normalizedInstructorProfile]: true
}

export interface ElearningInstructorPublicLevel {
  readonly levelId: string
  readonly name: string
}

export interface ElearningInstructorPublicContent {
  readonly contentId: string
  readonly contentKind: ElearningInstructorContentKind
  readonly title: string
}

export interface ElearningInstructorTeachingContentCounts {
  readonly course: number
  readonly live: number
  readonly offlineTraining: number
}

export interface ElearningInstructorPublicProfile {
  readonly avatarMediaId: string | null
  readonly bio: string | null
  readonly displayName: string
  readonly instructorId: string
  readonly level: ElearningInstructorPublicLevel | null
  readonly profileRevisionId: string
  readonly teachingContent: readonly ElearningInstructorPublicContent[]
  readonly teachingContentCounts: ElearningInstructorTeachingContentCounts
}

function fail(code: ElearningInstructorProfilePolicyErrorCode): never {
  throw new ElearningInstructorProfilePolicyError(code)
}

function inspectExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: ElearningInstructorProfilePolicyErrorCode,
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(code)
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail(code)
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== expectedKeys.length
      || sorted.some((key, index) => key !== expectedKeys[index])
    ) fail(code)
    return input as Record<string, unknown>
  } catch (error) {
    if (error instanceof ElearningInstructorProfilePolicyError) throw error
    fail(code)
  }
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: ElearningInstructorProfilePolicyErrorCode,
): Record<string, unknown> {
  const source = inspectExactObject(input, expectedKeys, code)
  const values: Record<string, unknown> = {}
  try {
    for (const key of expectedKeys) values[key] = source[key]
    return values
  } catch {
    fail(code)
  }
}

function readProperty(
  input: Record<string, unknown>,
  key: string,
  code: ElearningInstructorProfilePolicyErrorCode,
): unknown {
  try {
    return input[key]
  } catch {
    fail(code)
  }
}

function readDenseArray(
  input: unknown,
  code: ElearningInstructorProfilePolicyErrorCode,
): readonly unknown[] {
  try {
    if (!Array.isArray(input)) fail(code)
    const length = input.length
    if (length > MAX_TEACHING_CONTENT || Reflect.ownKeys(input).length !== length + 1) {
      fail(code)
    }
    const values: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail(code)
      values.push(input[index])
    }
    return values
  } catch (error) {
    if (error instanceof ElearningInstructorProfilePolicyError) throw error
    fail(code)
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      return false
    }
  }
  return true
}

function requireText(
  value: unknown,
  maxLength: number,
  code: ElearningInstructorProfilePolicyErrorCode,
): string {
  if (typeof value !== 'string') fail(code)
  const text = value.trim()
  if (
    text === ''
    || text.length > maxLength
    || text.includes('\0')
    || !isWellFormedUnicode(text)
  ) fail(code)
  return text
}

function requireNullableText(
  value: unknown,
  maxLength: number,
  code: ElearningInstructorProfilePolicyErrorCode,
): string | null {
  return value === null ? null : requireText(value, maxLength, code)
}

function requireUuid(
  value: unknown,
  code: ElearningInstructorProfilePolicyErrorCode,
): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(code)
  return value.toLowerCase()
}

function readLevel(input: unknown): ElearningInstructorLevelSnapshot | null {
  if (input === null) return null
  const values = readExactObject(input, LEVEL_KEYS, 'invalid_level')
  return Object.freeze({
    capabilityRequirements: requireText(
      values.capabilityRequirements,
      MAX_CAPABILITY_REQUIREMENTS_LENGTH,
      'invalid_level',
    ),
    levelId: requireUuid(values.levelId, 'invalid_level'),
    name: requireText(values.name, MAX_LEVEL_NAME_LENGTH, 'invalid_level'),
  })
}

export function createElearningInstructorProfileSnapshot(
  input: unknown,
): ElearningInstructorProfileSnapshot {
  const values = readExactObject(input, PROFILE_KEYS, 'invalid_profile')
  if (!ELEARNING_INSTRUCTOR_PROFILE_STATUSES.includes(
    values.status as ElearningInstructorProfileStatus,
  )) fail('invalid_profile')
  return Object.freeze({
    avatarMediaId: values.avatarMediaId === null
      ? null
      : requireUuid(values.avatarMediaId, 'invalid_profile'),
    bio: requireNullableText(values.bio, MAX_BIO_LENGTH, 'invalid_profile'),
    displayName: requireText(
      values.displayName,
      MAX_DISPLAY_NAME_LENGTH,
      'invalid_profile',
    ),
    instructorId: requireUuid(values.instructorId, 'invalid_profile'),
    level: readLevel(values.level),
    orgId: requireText(values.orgId, MAX_ORG_ID_LENGTH, 'invalid_profile'),
    profileRevisionId: requireUuid(values.profileRevisionId, 'invalid_profile'),
    status: values.status as ElearningInstructorProfileStatus,
  }) as ElearningInstructorProfileSnapshot
}

function readVisibleContent(input: unknown): ElearningInstructorPublicContent | null {
  const source = inspectExactObject(input, TEACHING_CONTENT_KEYS, 'invalid_content')
  const visible = readProperty(source, 'visible', 'invalid_content')
  if (typeof visible !== 'boolean') fail('invalid_content')
  if (!visible) return null
  const contentKind = readProperty(source, 'contentKind', 'invalid_content')
  if (!ELEARNING_INSTRUCTOR_CONTENT_KINDS.includes(
    contentKind as ElearningInstructorContentKind,
  )) fail('invalid_content')
  return Object.freeze({
    contentId: requireUuid(
      readProperty(source, 'contentId', 'invalid_content'),
      'invalid_content',
    ),
    contentKind: contentKind as ElearningInstructorContentKind,
    title: requireText(
      readProperty(source, 'title', 'invalid_content'),
      MAX_CONTENT_TITLE_LENGTH,
      'invalid_content',
    ),
  })
}

export function buildElearningInstructorPublicProfile(
  input: unknown,
): ElearningInstructorPublicProfile {
  const values = readExactObject(
    input,
    PUBLIC_PROFILE_INPUT_KEYS,
    'invalid_profile',
  )
  const profile = createElearningInstructorProfileSnapshot(values.profile)
  if (profile.status !== 'active') fail('profile_unavailable')

  const teachingContent: ElearningInstructorPublicContent[] = []
  const identities = new Set<string>()
  for (const item of readDenseArray(values.teachingContent, 'invalid_content')) {
    const content = readVisibleContent(item)
    if (content === null) continue
    const identity = `${content.contentKind}:${content.contentId}`
    if (identities.has(identity)) fail('duplicate_content')
    identities.add(identity)
    teachingContent.push(content)
  }

  const counts = Object.freeze({
    course: teachingContent.filter((item) => item.contentKind === 'course').length,
    live: teachingContent.filter((item) => item.contentKind === 'live').length,
    offlineTraining: teachingContent.filter(
      (item) => item.contentKind === 'offline_training',
    ).length,
  })
  const level = profile.level === null
    ? null
    : Object.freeze({ levelId: profile.level.levelId, name: profile.level.name })

  return Object.freeze({
    avatarMediaId: profile.avatarMediaId,
    bio: profile.bio,
    displayName: profile.displayName,
    instructorId: profile.instructorId,
    level,
    profileRevisionId: profile.profileRevisionId,
    teachingContent: Object.freeze(teachingContent),
    teachingContentCounts: counts,
  })
}
