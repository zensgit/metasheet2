import { BaseFunction, BaseValueObject, FunctionMeta, FormulaError } from '../../base';

export class And extends BaseFunction {
    meta: FunctionMeta = {
        name: 'AND',
        category: 'logical',
        description: 'Checks whether all arguments are TRUE, and returns TRUE if all arguments are TRUE.',
        syntax: 'AND(logical1, [logical2], ...)',
        examples: ['AND(A1>0, B1<100)', 'AND(TRUE, FALSE)'],
        params: [
            {
                name: 'logical1',
                type: 'boolean',
                required: true,
                description: 'The first condition you want to test that can be evaluated to TRUE or FALSE.'
            },
            {
                name: 'logical2',
                type: 'boolean',
                required: false,
                description: 'Additional conditions you want to test.'
            }
        ],
        returnType: 'boolean'
    };

    minParams: number = 1;
    maxParams: number = Infinity;

    calculate(...variants: BaseValueObject[]): BaseValueObject {
        this.validateParams(variants);

        for (const variant of variants) {
            if (variant.isError()) {
                return variant;
            }
            let logicalVal: boolean;
            const value = variant.getValue();

            if (typeof value === 'boolean') {
                logicalVal = value;
            } else if (typeof value === 'number') {
                logicalVal = value !== 0;
            } else if (typeof value === 'string') { // Handle "TRUE" / "FALSE" literals
                const upperCaseValue = value.toUpperCase();
                if (upperCaseValue === 'TRUE') {
                    logicalVal = true;
                } else if (upperCaseValue === 'FALSE') {
                    logicalVal = false;
                } else {
                    return new BaseValueObject(new FormulaError('#VALUE!'));
                }
            } else {
                return new BaseValueObject(new FormulaError('#VALUE!'));
            }

            if (!logicalVal) {
                return new BaseValueObject(false);
            }
        }
        return new BaseValueObject(true);
    }
}