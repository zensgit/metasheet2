import { BaseFunction, BaseValueObject, FunctionMeta, FormulaError } from '../../base';

export class Sum extends BaseFunction {
    meta: FunctionMeta = {
        name: 'SUM',
        category: 'math',
        description: 'Adds all the numbers in a range of cells.',
        syntax: 'SUM(number1, [number2], ...)',
        examples: ['SUM(10, 20)', 'SUM(A1:B5)'],
        params: [
            {
                name: 'number1',
                type: 'number | array',
                required: true,
                description: 'The first number, range, or array for which you want to sum.'
            },
            {
                name: 'number2',
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

        let sum = 0;
        const processValue = (value: any) => {
            if (value instanceof BaseValueObject) {
                value = value.getValue();
            }
            if (Array.isArray(value)) {
                value.forEach(processValue);
            } else if (typeof value === 'number' && !isNaN(value)) {
                sum += value;
            }
        };

        variants.forEach(processValue);
        return new BaseValueObject(sum);
    }
}