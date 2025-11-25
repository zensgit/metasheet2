import { Worker } from 'worker_threads';
import { EventEmitter } from 'eventemitter3';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
export class ScriptSandbox extends EventEmitter {
    options;
    worker = null;
    executionCount = 0;
    workDir;
    scriptCache = new Map();
    constructor(options = {}) {
        super();
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
        };
        this.workDir = this.options.workDir;
    }
    async initialize() {
        // Create working directory
        await fs.mkdir(this.workDir, { recursive: true });
        // Create worker script
        const workerScript = await this.createWorkerScript();
        const workerPath = path.join(this.workDir, 'worker.js');
        await fs.writeFile(workerPath, workerScript);
        this.emit('initialized', { workDir: this.workDir });
    }
    async execute(script, context = {}, language = 'javascript') {
        if (this.executionCount >= (this.options.maxExecutions || 1000)) {
            throw new Error('Maximum execution limit reached');
        }
        this.executionCount++;
        const executionId = crypto.randomBytes(16).toString('hex');
        this.emit('execution:start', { id: executionId, language });
        try {
            switch (language) {
                case 'javascript':
                case 'typescript':
                    return await this.executeJavaScript(script, context, executionId);
                case 'python':
                    return await this.executePython(script, context, executionId);
                default:
                    throw new Error(`Unsupported language: ${language}`);
            }
        }
        catch (error) {
            this.emit('execution:error', { id: executionId, error });
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                logs: [],
                metrics: {
                    executionTime: 0,
                    memoryUsed: 0
                }
            };
        }
        finally {
            this.emit('execution:end', { id: executionId });
        }
    }
    async executeJavaScript(script, context, executionId) {
        const startTime = Date.now();
        const logs = [];
        return new Promise((resolve) => {
            // Create worker for isolation
            const workerPath = path.join(__dirname, 'workers', 'javascript.worker.js');
            const worker = new Worker(this.getWorkerCode(), {
                eval: true,
                resourceLimits: {
                    maxOldGenerationSizeMb: this.options.memoryLimit,
                    maxYoungGenerationSizeMb: Math.floor((this.options.memoryLimit || 128) / 2),
                    codeRangeSizeMb: Math.floor((this.options.memoryLimit || 128) / 4)
                },
                env: this.options.env
            });
            let isResolved = false;
            const timeout = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    worker.terminate();
                    resolve({
                        success: false,
                        error: 'Script execution timeout',
                        logs,
                        metrics: {
                            executionTime: this.options.timeout || 5000,
                            memoryUsed: 0
                        }
                    });
                }
            }, this.options.timeout);
            // Handle worker messages
            worker.on('message', (message) => {
                if (message.type === 'log') {
                    logs.push({
                        level: message.level,
                        message: message.message,
                        timestamp: new Date(message.timestamp)
                    });
                }
                else if (message.type === 'result') {
                    if (!isResolved) {
                        isResolved = true;
                        clearTimeout(timeout);
                        worker.terminate();
                        const executionTime = Date.now() - startTime;
                        const memoryUsed = message.memoryUsed || 0;
                        // Check output size
                        const outputSize = JSON.stringify(message.output).length;
                        if (outputSize > (this.options.maxOutputSize || 1024 * 1024)) {
                            resolve({
                                success: false,
                                error: 'Output size exceeds limit',
                                logs,
                                metrics: { executionTime, memoryUsed }
                            });
                            return;
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
                        });
                    }
                }
                else if (message.type === 'error') {
                    if (!isResolved) {
                        isResolved = true;
                        clearTimeout(timeout);
                        worker.terminate();
                        resolve({
                            success: false,
                            error: message.error,
                            logs,
                            metrics: {
                                executionTime: Date.now() - startTime,
                                memoryUsed: message.memoryUsed || 0
                            }
                        });
                    }
                }
            });
            // Handle worker errors
            worker.on('error', (error) => {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    worker.terminate();
                    resolve({
                        success: false,
                        error: error.message,
                        logs,
                        metrics: {
                            executionTime: Date.now() - startTime,
                            memoryUsed: 0
                        }
                    });
                }
            });
            // Send execution request to worker
            worker.postMessage({
                type: 'execute',
                script,
                context,
                options: {
                    allowedModules: this.options.allowedModules,
                    blockedModules: this.options.blockedModules
                }
            });
        });
    }
    async executePython(script, context, executionId) {
        // Python execution would require spawning a Python subprocess
        // This is a simplified implementation
        const { spawn } = require('child_process');
        const startTime = Date.now();
        const logs = [];
        return new Promise((resolve) => {
            // Write script to temporary file
            const scriptPath = path.join(this.workDir, `${executionId}.py`);
            fs.writeFile(scriptPath, this.wrapPythonScript(script, context))
                .then(() => {
                const pythonProcess = spawn('python3', [scriptPath], {
                    env: { ...process.env, ...this.options.env },
                    timeout: this.options.timeout
                });
                let stdout = '';
                let stderr = '';
                pythonProcess.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
                pythonProcess.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                pythonProcess.on('close', async (code) => {
                    // Clean up temp file
                    await fs.unlink(scriptPath).catch(() => { });
                    if (code === 0) {
                        try {
                            const output = JSON.parse(stdout);
                            resolve({
                                success: true,
                                output: output.result,
                                logs: output.logs || [],
                                metrics: {
                                    executionTime: Date.now() - startTime,
                                    memoryUsed: 0
                                }
                            });
                        }
                        catch (e) {
                            resolve({
                                success: false,
                                error: 'Failed to parse output',
                                logs,
                                metrics: {
                                    executionTime: Date.now() - startTime,
                                    memoryUsed: 0
                                }
                            });
                        }
                    }
                    else {
                        resolve({
                            success: false,
                            error: stderr || `Process exited with code ${code}`,
                            logs,
                            metrics: {
                                executionTime: Date.now() - startTime,
                                memoryUsed: 0
                            }
                        });
                    }
                });
                pythonProcess.on('error', (error) => {
                    resolve({
                        success: false,
                        error: error.message,
                        logs,
                        metrics: {
                            executionTime: Date.now() - startTime,
                            memoryUsed: 0
                        }
                    });
                });
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
                });
            });
        });
    }
    getWorkerCode() {
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
    `;
    }
    wrapPythonScript(script, context) {
        const contextJson = JSON.stringify(context.data || {});
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
`;
    }
    async validateScript(script, language = 'javascript') {
        try {
            switch (language) {
                case 'javascript':
                    // Use a parser to validate syntax
                    const acorn = require('acorn');
                    acorn.parse(script, { ecmaVersion: 2020 });
                    return { valid: true };
                case 'typescript':
                    // Would require TypeScript compiler
                    const ts = require('typescript');
                    const result = ts.transpileModule(script, {
                        compilerOptions: { module: ts.ModuleKind.CommonJS }
                    });
                    if (result.diagnostics && result.diagnostics.length > 0) {
                        return {
                            valid: false,
                            errors: result.diagnostics.map((d) => d.messageText)
                        };
                    }
                    return { valid: true };
                case 'python':
                    // Use Python's ast module via subprocess
                    const { spawn } = require('child_process');
                    return new Promise((resolve) => {
                        const pythonProcess = spawn('python3', [
                            '-c',
                            `import ast; import sys; ast.parse(sys.stdin.read())`
                        ]);
                        pythonProcess.stdin.write(script);
                        pythonProcess.stdin.end();
                        pythonProcess.on('close', (code) => {
                            if (code === 0) {
                                resolve({ valid: true });
                            }
                            else {
                                resolve({ valid: false, errors: ['Syntax error in Python script'] });
                            }
                        });
                        pythonProcess.on('error', () => {
                            resolve({ valid: false, errors: ['Failed to validate Python script'] });
                        });
                    });
                default:
                    return { valid: false, errors: [`Unsupported language: ${language}`] };
            }
        }
        catch (error) {
            return {
                valid: false,
                errors: [error instanceof Error ? error.message : String(error)]
            };
        }
    }
    async cleanup() {
        if (this.worker) {
            await this.worker.terminate();
            this.worker = null;
        }
        // Clean up work directory
        try {
            await fs.rm(this.workDir, { recursive: true, force: true });
        }
        catch (error) {
            this.emit('cleanup:error', error);
        }
        this.scriptCache.clear();
        this.emit('cleanup:complete');
    }
    getMetrics() {
        return {
            executionCount: this.executionCount,
            cacheSize: this.scriptCache.size,
            uptime: process.uptime()
        };
    }
    async createWorkerScript() {
        return this.getWorkerCode();
    }
}
//# sourceMappingURL=ScriptSandbox.js.map