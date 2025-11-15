"use strict";
/**
 * Formula Calculation Engine
 * Handles formula parsing, dependency resolution, and calculation
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formulaEngine = exports.FormulaEngine = void 0;
const db_1 = require("../db/db");
const logger_1 = require("../core/logger");
const logger = new logger_1.Logger('FormulaEngine');
class FormulaEngine {
    functions = new Map();
    calculationOrder = [];
    dependencyGraph = new Map();
    constructor() {
        this.registerBuiltinFunctions();
    }
    /**
     * Register built-in spreadsheet functions
     */
    registerBuiltinFunctions() {
        // Math functions
        this.functions.set('SUM', this.sum.bind(this));
        this.functions.set('AVERAGE', this.average.bind(this));
        this.functions.set('COUNT', this.count.bind(this));
        this.functions.set('MAX', this.max.bind(this));
        this.functions.set('MIN', this.min.bind(this));
        this.functions.set('ABS', (x) => Math.abs(x));
        this.functions.set('ROUND', (x, digits = 0) => Math.round(x * Math.pow(10, digits)) / Math.pow(10, digits));
        this.functions.set('CEILING', Math.ceil);
        this.functions.set('FLOOR', Math.floor);
        this.functions.set('POWER', Math.pow);
        this.functions.set('SQRT', Math.sqrt);
        this.functions.set('MOD', (a, b) => a % b);
        // Text functions
        this.functions.set('CONCATENATE', this.concatenate.bind(this));
        this.functions.set('LEFT', (text, chars) => text.substring(0, chars));
        this.functions.set('RIGHT', (text, chars) => text.substring(text.length - chars));
        this.functions.set('MID', (text, start, length) => text.substring(start - 1, start - 1 + length));
        this.functions.set('LEN', (text) => text.length);
        this.functions.set('UPPER', (text) => text.toUpperCase());
        this.functions.set('LOWER', (text) => text.toLowerCase());
        this.functions.set('TRIM', (text) => text.trim());
        this.functions.set('SUBSTITUTE', (text, old, newText) => text.replace(new RegExp(old, 'g'), newText));
        // Logical functions
        this.functions.set('IF', this.ifFunction.bind(this));
        this.functions.set('AND', this.andFunction.bind(this));
        this.functions.set('OR', this.orFunction.bind(this));
        this.functions.set('NOT', (value) => !value);
        this.functions.set('TRUE', () => true);
        this.functions.set('FALSE', () => false);
        // Date functions
        this.functions.set('NOW', () => new Date());
        this.functions.set('TODAY', () => {
            const date = new Date();
            date.setHours(0, 0, 0, 0);
            return date;
        });
        this.functions.set('DATE', (year, month, day) => new Date(year, month - 1, day));
        this.functions.set('YEAR', (date) => date.getFullYear());
        this.functions.set('MONTH', (date) => date.getMonth() + 1);
        this.functions.set('DAY', (date) => date.getDate());
        // Lookup functions
        this.functions.set('VLOOKUP', this.vlookup.bind(this));
        this.functions.set('HLOOKUP', this.hlookup.bind(this));
        this.functions.set('INDEX', this.index.bind(this));
        this.functions.set('MATCH', this.match.bind(this));
        // Statistical functions
        this.functions.set('STDEV', this.stdev.bind(this));
        this.functions.set('VAR', this.variance.bind(this));
        this.functions.set('MEDIAN', this.median.bind(this));
        this.functions.set('MODE', this.mode.bind(this));
    }
    /**
     * Parse and calculate a formula
     */
    async calculate(formula, context) {
        try {
            // Remove leading '=' if present
            if (formula.startsWith('=')) {
                formula = formula.substring(1);
            }
            // Parse the formula into an AST
            const ast = this.parseFormula(formula);
            // Evaluate the AST
            return await this.evaluateAST(ast, context);
        }
        catch (error) {
            logger.error('Formula calculation error:', error);
            return '#ERROR!';
        }
    }
    /**
     * Parse formula string into AST
     */
    parseFormula(formula) {
        // Simple tokenizer and parser (simplified for demo)
        // In production, use a proper parser like PEG.js or write a full recursive descent parser
        // Check if it's a function call
        const functionMatch = formula.match(/^([A-Z]+)\((.*)\)$/);
        if (functionMatch) {
            const functionName = functionMatch[1];
            const args = this.parseArguments(functionMatch[2]);
            return {
                type: 'function',
                name: functionName,
                arguments: args
            };
        }
        // Check if it's a cell reference
        const cellMatch = formula.match(/^([A-Z]+)(\d+)$/);
        if (cellMatch) {
            return {
                type: 'cell',
                col: this.columnLetterToIndex(cellMatch[1]),
                row: parseInt(cellMatch[2]) - 1
            };
        }
        // Check if it's a range
        const rangeMatch = formula.match(/^([A-Z]+\d+):([A-Z]+\d+)$/);
        if (rangeMatch) {
            const start = this.parseCellReference(rangeMatch[1]);
            const end = this.parseCellReference(rangeMatch[2]);
            return {
                type: 'range',
                start,
                end
            };
        }
        // Check if it's a number
        const num = parseFloat(formula);
        if (!isNaN(num)) {
            return { type: 'number', value: num };
        }
        // Check if it's a string (quoted)
        if (formula.startsWith('"') && formula.endsWith('"')) {
            return { type: 'string', value: formula.slice(1, -1) };
        }
        // Check for operators
        const operators = ['+', '-', '*', '/', '=', '>', '<', '>=', '<=', '<>'];
        for (const op of operators) {
            const parts = formula.split(op);
            if (parts.length === 2) {
                return {
                    type: 'operator',
                    operator: op,
                    left: this.parseFormula(parts[0].trim()),
                    right: this.parseFormula(parts[1].trim())
                };
            }
        }
        // Default to string
        return { type: 'string', value: formula };
    }
    /**
     * Parse function arguments
     */
    parseArguments(argsString) {
        const args = [];
        let current = '';
        let depth = 0;
        let inQuotes = false;
        for (let i = 0; i < argsString.length; i++) {
            const char = argsString[i];
            if (char === '"' && (i === 0 || argsString[i - 1] !== '\\')) {
                inQuotes = !inQuotes;
            }
            if (!inQuotes) {
                if (char === '(')
                    depth++;
                if (char === ')')
                    depth--;
                if (char === ',' && depth === 0) {
                    args.push(this.parseFormula(current.trim()));
                    current = '';
                    continue;
                }
            }
            current += char;
        }
        if (current.trim()) {
            args.push(this.parseFormula(current.trim()));
        }
        return args;
    }
    /**
     * Evaluate AST node
     */
    async evaluateAST(node, context) {
        switch (node.type) {
            case 'number':
                return node.value;
            case 'string':
                return node.value;
            case 'cell':
                return await this.getCellValue(node.row, node.col, context);
            case 'range':
                return await this.getRangeValues(node.start, node.end, context);
            case 'function':
                const func = this.functions.get(node.name);
                if (!func) {
                    throw new Error(`Unknown function: ${node.name}`);
                }
                const args = await Promise.all(node.arguments.map((arg) => this.evaluateAST(arg, context)));
                return func(...args);
            case 'operator':
                const left = await this.evaluateAST(node.left, context);
                const right = await this.evaluateAST(node.right, context);
                return this.evaluateOperator(node.operator, left, right);
            default:
                throw new Error(`Unknown node type: ${node.type}`);
        }
    }
    /**
     * Evaluate binary operator
     */
    evaluateOperator(operator, left, right) {
        switch (operator) {
            case '+': return left + right;
            case '-': return left - right;
            case '*': return left * right;
            case '/': return right === 0 ? '#DIV/0!' : left / right;
            case '=': return left === right;
            case '>': return left > right;
            case '<': return left < right;
            case '>=': return left >= right;
            case '<=': return left <= right;
            case '<>': return left !== right;
            default:
                throw new Error(`Unknown operator: ${operator}`);
        }
    }
    /**
     * Get cell value from database
     */
    async getCellValue(row, col, context) {
        const cacheKey = `${context.sheetId}:${row}:${col}`;
        if (context.cache.has(cacheKey)) {
            return context.cache.get(cacheKey);
        }
        if (!db_1.db)
            return null;
        const cell = await db_1.db
            .selectFrom('cells')
            .select(['value', 'formula', 'data_type'])
            .where('sheet_id', '=', context.sheetId)
            .where('row_index', '=', row)
            .where('column_index', '=', col)
            .executeTakeFirst();
        if (!cell)
            return null;
        let value = cell.value;
        // Convert based on data type
        if (cell.data_type === 'number') {
            value = parseFloat(value);
        }
        else if (cell.data_type === 'boolean') {
            value = value === 'true' || value === '1';
        }
        else if (cell.data_type === 'date') {
            value = new Date(value);
        }
        // If cell has a formula, calculate it
        if (cell.formula) {
            value = await this.calculate(cell.formula, context);
        }
        context.cache.set(cacheKey, value);
        return value;
    }
    /**
     * Get range of cell values
     */
    async getRangeValues(start, end, context) {
        const values = [];
        for (let row = start.row; row <= end.row; row++) {
            const rowValues = [];
            for (let col = start.col; col <= end.col; col++) {
                const value = await this.getCellValue(row, col, context);
                rowValues.push(value);
            }
            values.push(rowValues);
        }
        return values;
    }
    /**
     * Parse cell reference string
     */
    parseCellReference(ref) {
        const match = ref.match(/^([A-Z]+)(\d+)$/);
        if (!match)
            throw new Error(`Invalid cell reference: ${ref}`);
        return {
            col: this.columnLetterToIndex(match[1]),
            row: parseInt(match[2]) - 1
        };
    }
    /**
     * Convert column letter to index
     */
    columnLetterToIndex(letter) {
        return letter
            .split('')
            .reduce((acc, char) => acc * 26 + char.charCodeAt(0) - 64, 0) - 1;
    }
    // Built-in function implementations
    sum(...args) {
        return this.flattenValues(args).reduce((acc, val) => acc + (parseFloat(val) || 0), 0);
    }
    average(...args) {
        const values = this.flattenValues(args);
        const sum = values.reduce((acc, val) => acc + (parseFloat(val) || 0), 0);
        return sum / values.length;
    }
    count(...args) {
        return this.flattenValues(args).filter(val => val !== null && val !== '').length;
    }
    max(...args) {
        return Math.max(...this.flattenValues(args).map(val => parseFloat(val) || 0));
    }
    min(...args) {
        return Math.min(...this.flattenValues(args).map(val => parseFloat(val) || 0));
    }
    concatenate(...args) {
        return this.flattenValues(args).join('');
    }
    ifFunction(condition, trueValue, falseValue) {
        return condition ? trueValue : falseValue;
    }
    andFunction(...args) {
        return this.flattenValues(args).every(val => !!val);
    }
    orFunction(...args) {
        return this.flattenValues(args).some(val => !!val);
    }
    vlookup(lookupValue, range, colIndex, exactMatch = true) {
        for (const row of range) {
            if (exactMatch ? row[0] === lookupValue : row[0] >= lookupValue) {
                return row[colIndex - 1];
            }
        }
        return '#N/A';
    }
    hlookup(lookupValue, range, rowIndex, exactMatch = true) {
        if (!range[0])
            return '#N/A';
        const colIndex = range[0].findIndex((val) => exactMatch ? val === lookupValue : val >= lookupValue);
        if (colIndex === -1)
            return '#N/A';
        return range[rowIndex - 1]?.[colIndex] ?? '#N/A';
    }
    index(range, row, col) {
        if (col === undefined) {
            return range[row - 1];
        }
        return range[row - 1]?.[col - 1] ?? '#REF!';
    }
    match(lookupValue, lookupArray, matchType = 0) {
        for (let i = 0; i < lookupArray.length; i++) {
            if (matchType === 0 && lookupArray[i] === lookupValue) {
                return i + 1;
            }
            else if (matchType === 1 && lookupArray[i] <= lookupValue) {
                if (i === lookupArray.length - 1 || lookupArray[i + 1] > lookupValue) {
                    return i + 1;
                }
            }
            else if (matchType === -1 && lookupArray[i] >= lookupValue) {
                return i + 1;
            }
        }
        return -1;
    }
    stdev(...args) {
        const values = this.flattenValues(args).map(val => parseFloat(val) || 0);
        const mean = values.reduce((a, b) => a + b) / values.length;
        const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b) / (values.length - 1);
        return Math.sqrt(variance);
    }
    variance(...args) {
        const values = this.flattenValues(args).map(val => parseFloat(val) || 0);
        const mean = values.reduce((a, b) => a + b) / values.length;
        const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
        return squaredDiffs.reduce((a, b) => a + b) / values.length;
    }
    median(...args) {
        const values = this.flattenValues(args)
            .map(val => parseFloat(val) || 0)
            .sort((a, b) => a - b);
        const mid = Math.floor(values.length / 2);
        return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    }
    mode(...args) {
        const values = this.flattenValues(args);
        const counts = new Map();
        for (const val of values) {
            counts.set(val, (counts.get(val) || 0) + 1);
        }
        let maxCount = 0;
        let mode = null;
        for (const [val, count] of counts.entries()) {
            if (count > maxCount) {
                maxCount = count;
                mode = val;
            }
        }
        return mode;
    }
    /**
     * Flatten nested arrays into single array
     */
    flattenValues(args) {
        const result = [];
        for (const arg of args) {
            if (Array.isArray(arg)) {
                if (Array.isArray(arg[0])) {
                    // 2D array (range)
                    for (const row of arg) {
                        result.push(...row);
                    }
                }
                else {
                    // 1D array
                    result.push(...arg);
                }
            }
            else {
                result.push(arg);
            }
        }
        return result;
    }
    /**
     * Build dependency graph for a sheet
     */
    async buildDependencyGraph(sheetId) {
        if (!db_1.db)
            return;
        const formulas = await db_1.db
            .selectFrom('formulas')
            .select(['cell_id', 'dependencies', 'dependents'])
            .where('sheet_id', '=', sheetId)
            .execute();
        this.dependencyGraph.clear();
        for (const formula of formulas) {
            const deps = formula.dependencies;
            this.dependencyGraph.set(formula.cell_id, new Set(deps));
        }
        // Calculate topological order for calculation
        this.calculationOrder = this.topologicalSort();
    }
    /**
     * Topological sort for calculation order
     */
    topologicalSort() {
        const visited = new Set();
        const result = [];
        const visit = (node) => {
            if (visited.has(node))
                return;
            visited.add(node);
            const deps = this.dependencyGraph.get(node);
            if (deps) {
                for (const dep of deps) {
                    visit(dep);
                }
            }
            result.push(node);
        };
        for (const node of this.dependencyGraph.keys()) {
            visit(node);
        }
        return result;
    }
}
exports.FormulaEngine = FormulaEngine;
// Export singleton instance
exports.formulaEngine = new FormulaEngine();
//# sourceMappingURL=engine.js.map