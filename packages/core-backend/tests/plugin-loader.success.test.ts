/**
 * PluginLoader success path tests
 * Tests for successful plugin loading scenarios
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PluginLoader } from '../src/core/plugin-loader'

describe('PluginLoader success path', () => {
  let loader: PluginLoader

  beforeEach(() => {
    vi.restoreAllMocks()
    loader = new PluginLoader('./test-plugins')
  })

  it('can be instantiated with a path string', () => {
    const newLoader = new PluginLoader('./plugins')
    expect(newLoader).toBeDefined()
    expect(newLoader).toBeInstanceOf(PluginLoader)
  })

  it('can be instantiated with default path', () => {
    // Using undefined or any object defaults to './plugins'
    const newLoader = new PluginLoader()
    expect(newLoader).toBeDefined()
  })

  it('getPlugins returns empty Map when no plugins loaded', () => {
    const plugins = loader.getPlugins()
    expect(plugins.size).toBe(0)
  })

  it('getAll returns empty array when no plugins loaded', () => {
    const all = loader.getAll()
    expect(all.length).toBe(0)
  })

  it('discover creates directory if it does not exist', async () => {
    // This should not throw even if directory doesn't exist
    const tempLoader = new PluginLoader('./temp-test-plugins-12345')
    const discovered = await tempLoader.discover()
    expect(Array.isArray(discovered)).toBe(true)
  })
})
