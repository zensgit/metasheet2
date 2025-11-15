/**
 * Formula Calculation Engine
 * Handles formula parsing, dependency resolution, and calculation
 */
export interface CellReference {
    sheet?: string;
    row: number;
    col: number;
    absolute: boolean;
}
export interface FormulaContext {
    sheetId: string;
    spreadsheetId: string;
    currentCell: {
        row: number;
        col: number;
    };
    cache: Map<string, any>;
}
export declare class FormulaEngine {
    private functions;
    private calculationOrder;
    private dependencyGraph;
    constructor();
    /**
     * Register built-in spreadsheet functions
     */
    private registerBuiltinFunctions;
    /**
     * Parse and calculate a formula
     */
    calculate(formula: string, context: FormulaContext): Promise<any>;
    /**
     * Parse formula string into AST
     */
    private parseFormula;
    /**
     * Parse function arguments
     */
    private parseArguments;
    /**
     * Evaluate AST node
     */
    private evaluateAST;
    /**
     * Evaluate binary operator
     */
    private evaluateOperator;
    /**
     * Get cell value from database
     */
    private getCellValue;
    /**
     * Get range of cell values
     */
    private getRangeValues;
    /**
     * Parse cell reference string
     */
    private parseCellReference;
    /**
     * Convert column letter to index
     */
    private columnLetterToIndex;
    private sum;
    private average;
    private count;
    private max;
    private min;
    private concatenate;
    private ifFunction;
    private andFunction;
    private orFunction;
    private vlookup;
    private hlookup;
    private index;
    private match;
    private stdev;
    private variance;
    private median;
    private mode;
    /**
     * Flatten nested arrays into single array
     */
    private flattenValues;
    /**
     * Build dependency graph for a sheet
     */
    buildDependencyGraph(sheetId: string): Promise<void>;
    /**
     * Topological sort for calculation order
     */
    private topologicalSort;
}
export declare const formulaEngine: FormulaEngine;
//# sourceMappingURL=engine.d.ts.map