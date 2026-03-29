#!/usr/bin/env node

const env = process.env

function read(key) {
  const value = env[key]
  return typeof value === 'string' ? value.trim() : ''
}

function isEnabled(key) {
  return read(key).toLowerCase() === 'true'
}

function isValidAbsoluteUrl(value) {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function resolveRedirectUri() {
  const explicit = read('DINGTALK_REDIRECT_URI')
  if (explicit) return explicit

  const publicAppUrl = read('PUBLIC_APP_URL').replace(/\/$/, '')
  if (!publicAppUrl) return ''
  return `${publicAppUrl}/auth/dingtalk/callback`
}

function printSection(title) {
  console.log(`\n[${title}]`)
}

function printOk(message) {
  console.log(`OK   ${message}`)
}

function printWarn(message) {
  console.log(`WARN ${message}`)
}

function printError(message) {
  console.log(`ERR  ${message}`)
}

const errors = []
const warnings = []

const enabled = read('DINGTALK_AUTH_ENABLED') !== 'false' && read('DINGTALK_AUTH_ENABLED') !== ''
const explicitClientId = read('DINGTALK_CLIENT_ID')
const explicitClientSecret = read('DINGTALK_CLIENT_SECRET')
const fallbackAppKey = read('DINGTALK_APP_KEY')
const fallbackAppSecret = read('DINGTALK_APP_SECRET')
const clientId = explicitClientId || fallbackAppKey
const clientSecret = explicitClientSecret || fallbackAppSecret
const publicAppUrl = read('PUBLIC_APP_URL')
const redirectUri = resolveRedirectUri()
const allowedCorpIds = read('DINGTALK_ALLOWED_CORP_IDS')
const autoProvision = isEnabled('DINGTALK_AUTO_PROVISION')
const autoProvisionPresetId = read('DINGTALK_AUTO_PROVISION_PRESET_ID')
const autoProvisionOrgId = read('DINGTALK_AUTO_PROVISION_ORG_ID')
const autoProvisionEmailDomain = read('DINGTALK_AUTO_PROVISION_EMAIL_DOMAIN')

printSection('DingTalk Auth Preflight')
console.log(`Mode: ${enabled ? 'enabled' : 'disabled'}`)

if (!enabled) {
  printWarn('DINGTALK_AUTH_ENABLED is false or unset; DingTalk auth routes will remain unavailable.')
  process.exit(0)
}

if (!clientId) {
  errors.push('Missing DINGTALK_CLIENT_ID (or fallback DINGTALK_APP_KEY).')
} else if (explicitClientId) {
  printOk('DINGTALK_CLIENT_ID is configured.')
} else {
  warnings.push('Using fallback DINGTALK_APP_KEY; prefer DINGTALK_CLIENT_ID for explicit auth config.')
}

if (!clientSecret) {
  errors.push('Missing DINGTALK_CLIENT_SECRET (or fallback DINGTALK_APP_SECRET).')
} else if (explicitClientSecret) {
  printOk('DINGTALK_CLIENT_SECRET is configured.')
} else {
  warnings.push('Using fallback DINGTALK_APP_SECRET; prefer DINGTALK_CLIENT_SECRET for explicit auth config.')
}

if (!publicAppUrl) {
  errors.push('Missing PUBLIC_APP_URL; backend cannot derive a browser callback URL.')
} else if (!isValidAbsoluteUrl(publicAppUrl)) {
  errors.push(`PUBLIC_APP_URL is not a valid absolute URL: ${publicAppUrl}`)
} else {
  printOk(`PUBLIC_APP_URL = ${publicAppUrl}`)
}

if (!redirectUri) {
  errors.push('Unable to resolve DingTalk redirect URI.')
} else if (!isValidAbsoluteUrl(redirectUri)) {
  errors.push(`DINGTALK_REDIRECT_URI is not a valid absolute URL: ${redirectUri}`)
} else {
  const redirectPathOk = new URL(redirectUri).pathname === '/auth/dingtalk/callback'
  if (!redirectPathOk) {
    warnings.push(`Redirect path is ${new URL(redirectUri).pathname}; expected /auth/dingtalk/callback for the current frontend route.`)
  } else {
    printOk(`Redirect URI = ${redirectUri}`)
  }
}

if (!read('JWT_SECRET')) {
  warnings.push('JWT_SECRET is empty; DingTalk state signing will fall back to a weak default in non-production scenarios.')
}

if (autoProvision) {
  printOk('DINGTALK_AUTO_PROVISION is enabled.')
  if (!allowedCorpIds) {
    warnings.push('Auto-provision is enabled without DINGTALK_ALLOWED_CORP_IDS; enterprise scope is unconstrained.')
  }
  if (!autoProvisionPresetId) {
    warnings.push('Auto-provision is enabled without DINGTALK_AUTO_PROVISION_PRESET_ID; backend will fall back to its default preset.')
  }
  if (!autoProvisionOrgId) {
    warnings.push('Auto-provision is enabled without DINGTALK_AUTO_PROVISION_ORG_ID; backend will fall back to its default org.')
  }
  if (!autoProvisionEmailDomain) {
    warnings.push('Auto-provision is enabled without DINGTALK_AUTO_PROVISION_EMAIL_DOMAIN; synthetic email generation may be inconsistent.')
  }
} else {
  printWarn('DINGTALK_AUTO_PROVISION is disabled; only pre-bound local accounts can complete DingTalk login.')
}

if (!read('CORS_ORIGIN')) {
  warnings.push('CORS_ORIGIN is empty; browser callback requests may fail across origins.')
}

if (allowedCorpIds) {
  printOk(`Allowed corp IDs: ${allowedCorpIds}`)
}

if (warnings.length > 0) {
  printSection('Warnings')
  for (const warning of warnings) {
    printWarn(warning)
  }
}

if (errors.length > 0) {
  printSection('Errors')
  for (const error of errors) {
    printError(error)
  }
  process.exit(1)
}

printSection('Summary')
printOk('DingTalk auth configuration passed preflight.')
