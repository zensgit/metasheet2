export class FormulaError extends Error {
    constructor(public type: string) {
        super(type);
    }
}

export class BaseValueObject {
    constructor(private value: any) {}

    getValue(): any {
        return this.value;
    }

    isString(): boolean {
        return typeof this.value === 'string';
    }

    isNumber(): boolean {
        return typeof this.value === 'number' && !isNaN(this.value);
    }

    isBoolean(): boolean {
        return typeof this.value === 'boolean';
    }

    isArray(): boolean {
        return Array.isArray(this.value);
    }

    isError(): boolean {
        return this.value instanceof Error;
    }

    convertToNumberObjectValue(): BaseValueObject {
        const num = Number(this.value);
        if (isNaN(num)) {
            return new BaseValueObject(new FormulaError('#VALUE!'));
        }
        return new BaseValueObject(num);
    }

    abs(): BaseValueObject {
        if (this.isError()) return this;
        return new BaseValueObject(Math.abs(this.value));
    }

    plus(other: BaseValueObject): BaseValueObject {
        if (this.isError()) return this;
        if (other.isError()) return other;
        return new BaseValueObject(Number(this.value) + Number(other.getValue()));
    }

    sum(): BaseValueObject {
        if (!this.isArray()) return this;
        let sum = 0;
        for (const item of this.value) {
            const num = Number(item);
            if (!isNaN(num)) {
                sum += num;
            }
        }
        return new BaseValueObject(sum);
    }

    static create(value: any): BaseValueObject {
        return new BaseValueObject(value);
    }
}

export interface FunctionMeta {
  name: string;
  category: 'math' | 'text' | 'datetime' | 'logical' | 'lookup' | 'array' | 'aggregate';
  description: string;
  syntax?: string;
  examples?: string[];
  params?: Array<{
    name: string;
    type?: string;
    required?: boolean;
    description?: string;
  }>;
  returnType?: string;
}

export abstract class BaseFunction {
    abstract meta: FunctionMeta;
    abstract minParams: number;
    abstract maxParams: number;
    abstract calculate(...variants: BaseValueObject[]): BaseValueObject;

    protected validateParams(params: BaseValueObject[]): void {
        if (params.length < this.minParams) {
            throw new FormulaError(`#ARG! ${this.meta.name} requires at least ${this.minParams} arguments`);
        }
        if (params.length > this.maxParams) {
            throw new FormulaError(`#ARG! ${this.meta.name} accepts at most ${this.maxParams} arguments`);
        }
    }
}
