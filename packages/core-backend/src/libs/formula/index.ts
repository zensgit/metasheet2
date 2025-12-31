import { BaseFunction } from './base';
// Import Math functions
import { Sum } from './functions/math/sum';
import { Abs } from './functions/math/abs';
import { Average } from './functions/math/average';
import { Count } from './functions/math/count';
import { Max } from './functions/math/max';
import { Min } from './functions/math/min';
import { Round } from './functions/math/round';

// Import Text functions
import { Concatenate } from './functions/text/concatenate';
import { Len } from './functions/text/len';
import { Left } from './functions/text/left';
import { Right } from './functions/text/right';

// Import Logical functions
import { If } from './functions/logical/if';
import { And } from './functions/logical/and';
import { Or } from './functions/logical/or';


// Define a list of all function classes to register
const FUNCTION_CLASSES: (new () => BaseFunction)[] = [
    Sum,
    Abs,
    Average,
    Count,
    Max,
    Min,
    Round,

    // Text functions
    Concatenate,
    Len,
    Left,
    Right,

    // Logical functions
    If,
    And,
    Or,

    // Future functions will be added here
];

export const FunctionRegistry: Record<string, BaseFunction> = {};

FUNCTION_CLASSES.forEach(FuncClass => {
    const funcInstance = new FuncClass();
    FunctionRegistry[funcInstance.meta.name.toUpperCase()] = funcInstance;
});

export type FunctionName = keyof typeof FunctionRegistry;
