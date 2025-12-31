import { BaseFunction, BaseValueObject, FunctionMeta, FormulaError } from '../../base';

export class If extends BaseFunction {
    meta: FunctionMeta = {
        name: 'IF',
        category: 'logical',
        description: 'Checks whether a condition is met, and returns one value if TRUE, and another value if FALSE.',
        syntax: 'IF(logical_test, value_if_true, [value_if_false])',
        examples: ['IF(A1>10, "High", "Low")', 'IF(B2=TRUE, 1, 0)'],
        params: [
            {
                name: 'logical_test',
                type: 'boolean',
                required: true,
                description: 'The condition you want to check. Can be any value or expression that can be evaluated to TRUE or FALSE.'
            },
            {
                name: 'value_if_true',
                type: 'any',
                required: true,
                description: 'The value that is returned if logical_test is TRUE.'
            },
            {
                name: 'value_if_false',
                type: 'any',
                required: false,
                description: 'The value that is returned if logical_test is FALSE. If omitted, and logical_test is FALSE, FALSE is returned.'
            }
        ],
        returnType: 'any'
    };

    minParams: number = 2;
    maxParams: number = 3;

    calculate(...variants: BaseValueObject[]): BaseValueObject {
        this.validateParams(variants);

        const logicalTest = variants[0];
        if (logicalTest.isError()) {
            return logicalTest;
        }
        
        let testResult: boolean;
        const testValue = logicalTest.getValue();

        if (typeof testValue === 'boolean') {
            testResult = testValue;
        } else if (typeof testValue === 'number') {
            testResult = testValue !== 0;
        } else if (typeof testValue === 'string') { // Handle "TRUE" / "FALSE" literals
            const upperCaseValue = testValue.toUpperCase();
            if (upperCaseValue === 'TRUE') {
                testResult = true;
            } else if (upperCaseValue === 'FALSE') {
                testResult = false;
            } else {
                return new BaseValueObject(new FormulaError('#VALUE!'));
            }
        } else {
            return new BaseValueObject(new FormulaError('#VALUE!'));
        }

        if (testResult) {
            return variants[1];
        } else {
            return variants.length === 3 ? variants[2] : new BaseValueObject(false);
        }
    }
}