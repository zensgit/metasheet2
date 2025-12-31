import { BaseFunction, BaseValueObject, FunctionMeta, FormulaError } from '../../base';

export class Concatenate extends BaseFunction {
    meta: FunctionMeta = {
        name: 'CONCATENATE',
        category: 'text',
        description: 'Joins several text strings into one text string.',
        syntax: 'CONCATENATE(text1, [text2], ...)',
        examples: ['CONCATENATE("Hello", " ", "World")', 'CONCATENATE(A1, B1)'],
        params: [
            {
                name: 'text1',
                type: 'string',
                required: true,
                description: 'The first item to join. Can be a text value, number, or boolean.'
            },
            {
                name: 'text2',
                type: 'string',
                required: false,
                description: 'Additional text items to join.'
            }
        ],
        returnType: 'string'
    };

    minParams: number = 1;
    maxParams: number = Infinity;

    calculate(...variants: BaseValueObject[]): BaseValueObject {
        this.validateParams(variants);

        let resultString = '';
        for (const variant of variants) {
            if (variant.isError()) {
                return variant;
            }
            resultString += String(variant.getValue());
        }
        return new BaseValueObject(resultString);
    }
}
