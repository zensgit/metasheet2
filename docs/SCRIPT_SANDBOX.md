# Script Execution Sandbox

## Overview

The Script Execution Sandbox provides a secure, isolated environment for running user-provided scripts in JavaScript, TypeScript, and Python. It implements multiple layers of security to prevent malicious code execution while providing useful functionality for automation and data processing.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  SandboxManager                       │
│  - Manages sandbox pools and execution jobs          │
│  - Handles async/sync execution                      │
│  - Tracks metrics and performance                    │
└─────────────────────┬───────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
┌───────▼──────┐ ┌───▼──────┐ ┌───▼──────┐
│   Sandbox    │ │ Security │ │   Safe    │
│   Pool 1     │ │  Policy  │ │ Functions │
└──────────────┘ └──────────┘ └───────────┘
        │             │             │
┌───────▼──────┐ ┌───▼──────┐ ┌───▼──────┐
│  JavaScript  │ │  Python  │ │TypeScript │
│    Worker    │ │ Subprocess│ │  Worker   │
└──────────────┘ └──────────┘ └───────────┘
```

## Core Components

### 1. ScriptSandbox

The main execution environment that:
- Runs scripts in isolated Worker threads (JavaScript/TypeScript)
- Spawns subprocess for Python scripts
- Enforces resource limits (memory, CPU, timeout)
- Captures and filters console output
- Tracks execution metrics

### 2. SandboxManager

Central orchestration layer that:
- Manages multiple sandbox pools
- Handles job queueing and scheduling
- Provides template management
- Tracks execution history
- Collects performance metrics

### 3. SecurityPolicy

Configurable security rules including:
- Execution time limits
- Memory and CPU constraints
- Module/API whitelisting and blacklisting
- Pattern detection for dangerous code
- Risk assessment and scoring

### 4. SafeFunctions

Pre-defined safe function library:
- Math operations (sum, average, median)
- String manipulation (capitalize, truncate)
- Array operations (unique, flatten, chunk)
- Date utilities (formatDate, addDays)
- Object helpers (pick, omit, merge)
- Validation functions

## Security Features

### Multi-Layer Security

1. **Static Analysis**
   - Pattern detection for dangerous code
   - API usage validation
   - Module import restrictions
   - Syntax validation

2. **Runtime Isolation**
   - Worker thread isolation
   - Resource limits enforcement
   - Blocked system access
   - Sandboxed global scope

3. **Resource Management**
   - Memory limits (default: 128MB)
   - CPU time limits (default: 5 seconds)
   - Output size limits (default: 1MB)
   - Loop iteration limits

4. **Code Sanitization**
   - Automatic dangerous pattern removal
   - API blocking
   - Safe wrapper generation

## Usage Examples

### Basic Script Execution

```typescript
import { ScriptSandbox } from './sandbox/ScriptSandbox'

const sandbox = new ScriptSandbox({
  timeout: 5000,
  memoryLimit: 128,
  allowedModules: ['lodash']
})

await sandbox.initialize()

const result = await sandbox.execute(
  `
  const numbers = [1, 2, 3, 4, 5]
  const sum = numbers.reduce((a, b) => a + b, 0)
  return sum
  `,
  { data: { numbers: [1, 2, 3, 4, 5] } }
)

console.log(result.output) // 15
```

### Using Templates

```typescript
const manager = new SandboxManager()

// Register a template
manager.registerTemplate({
  name: 'calculate-average',
  language: 'javascript',
  code: `
    const values = {{values}}
    const sum = values.reduce((a, b) => a + b, 0)
    return sum / values.length
  `,
  parameters: [{
    name: 'values',
    type: 'array',
    required: true
  }]
})

// Execute template
const result = await manager.execute({
  templateId: 'calculate-average',
  parameters: { values: [10, 20, 30, 40] }
})

console.log(result.output) // 25
```

### Async Job Execution

```typescript
// Submit async job
const jobResult = await manager.execute({
  script: 'return heavyComputation()',
  async: true
})

const jobId = jobResult.output.jobId

// Check job status
const job = await manager.getJobStatus(jobId)
console.log(job.status) // 'running'

