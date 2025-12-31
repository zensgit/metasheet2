import { BaseFunction, BaseValueObject, FunctionMeta, FormulaError } from '../../base';

export class Len extends BaseFunction {
    meta: FunctionMeta = {
        name: 'LEN',
        category: 'text',
        description: 'Returns the number of characters in a text string.',
        syntax: 'LEN(text)',
        examples: ['LEN("Hello World")', 'LEN(A1)'],
        params: [
            {
                name: 'text',
                type: 'string',
                required: true,
                description: 'The text whose length you want to find.'
            }
        ],
        returnType: 'number'
    };

    minParams: number = 1;
    maxParams: number = 1;

    calculate(...variants: BaseValueObject[]): BaseValueObject {
        this.validateParams(variants);

        const textVal = variants[0];
        if (textVal.isError()) {
            return textVal;
        }

        return new BaseValueObject(String(textVal.getValue()).length);
    }
}
