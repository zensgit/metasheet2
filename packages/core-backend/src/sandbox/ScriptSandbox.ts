// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Worker, MessageChannel } from 'worker_threads'
import { EventEmitter } from 'eventemitter3'
import path from 'path'
import crypto from 'crypto'
import fs from 'fs/promises'

export interface SandboxOptions {
  timeout?: number // Execution timeout in milliseconds
  memoryLimit?: number // Memory limit in MB
  cpuLimit?: number // CPU time limit in seconds
  allowedModules?: string[] // Whitelist of allowed modules
  blockedModules?: string[] // Blacklist of blocked modules
  env?: Record<string, string> // Environment variables
  workDir?: string // Working directory for temp files
  maxOutputSize?: number // Maximum output size in bytes
  maxExecutions?: number // Maximum number of executions
  isolateContext?: boolean // Run in isolated context
}

// Type for user-defined functions that can be injected into the sandbox
type SandboxFunction = (...args: unknown[]) => unknown

export interface ExecutionContext {
  globals?: Record<string, unknown> // Global variables available to script
  modules?: Record<string, unknown> // Pre-loaded modules
  functions?: Record<string, SandboxFunction> // Helper functions
  data?: unknown // Input data for the script
}

export interface ExecutionResult {
  success: boolean
  output?: unknown
  error?: Error | string
  logs: Array<{ level: string; message: string; timestamp: Date }>
  metrics: {
    executionTime: number // in milliseconds
    memoryUsed: number // in bytes
    cpuTime?: number // in milliseconds
  }
  warnings?: string[]
}

// Worker message types
interface WorkerLogMessage {
  type: 'log'
  level: string
  message: string
  timestamp: string | Date
}

interface WorkerResultMessage {
  type: 'result'
  output: unknown
  memoryUsed?: number
  cpuTime?: number
  warnings?: string[]
}

interface WorkerErrorMessage {
  type: 'error'
  error: string
  memoryUsed?: number
}

type WorkerMessage = WorkerLogMessage | WorkerResultMessage | WorkerErrorMessage

// TypeScript diagnostic type
interface TypeScriptDiagnostic {
  messageText: string | { messageText: string }
}

export class ScriptSandbox extends EventEmitter {
  private options: SandboxOptions
  private worker: Worker | null = null
  private executionCount: number = 0
  private workDir: string
  private scriptCache: Map<string, string> = new Map()

  constructor(options: SandboxOptions = {}) {
    super()
    this.options = {
      timeout: options.timeout || 5000,
      memoryLimit: options.memoryLimit || 128,
      cpuLimit: options.cpuLimit || 5,
      allowedModules: options.allowedModules || [],
      blockedModules: options.blockedModules || [
        'fs',
        'child_process',
        'cluster',
        'dgram',
        'dns',
        'http',
        'https',
        'net',
        'os',
        'path',
        'process',
        'stream',
        'tls',
        'tty',
        'url',
        'v8',
        'vm',
        'worker_threads'
      ],
      env: options.env || {},
      workDir: options.workDir || '/tmp/sandbox',
      maxOutputSize: options.maxOutputSize || 1024 * 1024, // 1MB
      maxExecutions: options.maxExecutions || 1000,
      isolateContext: options.isolateContext !== false
    }
    this.workDir = this.options.workDir!
  }

  async initialize(): Promise<void> {
    // Create working directory
    await fs.mkdir(this.workDir, { recursive: true })

    // Create worker script
    const workerScript = await this.createWorkerScript()
    const workerPath = path.join(this.workDir, 'worker.js')
    await fs.writeFile(workerPath, workerScript)

    this.emit('initialized', { workDir: this.workDir })
  }

