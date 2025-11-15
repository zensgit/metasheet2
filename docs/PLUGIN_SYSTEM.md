# Plugin System

## Overview

The MetaSheet Plugin System provides a powerful, secure, and extensible way to add custom functionality to the application. Plugins run in isolated sandboxes with controlled permissions, ensuring system security while enabling rich integrations.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  PluginLoader                         │
│  - Discovery & Loading                               │
│  - Dependency Resolution                             │
│  - Lifecycle Management                              │
└─────────────────────┬───────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
┌───────▼──────┐ ┌───▼──────┐ ┌───▼──────┐
│   Plugin     │ │  Plugin   │ │  Plugin   │
│   Sandbox    │ │ Validator │ │  Context  │
└──────────────┘ └───────────┘ └───────────┘
        │             │             │
┌───────▼──────┐ ┌───▼──────┐ ┌───▼──────┐
│    Worker    │ │   Hook    │ │    API    │
│    Thread    │ │  System   │ │  Bridge   │
└──────────────┘ └───────────┘ └───────────┘
```

## Core Components

### 1. PluginLoader
Main orchestrator that handles:
- Plugin discovery and loading
- Dependency resolution
- Lifecycle management
- Hook registration
- Hot reloading

### 2. PluginSandbox
Isolation layer that:
- Runs plugins in Worker threads
- Enforces resource limits
- Controls API access
- Manages communication

### 3. PluginValidator
Security validator that:
- Validates manifests
- Scans code for dangerous patterns
- Checks permissions
- Detects obfuscation

## Plugin Structure

```
my-plugin/
├── plugin.json      # Manifest file
├── index.js        # Main entry point
├── package.json    # NPM dependencies
├── README.md       # Documentation
├── data/           # Plugin data directory
├── storage/        # Persistent storage
└── assets/         # Static assets
    ├── styles/
    ├── scripts/
    └── images/
```

## Manifest File

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "Author Name",
  "main": "index.js",

  "permissions": {
    "apis": ["api:read", "database:read"],
    "modules": ["lodash", "moment"]
  },

  "hooks": {
    "beforeSave": {
      "handler": "onBeforeSave",
      "priority": 10
    }
  },

  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "apiKey": { "type": "string" }
      }
    }
  }
}
```

## Plugin Development

### Basic Plugin Structure

```javascript
// Lifecycle methods
async function init(context) {
  // Initialize plugin
  context.logger.info('Plugin initialized')
}

async function enable() {
  // Enable plugin functionality
}

async function disable() {
  // Disable plugin functionality
}

async function cleanup() {
  // Clean up resources
}

// Export plugin interface
module.exports = {
  init,
  enable,
  disable,
  cleanup
}
```

### Using Context API

```javascript
async function init(context) {
  // Logging
  context.logger.info('Info message')
  context.logger.error('Error message')

  // Storage
  await context.storage.set('key', { data: 'value' })
  const data = await context.storage.get('key')

  // Events
  context.events.on('data:update', handleUpdate)
  context.events.emit('custom:event', { data })

  // API calls
  const result = await context.api.callPlugin('other-plugin', 'method', args)
  const hooks = await context.api.executeHook('hookName', data)
}
```

### Implementing Hooks

```javascript
async function onBeforeSave(data) {
  // Validate data
  if (!data.valid) {
    throw new Error('Invalid data')
  }

  // Transform data
  data.timestamp = new Date()

  // Return modified data
  return data
}

async function onAfterSave(data) {
  // Perform post-save actions
  await syncWithExternalService(data)
}

module.exports = {
  onBeforeSave,
  onAfterSave
}
```

### UI Extensions

```javascript
// Register UI components in manifest
{
  "ui": {
    "panels": [{
      "id": "my-panel",
      "title": "My Panel",
      "component": "MyPanel",
      "position": "right"
    }],
    "menuItems": [{
      "id": "my-action",
      "label": "My Action",
      "action": "executeAction"
    }]
  }
}

// Implement action handlers
async function executeAction(params) {
  // Handle menu action
  return { success: true }
}
```

## Security Model

### Permission System

Permissions control what plugins can access:

- **api:read/write**: API access levels
- **database:read/write**: Database operations
- **file:read/write**: File system access
- **network:http**: HTTP requests
- **system:info**: System information
- **plugin:communicate**: Inter-plugin communication

### Sandbox Modes

1. **Strict Mode**: Maximum isolation
   - No file system access
   - No network access
   - Limited API access
   - Restricted modules

2. **Moderate Mode**: Balanced security
   - Controlled file access
   - Whitelisted network domains
   - Extended API access
   - Common modules allowed

3. **Permissive Mode**: Maximum flexibility
   - Full API access
   - Network access
   - Most modules allowed
   - System information access

### Code Validation

