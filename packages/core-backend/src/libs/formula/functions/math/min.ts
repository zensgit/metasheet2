import { BaseFunction, BaseValueObject, FunctionMeta, FormulaError } from '../../base';

export class Min extends BaseFunction {
    meta: FunctionMeta = {
        name: 'MIN',
        category: 'math',
        description: 'Returns the smallest value in a set of values.',
        syntax: 'MIN(value1, [value2], ...)',
        examples: ['MIN(10, 20, 30)', 'MIN(A1:C5)'],
        params: [
            {
                name: 'value1',
                type: 'number | array',
                required: true,
                description: 'The first number, range, or array for which you want to find the minimum value.'
            },
            {
                name: 'value2',
                type: 'number | array',
                required: false,
                description: 'Additional numbers, ranges, or arrays.'
            }
        ],
        returnType: 'number'
    };

    minParams: number = 1;
    maxParams: number = Infinity;

    calculate(...variants: BaseValueObject[]): BaseValueObject {
        this.validateParams(variants);

        let minVal: number | undefined;

        const processValue = (value: any) => {
            if (value instanceof BaseValueObject) {
                value = value.getValue();
            }

            if (Array.isArray(value)) {
                value.forEach(processValue);
            } else if (typeof value === 'number' && !isNaN(value)) {
                if (minVal === undefined || value < minVal) {
                    minVal = value;
                }
            }
        };

        variants.forEach(processValue);

        if (minVal === undefined) {
            return new BaseValueObject(0); // Excel returns 0 if no numbers are found, or error depending on version/context
                                           // For now, return 0. Could be #VALUE! error for strictness.
        }

        return new BaseValueObject(minVal);
    }
}
