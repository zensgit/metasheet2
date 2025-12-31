import { BaseFunction, BaseValueObject, FunctionMeta } from '../../base';

export class Count extends BaseFunction {
    meta: FunctionMeta = {
        name: 'COUNT',
        category: 'math',
        description: 'Counts the number of cells that contain numbers and counts numbers within the list of arguments.',
        syntax: 'COUNT(value1, [value2], ...)',
        examples: ['COUNT(1, 2, "test", TRUE)', 'COUNT(A1:C5)'],
        params: [
            {
                name: 'value1',
                type: 'any',
                required: true,
                description: 'The first item, range, or array containing numbers to count.'
            },
            {
                name: 'value2',
                type: 'any',
                required: false,
                description: 'Additional items, ranges, or arrays.'
            }
        ],
        returnType: 'number'
    };

    minParams: number = 1;
    maxParams: number = Infinity;

    calculate(...variants: BaseValueObject[]): BaseValueObject {
        this.validateParams(variants);

        let count = 0;

        const processValue = (variant: BaseValueObject | any) => {
            let value = (variant instanceof BaseValueObject) ? variant.getValue() : variant;

            if (Array.isArray(value)) {
                value.forEach(processValue);
            } else if (typeof value === 'number' && !isNaN(value)) {
                count++;
            }
            // According to Excel's COUNT behavior, it counts numbers (and dates/times which are numbers),
            // but ignores booleans, errors, and text.
        };

        variants.forEach(processValue);

        return new BaseValueObject(count);
    }
}