The validator checks for:
- Dangerous patterns (eval, Function constructor)
- Unauthorized module usage
- Code obfuscation
- Resource exhaustion attempts
- Prototype pollution

## Hook System

### Available Hooks

```javascript
// Data hooks
beforeSave(data)      // Before data save
afterSave(data)       // After data save
beforeDelete(id)      // Before deletion
afterDelete(id)       // After deletion

// Workflow hooks
workflowStart(instance)    // Workflow started
workflowComplete(instance) // Workflow completed
taskExecute(task)         // Task execution

// System hooks
startup()             // System startup
shutdown()            // System shutdown
configChange(config)  // Configuration change

// UI hooks
pageLoad(page)        // Page loaded
actionExecute(action) // Action executed
```

### Hook Priority

Hooks execute in priority order:
```javascript
{
  "hooks": {
    "beforeSave": {
      "handler": "myHandler",
      "priority": 100  // Higher = earlier execution
    }
  }
}
```

## Communication

### Inter-Plugin Communication

```javascript
// Call another plugin
const result = await context.api.callPlugin(
  'target-plugin',
  'methodName',
  arg1, arg2
)

// Get plugin info
const plugin = context.api.getPlugin('target-plugin')
if (plugin && plugin.status === 'active') {
  // Plugin is available
}
```

### Event System

```javascript
// Listen to events
context.events.on('data:updated', (data) => {
  console.log('Data updated:', data)
})

// Emit events
context.events.emit('custom:event', {
  type: 'info',
  data: { ... }
})

// One-time listener
context.events.once('startup', initialize)
```

## Storage

### Persistent Storage

```javascript
// Save data
await context.storage.set('config', {
  apiKey: 'xxx',
  enabled: true
})

// Load data
const config = await context.storage.get('config')

// Delete data
await context.storage.delete('config')

// List keys
const keys = await context.storage.list()
```

### Temporary Cache

```javascript
// Use Map for in-memory cache
const cache = new Map()

function cacheData(key, value) {
  cache.set(key, {
    value,
    timestamp: Date.now()
  })
}

function getCached(key, maxAge = 60000) {
  const item = cache.get(key)
  if (item && Date.now() - item.timestamp < maxAge) {
    return item.value
  }
  return null
}
```

## Configuration

### Schema Definition

```json
{
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "apiKey": {
          "type": "string",
          "description": "API Key"
        },
        "maxRetries": {
          "type": "number",
          "minimum": 1,
          "maximum": 10,
          "default": 3
        },
        "features": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": ["feature1", "feature2"]
          }
        }
      },
      "required": ["apiKey"]
    }
  }
}
```

### Accessing Configuration

```javascript
async function init(context) {
  // Load configuration
  const config = await context.storage.get('config')

  // Listen for changes
  context.events.on('config:changed', (newConfig) => {
    // Handle configuration change
    applyConfig(newConfig)
  })
}
```

## Hot Reload

Enable hot reload in manifest:
```json
{
  "hotReload": true
}
```

Handle reload gracefully:
```javascript
async function cleanup() {
  // Save state before reload
  await context.storage.set('state', currentState)
}

async function init(context) {
  // Restore state after reload
  const state = await context.storage.get('state')
  if (state) {
    restoreState(state)
  }
}
```

## Best Practices

1. **Error Handling**: Always handle errors gracefully
2. **Resource Cleanup**: Clean up resources in cleanup()
3. **Performance**: Avoid blocking operations
4. **Security**: Never expose sensitive data
5. **Logging**: Use appropriate log levels
6. **Documentation**: Document your plugin thoroughly
7. **Testing**: Test in different sandbox modes
8. **Versioning**: Follow semantic versioning

## Debugging

### Enable Debug Mode

```javascript
const DEBUG = process.env.PLUGIN_DEBUG === 'true'

function debug(...args) {
  if (DEBUG) {
    console.log('[DEBUG]', ...args)
  }
}
```

### Using Logger

```javascript
context.logger.debug('Debug info', { data })
context.logger.info('Operation completed')
context.logger.warn('Warning message')
context.logger.error('Error occurred', error)
```

### Performance Monitoring

```javascript
function measurePerformance(fn, name) {
  return async (...args) => {
    const start = Date.now()
    try {
      const result = await fn(...args)
      const duration = Date.now() - start
      context.logger.info(`${name} took ${duration}ms`)
      return result
    } catch (error) {
      const duration = Date.now() - start
      context.logger.error(`${name} failed after ${duration}ms`, error)
      throw error
    }
  }
}
```

## Publishing

### Package Structure
```
dist/
├── plugin.json
├── index.js
├── README.md
├── LICENSE
└── package.json
```

### Metadata
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Plugin description",
  "keywords": ["metasheet", "plugin"],
  "author": "Your Name",
  "license": "MIT",
  "repository": "https://github.com/user/plugin"
}
```

## Examples

See the `plugins/example-plugin` directory for a complete working example.