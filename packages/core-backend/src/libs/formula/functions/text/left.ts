import { BaseFunction, BaseValueObject, FunctionMeta, FormulaError } from '../../base';

export class Left extends BaseFunction {
    meta: FunctionMeta = {
        name: 'LEFT',
        category: 'text',
        description: 'Returns the first character or characters from a text string, based on the number of characters you specify.',
        syntax: 'LEFT(text, [num_chars])',
        examples: ['LEFT("Sale Price", 4)', 'LEFT(A1)'],
        params: [
            {
                name: 'text',
                type: 'string',
                required: true,
                description: 'The text string that contains the characters you want to extract.'
            },
            {
                name: 'num_chars',
                type: 'number',
                required: false,
                description: 'Specifies the number of characters that you want LEFT to extract. Default is 1.'
            }
        ],
        returnType: 'string'
    };

    minParams: number = 1;
    maxParams: number = 2;

    calculate(...variants: BaseValueObject[]): BaseValueObject {
        this.validateParams(variants);

        const textVal = variants[0];
        if (textVal.isError()) {
            return textVal;
        }

        let numChars = 1;
        if (variants.length === 2) {
            const numCharsVal = variants[1];
            if (numCharsVal.isError()) {
                return numCharsVal;
            }
            numChars = Number(numCharsVal.getValue());
            if (isNaN(numChars) || numChars < 0) {
                return new BaseValueObject(new FormulaError('#VALUE!'));
            }
        }
        
        return new BaseValueObject(String(textVal.getValue()).substring(0, numChars));
    }
}