// Wait for completion
const finalResult = await manager.getJobResult(jobId, 30000)
```

### Python Script Execution

```typescript
const result = await sandbox.execute(
  `
  import json

  data = [1, 2, 3, 4, 5]
  result = sum(data) / len(data)
  `,
  {},
  'python'
)
```

### Using Safe Functions

```typescript
const result = await sandbox.execute(
  `
  // Safe functions are available in the context
  const emails = ['user@example.com', 'invalid-email', 'admin@test.org']
  const validEmails = emails.filter(isEmail)

  const dates = ['2024-01-01', '2024-06-15', '2024-12-31']
  const formatted = dates.map(d => formatDate(d, 'MM/DD/YYYY'))

  return { validEmails, formatted }
  `,
  {
    functions: createSafeContext()
  }
)
```

## Configuration

### Sandbox Options

```typescript
interface SandboxOptions {
  timeout?: number              // Default: 5000ms
  memoryLimit?: number          // Default: 128MB
  cpuLimit?: number            // Default: 5 seconds
  allowedModules?: string[]    // Default: []
  blockedModules?: string[]    // Default: [system modules]
  env?: Record<string, string> // Environment variables
  maxOutputSize?: number       // Default: 1MB
  maxExecutions?: number       // Default: 1000
  isolateContext?: boolean     // Default: true
}
```

### Security Policy Options

```typescript
interface SecurityPolicyOptions {
  maxExecutionTime?: number
  maxMemory?: number
  maxCPU?: number
  allowNetwork?: boolean       // Default: false
  allowFileSystem?: boolean    // Default: false
  allowChildProcess?: boolean  // Default: false
  blockedAPIs?: string[]       // Default: ['eval', 'Function', ...]
  maxLoops?: number           // Default: 10000
  maxRecursion?: number       // Default: 100
}
```

## Database Schema

The system uses several tables for persistence:

- **script_templates**: Reusable script templates
- **script_executions**: Execution history and metrics
- **sandbox_pools**: Pool configurations
- **security_policies**: Security policy definitions
- **script_validations**: Cached validation results
- **execution_jobs**: Job queue for async execution
- **sandbox_metrics**: Performance and utilization metrics

## Performance Optimization

1. **Pool Management**
   - Pre-create sandbox instances
   - Reuse sandboxes across executions
   - Automatic scaling based on load

2. **Caching**
   - Script validation caching
   - Template compilation caching
   - Result caching for deterministic scripts

3. **Resource Management**
   - Automatic garbage collection
   - Memory pressure monitoring
   - CPU throttling

## Monitoring and Metrics

Track key metrics:
- Execution count and success rate
- Average execution time
- Memory and CPU usage
- Queue length and wait times
- Policy violations
- Error rates by type

```typescript
const metrics = manager.getPoolMetrics()
console.log(metrics)
// [{
//   poolId: 'default',
//   activeInstances: 3,
//   totalInstances: 5,
//   utilization: 0.6
// }]
```

## Error Handling

The system provides detailed error information:

```typescript
const result = await sandbox.execute(script)

if (!result.success) {
  console.error('Execution failed:', result.error)
  console.log('Logs:', result.logs)
  console.log('Metrics:', result.metrics)
}
```

Error types:
- **Syntax Error**: Invalid script syntax
- **Runtime Error**: Execution failures
- **Timeout Error**: Exceeded time limit
- **Memory Error**: Exceeded memory limit
- **Policy Violation**: Security policy breach

## Best Practices

1. **Use Templates**: Define reusable templates for common operations
2. **Set Appropriate Limits**: Configure resource limits based on use case
3. **Validate Before Execute**: Use validation API to check scripts
4. **Use Safe Functions**: Leverage pre-built safe functions
5. **Monitor Metrics**: Track performance and adjust pool sizes
6. **Handle Errors**: Implement proper error handling
7. **Clean Up**: Dispose sandboxes when done

## Security Considerations

1. **Never Trust User Input**: Always validate and sanitize
2. **Use Strict Policies**: Default to restrictive policies
3. **Regular Updates**: Keep blocked patterns up to date
4. **Audit Executions**: Log and review execution history
5. **Limit Network Access**: Disable unless absolutely necessary
6. **Monitor Resource Usage**: Watch for DoS attempts

## Future Enhancements

- [ ] WebAssembly sandbox support
- [ ] Additional language support (Ruby, Go)
- [ ] Distributed execution across workers
- [ ] Advanced debugging capabilities
- [ ] Script marketplace for sharing templates
- [ ] Machine learning for risk assessment
- [ ] Real-time collaboration on scripts
- [ ] Visual script builder interface