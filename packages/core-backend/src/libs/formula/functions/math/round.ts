import { BaseFunction, BaseValueObject, FunctionMeta, FormulaError } from '../../base';

export class Round extends BaseFunction {
    meta: FunctionMeta = {
        name: 'ROUND',
        category: 'math',
        description: 'Rounds a number to a specified number of digits.',
        syntax: 'ROUND(number, num_digits)',
        examples: ['ROUND(3.14159, 2)', 'ROUND(123.456, 0)'],
        params: [
            {
                name: 'number',
                type: 'number',
                required: true,
                description: 'The number you want to round.'
            },
            {
                name: 'num_digits',
                type: 'number',
                required: true,
                description: 'The number of digits to which you want to round the number.'
            }
        ],
        returnType: 'number'
    };

    minParams: number = 2;
    maxParams: number = 2;

    calculate(...variants: BaseValueObject[]): BaseValueObject {
        this.validateParams(variants);

        const numberVal = variants[0].getValue();
        const numDigits = variants[1].getValue();

        if (typeof numberVal !== 'number' || isNaN(numberVal)) {
            return new BaseValueObject(new FormulaError('#VALUE!'));
        }
        if (typeof numDigits !== 'number' || isNaN(numDigits)) {
            return new BaseValueObject(new FormulaError('#VALUE!'));
        }

        const multiplier = Math.pow(10, numDigits);
        return new BaseValueObject(Math.round(numberVal * multiplier) / multiplier);
    }
}
