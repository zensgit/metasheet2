
export enum CFRuleType {
    highlightCell = 'highlightCell',
    dataBar = 'dataBar',
    colorScale = 'colorScale',
    iconSet = 'iconSet',
}

export enum CFSubRuleType {
    uniqueValues = 'uniqueValues',
    duplicateValues = 'duplicateValues',
    rank = 'rank',
    text = 'text',
    timePeriod = 'timePeriod',
    number = 'number',
    average = 'average',
    formula = 'formula',
}

export enum CFNumberOperator {
    greaterThan = 'greaterThan',
    greaterThanOrEqual = 'greaterThanOrEqual',
    lessThan = 'lessThan',
    lessThanOrEqual = 'lessThanOrEqual',
    notBetween = 'notBetween',
    between = 'between',
    equal = 'equal',
    notEqual = 'notEqual',
}

export enum CFTextOperator {
    beginsWith = 'beginsWith',
    endsWith = 'endsWith',
    containsText = 'containsText',
    notContainsText = 'notContainsText',
    equal = 'equal',
    notEqual = 'notEqual',
}

export interface IStyleBase {
    bg?: { rgb: string };
    cl?: { rgb: string }; // font color
    // Add other style properties as needed
}

export interface IBaseCfRule {
    type: string;
}

export interface IHighlightCell extends IBaseCfRule {
    type: CFRuleType.highlightCell;
    subType: CFSubRuleType;
    style: IStyleBase;
}

export interface INumberHighlightCell extends IHighlightCell {
    subType: CFSubRuleType.number;
    operator: CFNumberOperator;
    value?: number | [number, number];
}

export interface ITextHighlightCell extends IHighlightCell {
    subType: CFSubRuleType.text;
    operator: CFTextOperator;
    value?: string;
}

// Simplified Range for backend
export interface IRange {
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
}

export type ICFRuleConfig = INumberHighlightCell | ITextHighlightCell; 

export interface IConditionFormattingRule {
    cfId: string;
    ranges: IRange[];
    stopIfTrue: boolean;
    rule: ICFRuleConfig;
}
