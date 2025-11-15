/**
 * Safe Functions Library
 * Pre-defined safe functions that can be exposed to sandboxed scripts
 */
export declare const SafeMathFunctions: {
    sum: (arr: number[]) => number;
    average: (arr: number[]) => number;
    median: (arr: number[]) => number;
    min: (arr: number[]) => number;
    max: (arr: number[]) => number;
    standardDeviation: (arr: number[]) => number;
    round: (num: number, decimals?: number) => number;
    range: (start: number, end: number, step?: number) => number[];
    random: (min?: number, max?: number) => number;
    randomInt: (min: number, max: number) => number;
};
export declare const SafeStringFunctions: {
    capitalize: (str: string) => string;
    titleCase: (str: string) => string;
    camelCase: (str: string) => string;
    snakeCase: (str: string) => string;
    kebabCase: (str: string) => string;
    isEmail: (str: string) => boolean;
    isURL: (str: string) => boolean;
    isNumeric: (str: string) => boolean;
    removeHtml: (str: string) => string;
    truncate: (str: string, length: number, suffix?: string) => string;
    extractNumbers: (str: string) => number[];
    wordCount: (str: string) => number;
};
export declare const SafeArrayFunctions: {
    unique: <T>(arr: T[]) => T[];
    flatten: <T>(arr: any[]) => T[];
    chunk: <T>(arr: T[], size: number) => T[][];
    shuffle: <T>(arr: T[]) => T[];
    compact: <T>(arr: (T | null | undefined | false | 0 | "")[]) => T[];
    difference: <T>(arr1: T[], arr2: T[]) => T[];
    intersection: <T>(arr1: T[], arr2: T[]) => T[];
    findIndex: <T>(arr: T[], predicate: (item: T) => boolean) => number;
    findLastIndex: <T>(arr: T[], predicate: (item: T) => boolean) => number;
};
export declare const SafeDateFunctions: {
    formatDate: (date: Date | string, format?: string) => string;
    addDays: (date: Date | string, days: number) => Date;
    addMonths: (date: Date | string, months: number) => Date;
    addYears: (date: Date | string, years: number) => Date;
    daysBetween: (date1: Date | string, date2: Date | string) => number;
    isWeekend: (date: Date | string) => boolean;
    isLeapYear: (year: number) => boolean;
    parseDate: (dateString: string) => Date | null;
};
export declare const SafeObjectFunctions: {
    pick: <T extends object, K extends keyof T>(obj: T, keys: K[]) => Pick<T, K>;
    omit: <T extends object, K extends keyof T>(obj: T, keys: K[]) => Omit<T, K>;
    merge: <T extends object>(...objects: Partial<T>[]) => T;
    hasKey: <T extends object>(obj: T, key: PropertyKey) => boolean;
    isEmpty: (obj: object) => boolean;
    mapValues: <T extends object, R>(obj: T, fn: (value: T[keyof T], key: keyof T) => R) => Record<keyof T, R>;
    invert: <T extends Record<PropertyKey, PropertyKey>>(obj: T) => Record<T[keyof T], keyof T>;
    deepClone: <T>(obj: T, visited?: WeakSet<object>) => T;
};
export declare const SafeValidationFunctions: {
    isString: (value: any) => value is string;
    isNumber: (value: any) => value is number;
    isBoolean: (value: any) => value is boolean;
    isArray: (value: any) => value is any[];
    isObject: (value: any) => value is object;
    isNull: (value: any) => value is null;
    isUndefined: (value: any) => value is undefined;
    isFunction: (value: any) => value is Function;
    inRange: (value: number, min: number, max: number) => boolean;
    matches: (value: string, pattern: string | RegExp) => boolean;
    validateSchema: (obj: any, schema: Record<string, any>) => {
        valid: boolean;
        errors: string[];
    };
};
export declare const SafeFunctions: {
    math: {
        sum: (arr: number[]) => number;
        average: (arr: number[]) => number;
        median: (arr: number[]) => number;
        min: (arr: number[]) => number;
        max: (arr: number[]) => number;
        standardDeviation: (arr: number[]) => number;
        round: (num: number, decimals?: number) => number;
        range: (start: number, end: number, step?: number) => number[];
        random: (min?: number, max?: number) => number;
        randomInt: (min: number, max: number) => number;
    };
    string: {
        capitalize: (str: string) => string;
        titleCase: (str: string) => string;
        camelCase: (str: string) => string;
        snakeCase: (str: string) => string;
        kebabCase: (str: string) => string;
        isEmail: (str: string) => boolean;
        isURL: (str: string) => boolean;
        isNumeric: (str: string) => boolean;
        removeHtml: (str: string) => string;
        truncate: (str: string, length: number, suffix?: string) => string;
        extractNumbers: (str: string) => number[];
        wordCount: (str: string) => number;
    };
    array: {
        unique: <T>(arr: T[]) => T[];
        flatten: <T>(arr: any[]) => T[];
        chunk: <T>(arr: T[], size: number) => T[][];
        shuffle: <T>(arr: T[]) => T[];
        compact: <T>(arr: (T | null | undefined | false | 0 | "")[]) => T[];
        difference: <T>(arr1: T[], arr2: T[]) => T[];
        intersection: <T>(arr1: T[], arr2: T[]) => T[];
        findIndex: <T>(arr: T[], predicate: (item: T) => boolean) => number;
        findLastIndex: <T>(arr: T[], predicate: (item: T) => boolean) => number;
    };
    date: {
        formatDate: (date: Date | string, format?: string) => string;
        addDays: (date: Date | string, days: number) => Date;
        addMonths: (date: Date | string, months: number) => Date;
        addYears: (date: Date | string, years: number) => Date;
        daysBetween: (date1: Date | string, date2: Date | string) => number;
        isWeekend: (date: Date | string) => boolean;
        isLeapYear: (year: number) => boolean;
        parseDate: (dateString: string) => Date | null;
    };
    object: {
        pick: <T extends object, K extends keyof T>(obj: T, keys: K[]) => Pick<T, K>;
        omit: <T extends object, K extends keyof T>(obj: T, keys: K[]) => Omit<T, K>;
        merge: <T extends object>(...objects: Partial<T>[]) => T;
        hasKey: <T extends object>(obj: T, key: PropertyKey) => boolean;
        isEmpty: (obj: object) => boolean;
        mapValues: <T extends object, R>(obj: T, fn: (value: T[keyof T], key: keyof T) => R) => Record<keyof T, R>;
        invert: <T extends Record<PropertyKey, PropertyKey>>(obj: T) => Record<T[keyof T], keyof T>;
        deepClone: <T>(obj: T, visited?: WeakSet<object>) => T;
    };
    validation: {
        isString: (value: any) => value is string;
        isNumber: (value: any) => value is number;
        isBoolean: (value: any) => value is boolean;
        isArray: (value: any) => value is any[];
        isObject: (value: any) => value is object;
        isNull: (value: any) => value is null;
        isUndefined: (value: any) => value is undefined;
        isFunction: (value: any) => value is Function;
        inRange: (value: number, min: number, max: number) => boolean;
        matches: (value: string, pattern: string | RegExp) => boolean;
        validateSchema: (obj: any, schema: Record<string, any>) => {
            valid: boolean;
            errors: string[];
        };
    };
};
export declare function createSafeContext(): Record<string, any>;
//# sourceMappingURL=SafeFunctions.d.ts.map