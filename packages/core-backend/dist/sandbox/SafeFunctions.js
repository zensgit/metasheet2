"use strict";
/**
 * Safe Functions Library
 * Pre-defined safe functions that can be exposed to sandboxed scripts
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SafeFunctions = exports.SafeValidationFunctions = exports.SafeObjectFunctions = exports.SafeDateFunctions = exports.SafeArrayFunctions = exports.SafeStringFunctions = exports.SafeMathFunctions = void 0;
exports.createSafeContext = createSafeContext;
exports.SafeMathFunctions = {
    // Basic math operations
    sum: (arr) => arr.reduce((a, b) => a + b, 0),
    average: (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,
    median: (arr) => {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    },
    min: (arr) => Math.min(...arr),
    max: (arr) => Math.max(...arr),
    // Statistical functions
    standardDeviation: (arr) => {
        const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
        const squareDiffs = arr.map(value => Math.pow(value - avg, 2));
        const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / arr.length;
        return Math.sqrt(avgSquareDiff);
    },
    // Rounding functions
    round: (num, decimals = 0) => {
        const factor = Math.pow(10, decimals);
        return Math.round(num * factor) / factor;
    },
    // Range functions
    range: (start, end, step = 1) => {
        const result = [];
        for (let i = start; i <= end; i += step) {
            result.push(i);
        }
        return result;
    },
    // Random functions
    random: (min = 0, max = 1) => {
        return Math.random() * (max - min) + min;
    },
    randomInt: (min, max) => {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
};
exports.SafeStringFunctions = {
    // String manipulation
    capitalize: (str) => {
        return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    },
    titleCase: (str) => {
        return str.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
    },
    camelCase: (str) => {
        return str.replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : '');
    },
    snakeCase: (str) => {
        return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
            .replace(/^_/, '')
            .replace(/\s+/g, '_');
    },
    kebabCase: (str) => {
        return str.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
            .replace(/^-/, '')
            .replace(/\s+/g, '-');
    },
    // String validation
    isEmail: (str) => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(str);
    },
    isURL: (str) => {
        try {
            new URL(str);
            return true;
        }
        catch {
            return false;
        }
    },
    isNumeric: (str) => {
        return !isNaN(Number(str)) && !isNaN(parseFloat(str));
    },
    // String cleaning
    removeHtml: (str) => {
        return str.replace(/<[^>]*>/g, '');
    },
    truncate: (str, length, suffix = '...') => {
        if (str.length <= length)
            return str;
        return str.substring(0, length - suffix.length) + suffix;
    },
    // String parsing
    extractNumbers: (str) => {
        const matches = str.match(/-?\d+\.?\d*/g);
        return matches ? matches.map(Number) : [];
    },
    wordCount: (str) => {
        return str.trim().split(/\s+/).length;
    }
};
exports.SafeArrayFunctions = {
    // Array manipulation
    unique: (arr) => {
        return [...new Set(arr)];
    },
    flatten: (arr) => {
        return arr.reduce((flat, item) => {
            return flat.concat(Array.isArray(item) ? exports.SafeArrayFunctions.flatten(item) : item);
        }, []);
    },
    chunk: (arr, size) => {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size) {
            chunks.push(arr.slice(i, i + size));
        }
        return chunks;
    },
    shuffle: (arr) => {
        const shuffled = [...arr];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    },
    // Array filtering
    compact: (arr) => {
        return arr.filter(Boolean);
    },
    difference: (arr1, arr2) => {
        const set2 = new Set(arr2);
        return arr1.filter(x => !set2.has(x));
    },
    intersection: (arr1, arr2) => {
        const set2 = new Set(arr2);
        return arr1.filter(x => set2.has(x));
    },
    // Array searching
    findIndex: (arr, predicate) => {
        for (let i = 0; i < arr.length; i++) {
            if (predicate(arr[i]))
                return i;
        }
        return -1;
    },
    findLastIndex: (arr, predicate) => {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (predicate(arr[i]))
                return i;
        }
        return -1;
    }
};
exports.SafeDateFunctions = {
    // Date formatting
    formatDate: (date, format = 'YYYY-MM-DD') => {
        const d = typeof date === 'string' ? new Date(date) : date;
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        const seconds = String(d.getSeconds()).padStart(2, '0');
        return format
            .replace('YYYY', String(year))
            .replace('MM', month)
            .replace('DD', day)
            .replace('HH', hours)
            .replace('mm', minutes)
            .replace('ss', seconds);
    },
    // Date manipulation
    addDays: (date, days) => {
        const d = new Date(date);
        d.setDate(d.getDate() + days);
        return d;
    },
    addMonths: (date, months) => {
        const d = new Date(date);
        d.setMonth(d.getMonth() + months);
        return d;
    },
    addYears: (date, years) => {
        const d = new Date(date);
        d.setFullYear(d.getFullYear() + years);
        return d;
    },
    // Date comparison
    daysBetween: (date1, date2) => {
        const d1 = new Date(date1);
        const d2 = new Date(date2);
        const diffTime = Math.abs(d2.getTime() - d1.getTime());
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    },
    isWeekend: (date) => {
        const d = new Date(date);
        const day = d.getDay();
        return day === 0 || day === 6;
    },
    isLeapYear: (year) => {
        return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    },
    // Date parsing
    parseDate: (dateString) => {
        const date = new Date(dateString);
        return isNaN(date.getTime()) ? null : date;
    }
};
exports.SafeObjectFunctions = {
    // Object manipulation
    pick: (obj, keys) => {
        const result = {};
        keys.forEach(key => {
            if (key in obj) {
                result[key] = obj[key];
            }
        });
        return result;
    },
    omit: (obj, keys) => {
        const result = { ...obj };
        keys.forEach(key => {
            delete result[key];
        });
        return result;
    },
    merge: (...objects) => {
        return Object.assign({}, ...objects);
    },
    // Object validation
    hasKey: (obj, key) => {
        return key in obj;
    },
    isEmpty: (obj) => {
        return Object.keys(obj).length === 0;
    },
    // Object transformation
    mapValues: (obj, fn) => {
        const result = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                result[key] = fn(obj[key], key);
            }
        }
        return result;
    },
    invert: (obj) => {
        const result = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                result[obj[key]] = key;
            }
        }
        return result;
    },
    // Deep operations (with cycle protection)
    deepClone: (obj, visited = new WeakSet()) => {
        if (obj === null || typeof obj !== 'object')
            return obj;
        if (visited.has(obj))
            return obj;
        visited.add(obj);
        if (obj instanceof Date)
            return new Date(obj.getTime());
        if (obj instanceof Array) {
            return obj.map(item => exports.SafeObjectFunctions.deepClone(item, visited));
        }
        const clonedObj = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                clonedObj[key] = exports.SafeObjectFunctions.deepClone(obj[key], visited);
            }
        }
        return clonedObj;
    }
};
exports.SafeValidationFunctions = {
    // Type checking
    isString: (value) => typeof value === 'string',
    isNumber: (value) => typeof value === 'number' && !isNaN(value),
    isBoolean: (value) => typeof value === 'boolean',
    isArray: (value) => Array.isArray(value),
    isObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    isNull: (value) => value === null,
    isUndefined: (value) => value === undefined,
    isFunction: (value) => typeof value === 'function',
    // Value validation
    inRange: (value, min, max) => {
        return value >= min && value <= max;
    },
    matches: (value, pattern) => {
        const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
        return regex.test(value);
    },
    // Schema validation (simple)
    validateSchema: (obj, schema) => {
        const errors = [];
        for (const key in schema) {
            const rule = schema[key];
            const value = obj[key];
            if (rule.required && value === undefined) {
                errors.push(`Missing required field: ${key}`);
            }
            if (value !== undefined && rule.type) {
                const type = typeof value;
                if (type !== rule.type) {
                    errors.push(`Invalid type for ${key}: expected ${rule.type}, got ${type}`);
                }
            }
            if (value !== undefined && rule.min !== undefined) {
                if (typeof value === 'number' && value < rule.min) {
                    errors.push(`${key} is below minimum: ${rule.min}`);
                }
                if (typeof value === 'string' && value.length < rule.min) {
                    errors.push(`${key} length is below minimum: ${rule.min}`);
                }
            }
            if (value !== undefined && rule.max !== undefined) {
                if (typeof value === 'number' && value > rule.max) {
                    errors.push(`${key} is above maximum: ${rule.max}`);
                }
                if (typeof value === 'string' && value.length > rule.max) {
                    errors.push(`${key} length is above maximum: ${rule.max}`);
                }
            }
        }
        return { valid: errors.length === 0, errors };
    }
};
// Export all safe functions
exports.SafeFunctions = {
    math: exports.SafeMathFunctions,
    string: exports.SafeStringFunctions,
    array: exports.SafeArrayFunctions,
    date: exports.SafeDateFunctions,
    object: exports.SafeObjectFunctions,
    validation: exports.SafeValidationFunctions
};
// Create a context with all safe functions for sandbox execution
function createSafeContext() {
    return {
        // Math functions
        sum: exports.SafeMathFunctions.sum,
        average: exports.SafeMathFunctions.average,
        median: exports.SafeMathFunctions.median,
        round: exports.SafeMathFunctions.round,
        // String functions
        capitalize: exports.SafeStringFunctions.capitalize,
        titleCase: exports.SafeStringFunctions.titleCase,
        isEmail: exports.SafeStringFunctions.isEmail,
        truncate: exports.SafeStringFunctions.truncate,
        // Array functions
        unique: exports.SafeArrayFunctions.unique,
        flatten: exports.SafeArrayFunctions.flatten,
        chunk: exports.SafeArrayFunctions.chunk,
        // Date functions
        formatDate: exports.SafeDateFunctions.formatDate,
        addDays: exports.SafeDateFunctions.addDays,
        daysBetween: exports.SafeDateFunctions.daysBetween,
        // Object functions
        pick: exports.SafeObjectFunctions.pick,
        omit: exports.SafeObjectFunctions.omit,
        merge: exports.SafeObjectFunctions.merge,
        // Validation functions
        isString: exports.SafeValidationFunctions.isString,
        isNumber: exports.SafeValidationFunctions.isNumber,
        validateSchema: exports.SafeValidationFunctions.validateSchema
    };
}
//# sourceMappingURL=SafeFunctions.js.map