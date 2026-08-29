'use strict'

const { FLAG_NAMES } = require('../lib/feature-flags.cjs')

const LOOKALIKES = Object.freeze([
  'TRUE',
  'True',
  '1',
  'yes',
  'on',
  'true ',
  ' true',
])

function snapshotFlags(extraKeys) {
  const snapshot = {}
  const keys = extraKeys && extraKeys.length
    ? [...new Set([...FLAG_NAMES, ...extraKeys])]
    : [...FLAG_NAMES]
  for (const name of keys) {
    snapshot[name] = Object.prototype.hasOwnProperty.call(process.env, name)
      ? process.env[name]
      : undefined
  }
  return snapshot
}

function restoreFlags(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

function clearFlags() {
  for (const name of FLAG_NAMES) {
    delete process.env[name]
  }
}

function setFlags(map) {
  clearFlags()
  for (const [name, value] of Object.entries(map)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

function withFlags(map, fn) {
  const snapshot = snapshotFlags(Object.keys(map))
  try {
    setFlags(map)
    return fn()
  } finally {
    restoreFlags(snapshot)
  }
}

async function withFlagsAsync(map, fn) {
  const snapshot = snapshotFlags(Object.keys(map))
  try {
    setFlags(map)
    return await fn()
  } finally {
    restoreFlags(snapshot)
  }
}

function createMockContext() {
  const routes = []
  return {
    context: {
      api: {
        http: {
          addRoute(method, path, handler) {
            routes.push({ method, path, handler })
          },
        },
      },
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    },
    routes,
  }
}

function invokeHandler(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) {
        this.statusCode = code
        return this
      },
      json(body) {
        this.body = body
        resolve({ status: this.statusCode, body })
      },
    }
    try {
      const result = handler(req || {}, res)
      if (result && typeof result.then === 'function') {
        result.catch(reject)
      }
    } catch (error) {
      reject(error)
    }
  })
}

const PRIVILEGED_CALLER = Object.freeze({
  role: 'admin',
  permissions: Object.freeze(['elearning:admin']),
})

const UNAUTHORIZED_CALLER = Object.freeze({
  role: 'user',
  permissions: Object.freeze([]),
})

const ALL_FLAGS_ON = Object.freeze({
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
  ELEARNING_ASSESSMENT_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
  ELEARNING_ANALYTICS_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
})

function allCapabilities(value) {
  return {
    content: value,
    assignment: value,
    assessment: value,
    incentive: value,
    analytics: value,
    media: value,
  }
}

module.exports = {
  LOOKALIKES,
  PRIVILEGED_CALLER,
  UNAUTHORIZED_CALLER,
  ALL_FLAGS_ON,
  allCapabilities,
  snapshotFlags,
  restoreFlags,
  clearFlags,
  setFlags,
  withFlags,
  withFlagsAsync,
  createMockContext,
  invokeHandler,
}
