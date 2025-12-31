import { FunctionRegistry, FunctionName } from '../libs/formula';
import { BaseValueObject } from '../libs/formula/base';
import { Interpreter, ResolverFunction } from '../libs/formula/interpreter';
import { FormulaExprLexer, FormulaExprParser } from '../libs/parser';

export class FormulaService {
    constructor() {}

    /**
     * Calculates a formula string expression.
     * @param expression The formula string (e.g. "SUM(1, 2) + 5")
     * @param contextResolver Optional callback to resolve variables (e.g. "{Field}")
     */
    public calculateFormula(expression: string, contextResolver?: ResolverFunction): any {
        const lexer = new FormulaExprLexer(expression);
        const parser = new FormulaExprParser(lexer);
        const ast = parser.parse();
        const interpreter = new Interpreter(contextResolver);
        return interpreter.visit(ast);
    }

    /**
     * Calculates a formula function directly.
     * @param functionName The name of the function (e.g., 'SUM', 'ABS')
     * @param args The arguments for the function.
     */
    public calculate(functionName: string, ...args: any[]): any {
        const upperName = functionName.toUpperCase();
        const func = FunctionRegistry[upperName as FunctionName];

        if (!func) {
            throw new Error(`Function ${upperName} not found.`);
        }

        // 1. Adapter: Convert JS native types to ShimValueObject
        const wrappedArgs = args.map(arg => BaseValueObject.create(arg));

        // 2. Execute: Call the ported Univer logic
        const resultValueObject = func.calculate(...wrappedArgs);

        // 3. Unbox: Convert back to JS native type
        if (resultValueObject.isError()) {
            return { error: (resultValueObject.getValue() as Error).message };
        }

        return resultValueObject.getValue();
    }

    public getAvailableFunctions(): string[] {
        return Object.keys(FunctionRegistry);
    }
}
