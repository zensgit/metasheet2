export class SecurityPolicy {
    options;
    dangerousPatterns;
    suspiciousPatterns;
    constructor(options = {}) {
        this.options = {
            maxExecutionTime: options.maxExecutionTime || 5000,
            maxMemory: options.maxMemory || 128,
            maxCPU: options.maxCPU || 5,
            maxOutputSize: options.maxOutputSize || 1024 * 1024, // 1MB
            allowNetwork: options.allowNetwork || false,
            allowFileSystem: options.allowFileSystem || false,
            allowChildProcess: options.allowChildProcess || false,
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
                'process',
                'vm',
                'worker_threads',
                'crypto'
            ],
            allowedAPIs: options.allowedAPIs || [],
            blockedAPIs: options.blockedAPIs || [
                'eval',
                'Function',
                'AsyncFunction',
                'GeneratorFunction',
                'AsyncGeneratorFunction',
                'require',
                'import',
                '__proto__',
                'constructor'
            ],
            allowedDomains: options.allowedDomains || [],
            blockedDomains: options.blockedDomains || [],
            maxLoops: options.maxLoops || 10000,
            maxRecursion: options.maxRecursion || 100,
            maxArraySize: options.maxArraySize || 10000,
            maxStringLength: options.maxStringLength || 100000
        };
        this.dangerousPatterns = this.initializeDangerousPatterns();
        this.suspiciousPatterns = this.initializeSuspiciousPatterns();
    }
    initializeDangerousPatterns() {
        return [
            // Direct eval usage
            /\beval\s*\(/,
            /new\s+Function\s*\(/,
            // Dynamic code execution
            /setTimeout\s*\([^,]+,\s*0\s*\)/, // Immediate timeout execution
            /setInterval\s*\([^,]+,/, // Interval execution
            // Prototype pollution attempts
            /__proto__/,
            /\.constructor\s*\[/,
            /\.constructor\s*\(/,
            /Object\s*\.\s*setPrototypeOf/,
            /Object\s*\.\s*defineProperty/,
            // Process and system access
            /process\s*\.\s*(exit|kill|abort)/,
            /process\s*\.\s*env/,
            /process\s*\.\s*argv/,
            /require\s*\(\s*['"`]child_process/,
            /require\s*\(\s*['"`]fs/,
            // Network access (if not allowed)
            ...(this.options.allowNetwork ? [] : [
                /require\s*\(\s*['"`](http|https|net|dgram)/,
                /fetch\s*\(/,
                /XMLHttpRequest/,
                /WebSocket/
            ]),
            // File system access (if not allowed)
            ...(this.options.allowFileSystem ? [] : [
                /require\s*\(\s*['"`]fs/,
                /require\s*\(\s*['"`]path/,
                /readFile/,
                /writeFile/,
                /appendFile/,
                /unlink/,
                /mkdir/,
                /rmdir/
            ])
        ];
    }
    initializeSuspiciousPatterns() {
        return [
            // Infinite loops
            /while\s*\(\s*true\s*\)/,
            /while\s*\(\s*1\s*\)/,
            /for\s*\(\s*;\s*;\s*\)/,
            // Large data structures
            /new\s+Array\s*\(\s*\d{6,}\s*\)/, // Arrays with more than 100k elements
            /\.repeat\s*\(\s*\d{5,}\s*\)/, // String repeat more than 10k times
            // Regular expression DoS
            /\(\?\<[!=].*\)/, // Lookbehind assertions
            /\(\?\=[^)]*\+\)/, // Complex lookaheads
            // Obfuscation attempts
            /String\s*\.\s*fromCharCode/,
            /atob\s*\(/,
            /btoa\s*\(/,
            /\\x[0-9a-f]{2}/i, // Hex escapes
            /\\u[0-9a-f]{4}/i, // Unicode escapes
            // Timing attacks
            /Date\s*\.\s*now\s*\(\)/,
            /performance\s*\.\s*now\s*\(\)/,
            // Memory exhaustion
            /JSON\s*\.\s*stringify\s*\([^,)]*,\s*null\s*,\s*\d{4,}\s*\)/ // Deep indentation
        ];
    }
    async validate(script, language = 'javascript') {
        const reasons = [];
        const warnings = [];
        let risk = 'low';
        // Check for dangerous patterns
        for (const pattern of this.dangerousPatterns) {
            if (pattern.test(script)) {
                reasons.push(`Dangerous pattern detected: ${pattern.source}`);
                risk = 'high';
            }
        }
        // Check for suspicious patterns
        for (const pattern of this.suspiciousPatterns) {
            if (pattern.test(script)) {
                warnings.push(`Suspicious pattern detected: ${pattern.source}`);
                if (risk === 'low')
                    risk = 'medium';
            }
        }
        // Check for blocked APIs
        for (const api of this.options.blockedAPIs || []) {
            const apiPattern = new RegExp(`\\b${api}\\b`);
            if (apiPattern.test(script)) {
                reasons.push(`Blocked API usage: ${api}`);
                risk = 'high';
            }
        }
        // Check for blocked modules
        if (language === 'javascript' || language === 'typescript') {
            const requirePattern = /require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
            const importPattern = /import\s+.*\s+from\s+['"`]([^'"`]+)['"`]/g;
            let match;
            while ((match = requirePattern.exec(script)) !== null) {
                const moduleName = match[1];
                if (this.options.blockedModules?.includes(moduleName)) {
                    reasons.push(`Blocked module import: ${moduleName}`);
                    risk = 'high';
                }
            }
            while ((match = importPattern.exec(script)) !== null) {
                const moduleName = match[1];
                if (this.options.blockedModules?.includes(moduleName)) {
                    reasons.push(`Blocked module import: ${moduleName}`);
                    risk = 'high';
                }
            }
        }
        // Check for Python-specific patterns
        if (language === 'python') {
            const pythonDangerousPatterns = [
                /\bexec\s*\(/,
                /\beval\s*\(/,
                /\b__import__\s*\(/,
                /\bcompile\s*\(/,
                /\bopen\s*\(/,
                /\bsubprocess\b/,
                /\bos\s*\.\s*system/,
                /\bos\s*\.\s*popen/
            ];
            for (const pattern of pythonDangerousPatterns) {
                if (pattern.test(script)) {
                    reasons.push(`Dangerous Python pattern: ${pattern.source}`);
                    risk = 'high';
                }
            }
        }
        // Check script length (potential DoS)
        if (script.length > 100000) {
            warnings.push('Script is very large');
            if (risk === 'low')
                risk = 'medium';
        }
        // Check for nested loops (potential performance issue)
        const nestedLoopPattern = /(for|while)\s*\([^)]*\)\s*{[^}]*(for|while)/;
        if (nestedLoopPattern.test(script)) {
            warnings.push('Nested loops detected');
            if (risk === 'low')
                risk = 'medium';
        }
        // Check for excessive function calls
        const functionCallPattern = /\w+\s*\(/g;
        const functionCalls = script.match(functionCallPattern);
        if (functionCalls && functionCalls.length > 1000) {
            warnings.push('Excessive function calls detected');
            if (risk === 'low')
                risk = 'medium';
        }
        return {
            allowed: reasons.length === 0,
            reasons,
            warnings: warnings.length > 0 ? warnings : undefined,
            risk
        };
    }
    checkCompliance(metrics) {
        const violations = [];
        if (metrics.executionTime > (this.options.maxExecutionTime || 5000)) {
            violations.push(`Execution time exceeded: ${metrics.executionTime}ms`);
        }
        if (metrics.memoryUsed > (this.options.maxMemory || 128) * 1024 * 1024) {
            violations.push(`Memory limit exceeded: ${metrics.memoryUsed} bytes`);
        }
        if (metrics.cpuTime && metrics.cpuTime > (this.options.maxCPU || 5) * 1000) {
            violations.push(`CPU time exceeded: ${metrics.cpuTime}ms`);
        }
        if (metrics.outputSize && metrics.outputSize > (this.options.maxOutputSize || 1024 * 1024)) {
            violations.push(`Output size exceeded: ${metrics.outputSize} bytes`);
        }
        return {
            compliant: violations.length === 0,
            violations
        };
    }
    sanitizeCode(script) {
        let sanitized = script;
        // Remove dangerous patterns
        for (const pattern of this.dangerousPatterns) {
            sanitized = sanitized.replace(pattern, '/* BLOCKED */');
        }
        // Remove blocked APIs
        for (const api of this.options.blockedAPIs || []) {
            const apiPattern = new RegExp(`\\b${api}\\b`, 'g');
            sanitized = sanitized.replace(apiPattern, '/* BLOCKED_API */');
        }
        return sanitized;
    }
    generateSafeWrapper(script, language = 'javascript') {
        if (language === 'javascript') {
            return `
        // Safe execution wrapper
        (function() {
          'use strict';

          // Block dangerous globals
          const eval = undefined;
          const Function = undefined;
          const require = undefined;

          // Limit loop iterations
          let loopCounter = 0;
          const maxLoops = ${this.options.maxLoops || 10000};

          function checkLoop() {
            if (++loopCounter > maxLoops) {
              throw new Error('Loop limit exceeded');
            }
          }

          // Limit recursion depth
          let recursionDepth = 0;
          const maxRecursion = ${this.options.maxRecursion || 100};

          function enterFunction() {
            if (++recursionDepth > maxRecursion) {
              throw new Error('Recursion limit exceeded');
            }
          }

          function exitFunction() {
            recursionDepth--;
          }

          // User script
          ${script}
        })();
      `;
        }
        else if (language === 'python') {
            return `
# Safe execution wrapper
import sys
import resource

# Set resource limits
resource.setrlimit(resource.RLIMIT_CPU, (${this.options.maxCPU || 5}, ${this.options.maxCPU || 5}))
resource.setrlimit(resource.RLIMIT_AS, (${(this.options.maxMemory || 128) * 1024 * 1024}, ${(this.options.maxMemory || 128) * 1024 * 1024}))

# Block dangerous functions
__builtins__['eval'] = None
__builtins__['exec'] = None
__builtins__['compile'] = None
__builtins__['__import__'] = None

# Loop counter
loop_counter = 0
max_loops = ${this.options.maxLoops || 10000}

def check_loop():
    global loop_counter
    loop_counter += 1
    if loop_counter > max_loops:
        raise RuntimeError('Loop limit exceeded')

# User script
${script}
      `;
        }
        return script;
    }
    getOptions() {
        return { ...this.options };
    }
    updateOptions(updates) {
        this.options = { ...this.options, ...updates };
        this.dangerousPatterns = this.initializeDangerousPatterns();
        this.suspiciousPatterns = this.initializeSuspiciousPatterns();
    }
    clone() {
        return new SecurityPolicy(this.options);
    }
}
//# sourceMappingURL=SecurityPolicy.js.map