'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const PLUGIN_DIR = path.join(__dirname, '..')
const pluginManifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'))
const appManifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'app.manifest.json'), 'utf8'))
const entry = require('../index.cjs')

assert.equal(pluginManifest.manifestVersion, '2.0.0')
assert.equal(pluginManifest.name, 'plugin-elearning')
assert.match(pluginManifest.version, /^\d+\.\d+\.\d+/)
assert.equal(pluginManifest.displayName, '学习中心')
assert.equal(typeof pluginManifest.description, 'string')
assert.equal(pluginManifest.author.name, 'MetaSheet')
assert.equal(pluginManifest.engine.metasheet, '>=2.0.0-0')
assert.equal(pluginManifest.main, 'index.cjs')
assert.ok(fs.existsSync(path.join(PLUGIN_DIR, pluginManifest.main)))
assert.ok(Array.isArray(pluginManifest.capabilities.views))
assert.ok(Array.isArray(pluginManifest.capabilities.workflows))
assert.ok(Array.isArray(pluginManifest.capabilities.functions))
assert.ok(Array.isArray(pluginManifest.permissions))
assert.deepEqual(pluginManifest.permissions, [
  'http.addRoute',
  'database.read',
  'database.write',
])
assert.equal(pluginManifest.permissions.length, 3)

assert.deepEqual(pluginManifest.contributes.views, [])
assert.ok(Array.isArray(pluginManifest.contributes.views))

assert.equal(appManifest.id, 'elearning')
assert.equal(appManifest.pluginId, 'plugin-elearning')
assert.equal(appManifest.displayName, '学习中心')
assert.equal(appManifest.runtimeModel, 'direct')
assert.equal(appManifest.boundedContext.code, 'elearning')
assert.deepEqual(appManifest.featureFlags, ['elearning'])
assert.equal(appManifest.featureFlags.length, 1)
assert.deepEqual(appManifest.permissions, [
  'elearning:read',
  'elearning:write',
  'elearning:grade',
  'elearning:stats',
  'elearning:admin',
])
assert.deepEqual(appManifest.objects, [])
assert.deepEqual(appManifest.workflows, [])
assert.deepEqual(appManifest.integrations, [])
assert.deepEqual(appManifest.navigation, [
  {
    id: 'elearning-learner',
    title: '学习中心',
    path: '/learn',
    icon: 'book',
    order: 70,
    location: 'main-nav',
  },
  {
    id: 'elearning-admin',
    title: '云课堂管理',
    path: '/admin/elearning',
    icon: 'settings',
    order: 10,
    location: 'admin',
  },
])

assert.equal(typeof entry.activate, 'function')
assert.equal(typeof entry.deactivate, 'function')

const serialized = `${JSON.stringify(pluginManifest)}\n${JSON.stringify(appManifest)}`
assert.equal(serialized.includes('elearning_course'), false)
assert.equal(serialized.includes('ELEARNING_TASKS'), false)
assert.equal(serialized.includes('ELEARNING_STATS'), false)

console.log('✓ manifest: dual-list plugin.json + app.manifest.json')
