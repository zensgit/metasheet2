/**
 * Pure L5 learner-portal configuration snapshot. Persistence, preview/publish
 * state, media authorization, content visibility, routes, UI, and flags stay
 * in later adapters. Public snapshots contain media ids, never storage keys.
 * External HTTPS targets are navigation-only and must never be server-fetched.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_KEY_LENGTH = 512
const MAX_PLATFORM_NAME_LENGTH = 80
const MAX_TAGLINE_LENGTH = 200
const MAX_LABEL_LENGTH = 80
const MAX_URL_LENGTH = 2_048
const MAX_NAVIGATION_ITEMS = 12
const MAX_BANNERS = 10

const CONFIG_KEYS = [
  'banners',
  'configRevisionId',
  'logoMediaId',
  'navigation',
  'orgId',
  'platformName',
  'tagline',
] as const
const NAVIGATION_KEYS = ['itemKey', 'label', 'target'] as const
const BANNER_KEYS = ['bannerKey', 'mediaId', 'target'] as const
const BUILT_IN_TARGET_KEYS = ['destination', 'kind'] as const
const CONTENT_TARGET_KEYS = ['contentId', 'contentKind', 'kind'] as const
const EXTERNAL_TARGET_KEYS = ['kind', 'url'] as const
const NONE_TARGET_KEYS = ['kind'] as const

export const ELEARNING_PORTAL_BUILT_IN_DESTINATIONS = [
  'instructor_center',
  'learning_center',
  'my_learning',
] as const
export const ELEARNING_PORTAL_CONTENT_KINDS = [
  'course',
  'learning_map',
  'live',
  'offline_training',
  'training_plan',
] as const

export type ElearningPortalBuiltInDestination =
  (typeof ELEARNING_PORTAL_BUILT_IN_DESTINATIONS)[number]
export type ElearningPortalContentKind =
  (typeof ELEARNING_PORTAL_CONTENT_KINDS)[number]

export type ElearningPortalConfigPolicyErrorCode =
  | 'invalid_banner'
  | 'invalid_config'
  | 'invalid_navigation'
  | 'invalid_target'

export class ElearningPortalConfigPolicyError extends Error {
  constructor(readonly code: ElearningPortalConfigPolicyErrorCode) {
    super(code)
    this.name = 'ElearningPortalConfigPolicyError'
  }
}

export interface ElearningPortalBuiltInTarget {
  readonly destination: ElearningPortalBuiltInDestination
  readonly kind: 'built_in'
}

export interface ElearningPortalContentTarget {
  readonly contentId: string
  readonly contentKind: ElearningPortalContentKind
  readonly kind: 'content'
}

export interface ElearningPortalExternalTarget {
  readonly kind: 'external_https'
  readonly url: string
}

export interface ElearningPortalNoTarget {
  readonly kind: 'none'
}

export type ElearningPortalNavigationTarget =
  | ElearningPortalBuiltInTarget
  | ElearningPortalExternalTarget
export type ElearningPortalBannerTarget =
  | ElearningPortalContentTarget
  | ElearningPortalExternalTarget
  | ElearningPortalNoTarget

export interface ElearningPortalNavigationItem {
  readonly itemKey: string
  readonly label: string
  readonly target: ElearningPortalNavigationTarget
}

export interface ElearningPortalBanner {
  readonly bannerKey: string
  readonly mediaId: string
  readonly target: ElearningPortalBannerTarget
}

declare const normalizedPortalConfig: unique symbol

export interface ElearningPortalConfigSnapshot {
  readonly banners: readonly ElearningPortalBanner[]
  readonly configRevisionId: string
  readonly logoMediaId: string | null
  readonly navigation: readonly ElearningPortalNavigationItem[]
  readonly orgId: string
  readonly platformName: string
  readonly tagline: string | null
  readonly [normalizedPortalConfig]: true
}

function fail(code: ElearningPortalConfigPolicyErrorCode): never {
  throw new ElearningPortalConfigPolicyError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: ElearningPortalConfigPolicyErrorCode,
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
    const values: Record<string, unknown> = {}
    for (const key of expectedKeys) values[key] = (input as Record<string, unknown>)[key]
    return values
  } catch (error) {
    if (error instanceof ElearningPortalConfigPolicyError) throw error
    fail(code)
  }
}

function readDenseArray(
  input: unknown,
  code: ElearningPortalConfigPolicyErrorCode,
): readonly unknown[] {
  try {
    if (!Array.isArray(input)) fail(code)
    const length = input.length
    if (Reflect.ownKeys(input).length !== length + 1) fail(code)
    const values: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail(code)
      values.push(input[index])
    }
    return values
  } catch (error) {
    if (error instanceof ElearningPortalConfigPolicyError) throw error
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
  code: ElearningPortalConfigPolicyErrorCode,
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

function requireUuid(
  value: unknown,
  code: ElearningPortalConfigPolicyErrorCode,
): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(code)
  return value.toLowerCase()
}

function requireOptionalText(
  value: unknown,
  maxLength: number,
): string | null {
  return value === null ? null : requireText(value, maxLength, 'invalid_config')
}

function requireExternalUrl(value: unknown): string {
  const text = requireText(value, MAX_URL_LENGTH, 'invalid_target')
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    fail('invalid_target')
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
  ) fail('invalid_target')
  const normalized = parsed.toString()
  if (normalized.length > MAX_URL_LENGTH) fail('invalid_target')
  return normalized
}

function readNavigationTarget(input: unknown): ElearningPortalNavigationTarget {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_target')
  }
  let kind: unknown
  try {
    kind = (input as Record<string, unknown>).kind
  } catch {
    fail('invalid_target')
  }
  if (kind === 'built_in') {
    const values = readExactObject(input, BUILT_IN_TARGET_KEYS, 'invalid_target')
    if (!ELEARNING_PORTAL_BUILT_IN_DESTINATIONS.includes(
      values.destination as ElearningPortalBuiltInDestination,
    )) fail('invalid_target')
    return Object.freeze({
      destination: values.destination as ElearningPortalBuiltInDestination,
      kind,
    })
  }
  if (kind === 'external_https') {
    const values = readExactObject(input, EXTERNAL_TARGET_KEYS, 'invalid_target')
    return Object.freeze({ kind, url: requireExternalUrl(values.url) })
  }
  fail('invalid_target')
}

function readBannerTarget(input: unknown): ElearningPortalBannerTarget {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_target')
  }
  let kind: unknown
  try {
    kind = (input as Record<string, unknown>).kind
  } catch {
    fail('invalid_target')
  }
  if (kind === 'content') {
    const values = readExactObject(input, CONTENT_TARGET_KEYS, 'invalid_target')
    if (!ELEARNING_PORTAL_CONTENT_KINDS.includes(
      values.contentKind as ElearningPortalContentKind,
    )) fail('invalid_target')
    return Object.freeze({
      contentId: requireUuid(values.contentId, 'invalid_target'),
      contentKind: values.contentKind as ElearningPortalContentKind,
      kind,
    })
  }
  if (kind === 'external_https') {
    const values = readExactObject(input, EXTERNAL_TARGET_KEYS, 'invalid_target')
    return Object.freeze({ kind, url: requireExternalUrl(values.url) })
  }
  if (kind === 'none') {
    readExactObject(input, NONE_TARGET_KEYS, 'invalid_target')
    return Object.freeze({ kind })
  }
  fail('invalid_target')
}

export function createElearningPortalConfigSnapshot(
  input: unknown,
): ElearningPortalConfigSnapshot {
  const values = readExactObject(input, CONFIG_KEYS, 'invalid_config')
  const navigationInputs = readDenseArray(values.navigation, 'invalid_navigation')
  if (navigationInputs.length > MAX_NAVIGATION_ITEMS) fail('invalid_navigation')
  const navigationKeys = new Set<string>()
  const navigation = navigationInputs.map((navigationInput) => {
    const item = readExactObject(navigationInput, NAVIGATION_KEYS, 'invalid_navigation')
    const itemKey = requireText(item.itemKey, MAX_KEY_LENGTH, 'invalid_navigation')
    if (navigationKeys.has(itemKey)) fail('invalid_navigation')
    navigationKeys.add(itemKey)
    return Object.freeze({
      itemKey,
      label: requireText(item.label, MAX_LABEL_LENGTH, 'invalid_navigation'),
      target: readNavigationTarget(item.target),
    })
  })

  const bannerInputs = readDenseArray(values.banners, 'invalid_banner')
  if (bannerInputs.length > MAX_BANNERS) fail('invalid_banner')
  const bannerKeys = new Set<string>()
  const banners = bannerInputs.map((bannerInput) => {
    const item = readExactObject(bannerInput, BANNER_KEYS, 'invalid_banner')
    const bannerKey = requireText(item.bannerKey, MAX_KEY_LENGTH, 'invalid_banner')
    if (bannerKeys.has(bannerKey)) fail('invalid_banner')
    bannerKeys.add(bannerKey)
    return Object.freeze({
      bannerKey,
      mediaId: requireUuid(item.mediaId, 'invalid_banner'),
      target: readBannerTarget(item.target),
    })
  })

  return Object.freeze({
    banners: Object.freeze(banners),
    configRevisionId: requireUuid(values.configRevisionId, 'invalid_config'),
    logoMediaId: values.logoMediaId === null
      ? null
      : requireUuid(values.logoMediaId, 'invalid_config'),
    navigation: Object.freeze(navigation),
    orgId: requireText(values.orgId, MAX_KEY_LENGTH, 'invalid_config'),
    platformName: requireText(
      values.platformName,
      MAX_PLATFORM_NAME_LENGTH,
      'invalid_config',
    ),
    tagline: requireOptionalText(values.tagline, MAX_TAGLINE_LENGTH),
  }) as ElearningPortalConfigSnapshot
}
