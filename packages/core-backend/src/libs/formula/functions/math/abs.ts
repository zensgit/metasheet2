import { BaseFunction, BaseValueObject, FunctionMeta, FormulaError } from '../../base';

export class Abs extends BaseFunction {
    meta: FunctionMeta = {
        name: 'ABS',
        category: 'math',
        description: 'Returns the absolute value of a number.',
        syntax: 'ABS(number)',
        examples: ['ABS(-10)', 'ABS(A1)'],
        params: [
            {
                name: 'number',
                type: 'number',
                required: true,
                description: 'The number for which you want the absolute value.'
            }
        ],
        returnType: 'number'
    };

    minParams: number = 1;
    maxParams: number = 1;

    calculate(...variants: BaseValueObject[]): BaseValueObject {
        this.validateParams(variants);

        const numberVal = variants[0];
        if (numberVal.isError()) {
            return numberVal;
        }

        let valueToProcess = numberVal.getValue();
        if (typeof valueToProcess === 'string') {
            valueToProcess = Number(valueToProcess);
            if (isNaN(valueToProcess)) {
                return new BaseValueObject(new FormulaError('#VALUE!'));
            }
        } else if (typeof valueToProcess !== 'number') {
             return new BaseValueObject(new FormulaError('#VALUE!'));
        }

        return new BaseValueObject(Math.abs(valueToProcess));
    }
}