  async execute(
    script: string,
    context: ExecutionContext = {},
    language: 'javascript' | 'typescript' | 'python' = 'javascript'
  ): Promise<ExecutionResult> {
    if (this.executionCount >= (this.options.maxExecutions || 1000)) {
      throw new Error('Maximum execution limit reached')
    }

    this.executionCount++
    const executionId = crypto.randomBytes(16).toString('hex')

    this.emit('execution:start', { id: executionId, language })

    try {
      switch (language) {
        case 'javascript':
        case 'typescript':
          return await this.executeJavaScript(script, context, executionId)
        case 'python':
          return await this.executePython(script, context, executionId)
        default:
          throw new Error(`Unsupported language: ${language}`)
      }
    } catch (error) {
      this.emit('execution:error', { id: executionId, error })
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        logs: [],
        metrics: {
          executionTime: 0,
          memoryUsed: 0
        }
      }
    } finally {
      this.emit('execution:end', { id: executionId })
    }
  }

  private async executeJavaScript(
    script: string,
    context: ExecutionContext,
    _executionId: string
  ): Promise<ExecutionResult> {
    const startTime = Date.now()
    const logs: Array<{ level: string; message: string; timestamp: Date }> = []

    return new Promise((resolve) => {
      // Create worker for isolation using inline code
      const worker = new Worker(this.getWorkerCode(), {
        eval: true,
        resourceLimits: {
          maxOldGenerationSizeMb: this.options.memoryLimit,
          maxYoungGenerationSizeMb: Math.floor((this.options.memoryLimit || 128) / 2),
          codeRangeSizeMb: Math.floor((this.options.memoryLimit || 128) / 4)
        },
        env: this.options.env
      })

      let isResolved = false
      const timeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true
          worker.terminate()
          resolve({
            success: false,
            error: 'Script execution timeout',
            logs,
            metrics: {
              executionTime: this.options.timeout || 5000,
              memoryUsed: 0
            }
          })
        }
      }, this.options.timeout)

      // Handle worker messages
      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'log') {
          logs.push({
            level: message.level,
            message: message.message,
            timestamp: new Date(message.timestamp)
          })
        } else if (message.type === 'result') {
          if (!isResolved) {
            isResolved = true
            clearTimeout(timeout)
            worker.terminate()

            const executionTime = Date.now() - startTime
            const memoryUsed = message.memoryUsed || 0

            // Check output size
            const outputSize = JSON.stringify(message.output).length
            if (outputSize > (this.options.maxOutputSize || 1024 * 1024)) {
              resolve({
                success: false,
                error: 'Output size exceeds limit',
                logs,
                metrics: { executionTime, memoryUsed }
              })
              return
            }

            resolve({
              success: true,
              output: message.output,
              logs,
              metrics: {
                executionTime,
                memoryUsed,
                cpuTime: message.cpuTime
              },
              warnings: message.warnings
            })
          }
        } else if (message.type === 'error') {
          if (!isResolved) {
            isResolved = true
            clearTimeout(timeout)
            worker.terminate()

            resolve({
              success: false,
              error: message.error,
              logs,
              metrics: {
                executionTime: Date.now() - startTime,
                memoryUsed: message.memoryUsed || 0
              }
            })
          }
        }
      })

      // Handle worker errors
      worker.on('error', (error) => {
        if (!isResolved) {
          isResolved = true
          clearTimeout(timeout)
          worker.terminate()

          resolve({
            success: false,
            error: error.message,
            logs,
            metrics: {
              executionTime: Date.now() - startTime,
              memoryUsed: 0
            }
          })
        }
      })

      // Send execution request to worker
      worker.postMessage({
        type: 'execute',
        script,
        context,
        options: {
          allowedModules: this.options.allowedModules,
          blockedModules: this.options.blockedModules
        }
      })
    })
  }

  private async executePython(
    script: string,
    context: ExecutionContext,
    executionId: string
  ): Promise<ExecutionResult> {
    // Python execution would require spawning a Python subprocess
    // This is a simplified implementation
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { spawn } = require('child_process')
    const startTime = Date.now()
    const logs: Array<{ level: string; message: string; timestamp: Date }> = []

    return new Promise((resolve) => {
      // Write script to temporary file
      const scriptPath = path.join(this.workDir, `${executionId}.py`)
      fs.writeFile(scriptPath, this.wrapPythonScript(script, context))
        .then(() => {
          const pythonProcess = spawn('python3', [scriptPath], {
            env: { ...process.env, ...this.options.env },
            timeout: this.options.timeout
          })

          let stdout = ''
          let stderr = ''

          pythonProcess.stdout.on('data', (data: Buffer) => {
            stdout += data.toString()
          })

          pythonProcess.stderr.on('data', (data: Buffer) => {
            stderr += data.toString()
          })

          pythonProcess.on('close', async (code: number) => {
            // Clean up temp file
            await fs.unlink(scriptPath).catch(() => {})

            if (code === 0) {
              try {
                const output = JSON.parse(stdout) as { result: unknown; logs?: Array<{ level: string; message: string; timestamp: Date }> }
                resolve({
                  success: true,
                  output: output.result,
                  logs: output.logs || [],
                  metrics: {
                    executionTime: Date.now() - startTime,
                    memoryUsed: 0
                  }
                })
              } catch (e) {
                resolve({
                  success: false,
                  error: 'Failed to parse output',
                  logs,
                  metrics: {
                    executionTime: Date.now() - startTime,
                    memoryUsed: 0
                  }
                })
              }
            } else {
              resolve({
                success: false,
                error: stderr || `Process exited with code ${code}`,
                logs,
                metrics: {
                  executionTime: Date.now() - startTime,
                  memoryUsed: 0
                }
              })
            }
          })

          pythonProcess.on('error', (error: Error) => {
            resolve({
              success: false,
              error: error.message,
              logs,
              metrics: {
                executionTime: Date.now() - startTime,
                memoryUsed: 0
              }
            })
          })
        })
        .catch((error) => {
          resolve({
            success: false,
            error: error.message,
            logs,
            metrics: {
              executionTime: Date.now() - startTime,
              memoryUsed: 0
            }
          })
        })
    })
  }

  private getWorkerCode(): string {
    return `
      const { parentPort } = require('worker_threads');
      const vm = require('vm');

      // Custom console for logging
      const customConsole = {
        log: (...args) => {
          parentPort.postMessage({
            type: 'log',
            level: 'info',
            message: args.map(arg => String(arg)).join(' '),
            timestamp: new Date()
          });
        },
        error: (...args) => {
          parentPort.postMessage({
            type: 'log',
            level: 'error',
            message: args.map(arg => String(arg)).join(' '),
            timestamp: new Date()
          });
        },
        warn: (...args) => {
          parentPort.postMessage({
            type: 'log',
            level: 'warn',
            message: args.map(arg => String(arg)).join(' '),
            timestamp: new Date()
          });
        },
        info: (...args) => {
          parentPort.postMessage({
            type: 'log',
            level: 'info',
            message: args.map(arg => String(arg)).join(' '),
            timestamp: new Date()
          });
        }
      };

      parentPort.on('message', async (message) => {
        if (message.type === 'execute') {
          const { script, context, options } = message;
          const startCpuUsage = process.cpuUsage();
          const startMemory = process.memoryUsage();

          try {
            // Create sandbox context
            const sandbox = {
              console: customConsole,
              setTimeout,
              setInterval,
              clearTimeout,
              clearInterval,
              Promise,
              Date,
              Math,
              JSON,
              Array,
              Object,
              String,
              Number,
              Boolean,
              RegExp,
              Error,
              ...context.globals
            };

            // Add allowed modules
            if (options.allowedModules) {
              for (const moduleName of options.allowedModules) {
                if (!options.blockedModules.includes(moduleName)) {
                  try {
                    sandbox[moduleName] = require(moduleName);
                  } catch (e) {
                    // Module not available
                  }
                }
              }
            }

            // Add context data
            if (context.data !== undefined) {
              sandbox.data = context.data;
            }

            // Add custom functions
            if (context.functions) {
              for (const [name, fn] of Object.entries(context.functions)) {
                sandbox[name] = fn;
              }
            }

            // Create VM context
            const vmContext = vm.createContext(sandbox);

            // Wrap script to capture return value
            const wrappedScript = \`
              (async function() {
                \${script}
              })()
            \`;

            // Execute script
            const result = await vm.runInContext(wrappedScript, vmContext, {
              timeout: options.timeout || 5000,
              breakOnSigint: true
            });

            const endCpuUsage = process.cpuUsage(startCpuUsage);
            const endMemory = process.memoryUsage();

            parentPort.postMessage({
              type: 'result',
              output: result,
              memoryUsed: endMemory.heapUsed - startMemory.heapUsed,
              cpuTime: (endCpuUsage.user + endCpuUsage.system) / 1000,
              warnings: []
            });
          } catch (error) {
            const endMemory = process.memoryUsage();

            parentPort.postMessage({
              type: 'error',
              error: error.message || String(error),
              memoryUsed: endMemory.heapUsed - startMemory.heapUsed
            });
          }
        }
      });
    `
  }

  private wrapPythonScript(script: string, context: ExecutionContext): string {
    const contextJson = JSON.stringify(context.data || {})

    return `
import json
import sys
import traceback

# Logging functions
logs = []

def log(level, *args):
    message = ' '.join(str(arg) for arg in args)
    logs.append({
        'level': level,
        'message': message,
        'timestamp': None
    })

class Console:
    @staticmethod
    def log(*args):
        log('info', *args)

    @staticmethod
    def error(*args):
        log('error', *args)

    @staticmethod
    def warn(*args):
        log('warn', *args)

    @staticmethod
    def info(*args):
        log('info', *args)

console = Console()

# Load context data
data = json.loads('${contextJson.replace(/'/g, "\\'")}')

# User script
try:
    result = None
    ${script.split('\n').map(line => '    ' + line).join('\n')}

    # Output result
    output = {
        'result': result,
        'logs': logs
    }
    print(json.dumps(output))
except Exception as e:
    error_output = {
        'error': str(e),
        'trace': traceback.format_exc(),
        'logs': logs
    }
    print(json.dumps(error_output), file=sys.stderr)
    sys.exit(1)
`
  }

  async validateScript(
    script: string,
    language: 'javascript' | 'typescript' | 'python' = 'javascript'
  ): Promise<{ valid: boolean; errors?: string[] }> {
    try {
      switch (language) {
        case 'javascript': {
          // Use a parser to validate syntax
          // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
          const acorn = require('acorn')
          acorn.parse(script, { ecmaVersion: 2020 })
          return { valid: true }
        }

        case 'typescript': {
          // Would require TypeScript compiler
          // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
          const ts = require('typescript')
          const result = ts.transpileModule(script, {
            compilerOptions: { module: ts.ModuleKind.CommonJS }
          }) as { diagnostics?: TypeScriptDiagnostic[] }
          if (result.diagnostics && result.diagnostics.length > 0) {
            return {
              valid: false,
              errors: result.diagnostics.map((d: TypeScriptDiagnostic) => {
                const messageText = d.messageText
                return typeof messageText === 'string' ? messageText : messageText.messageText
              })
            }
          }
          return { valid: true }
        }

        case 'python': {
          // Use Python's ast module via subprocess
          // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
          const { spawn } = require('child_process')
          return new Promise((resolve) => {
            const pythonProcess = spawn('python3', [
              '-c',
              `import ast; import sys; ast.parse(sys.stdin.read())`
            ])

            pythonProcess.stdin.write(script)
            pythonProcess.stdin.end()

            pythonProcess.on('close', (code: number) => {
              if (code === 0) {
                resolve({ valid: true })
              } else {
                resolve({ valid: false, errors: ['Syntax error in Python script'] })
              }
            })

            pythonProcess.on('error', () => {
              resolve({ valid: false, errors: ['Failed to validate Python script'] })
            })
          })
        }

        default:
          return { valid: false, errors: [`Unsupported language: ${language}`] }
      }
    } catch (error) {
      return {
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)]
      }
    }
  }

  async cleanup(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate()
      this.worker = null
    }

    // Clean up work directory
    try {
      await fs.rm(this.workDir, { recursive: true, force: true })
    } catch (error) {
      this.emit('cleanup:error', error)
    }

    this.scriptCache.clear()
    this.emit('cleanup:complete')
  }

  getMetrics(): {
    executionCount: number
    cacheSize: number
    uptime: number
  } {
    return {
      executionCount: this.executionCount,
      cacheSize: this.scriptCache.size,
      uptime: process.uptime()
    }
  }

  private async createWorkerScript(): Promise<string> {
    return this.getWorkerCode()
  }
}
