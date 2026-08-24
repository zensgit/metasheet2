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

function snapshotFlags() {
  const snapshot = {}
  for (const name of FLAG_NAMES) {
    snapshot[name] = Object.prototype.hasOwnProperty.call(process.env, name)
      ? process.env[name]
      : undefined
  }
  return snapshot
}

function restoreFlags(snapshot) {
  for (const name of FLAG_NAMES) {
    if (snapshot[name] === undefined) delete process.env[name]
    else process.env[name] = snapshot[name]
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
  const snapshot = snapshotFlags()
  try {
    setFlags(map)
    return fn()
  } finally {
    restoreFlags(snapshot)
  }
}

async function withFlagsAsync(map, fn) {
  const snapshot = snapshotFlags()
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

module.exports = {
  LOOKALIKES,
  snapshotFlags,
  restoreFlags,
  clearFlags,
  setFlags,
  withFlags,
  withFlagsAsync,
  createMockContext,
  invokeHandler,
}
