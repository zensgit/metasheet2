import { BaseFunction, BaseValueObject, FunctionMeta, FormulaError } from '../../base';

export class Average extends BaseFunction {
    meta: FunctionMeta = {
        name: 'AVERAGE',
        category: 'math',
        description: 'Returns the average (arithmetic mean) of its arguments.',
        syntax: 'AVERAGE(value1, [value2], ...)',
        examples: ['AVERAGE(10, 20, 30)', 'AVERAGE(A1:B5)'],
        params: [
            {
                name: 'value1',
                type: 'number | array',
                required: true,
                description: 'The first number, range, or array for which you want the average.'
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
    maxParams: number = Infinity; // Can take multiple arguments

    calculate(...variants: BaseValueObject[]): BaseValueObject {
        this.validateParams(variants);

        let sum = 0;
        let count = 0;

        const processValue = (value: any) => {
            if (value instanceof BaseValueObject) {
                value = value.getValue();
            }

            if (Array.isArray(value)) {
                value.forEach(processValue);
            } else if (typeof value === 'number' && !isNaN(value)) {
                sum += value;
                count++;
            }
            // Ignore non-numeric values
        };

        variants.forEach(processValue);

        if (count === 0) {
            return new BaseValueObject(new FormulaError('#DIV/0!')); // Division by zero error
        }

        return new BaseValueObject(sum / count);
    }
}
