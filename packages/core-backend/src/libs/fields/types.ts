import { FieldType as CoreFieldType } from '../../types/collection';

export { CoreFieldType as FieldType };

export enum BasicValueType {
  String = 'String',
  Number = 'Number',
  Boolean = 'Boolean',
  DateTime = 'DateTime',
  Array = 'Array',
}

export enum FOperator {
  Is = 'is',
  IsNot = 'isNot',
  Contains = 'contains',
  DoesNotContain = 'doesNotContain',
  IsEmpty = 'isEmpty',
  IsNotEmpty = 'isNotEmpty',
  IsRepeat = 'isRepeat',
  Greater = 'greater',
  GreaterEqual = 'greaterEqual',
  Less = 'less',
  LessEqual = 'lessEqual',
  Equal = 'equal',
  NotEqual = 'notEqual',
  IsGreater = 'isGreater',
  IsGreaterEqual = 'isGreaterEqual',
  IsLess = 'isLess',
  IsLessEqual = 'isLessEqual',
}

export enum StatType {
  None = 'None',
  CountAll = 'CountAll',
  Empty = 'Empty',
  Filled = 'Filled',
  Unique = 'Unique',
  PercentEmpty = 'PercentEmpty',
  PercentFilled = 'PercentFilled',
  PercentUnique = 'PercentUnique',
  Sum = 'Sum',
  Average = 'Average',
  Min = 'Min',
  Max = 'Max',
}

export interface IFieldProperty {
  [key: string]: any;
}

export interface IField {
  id: string;
  name: string;
  type: CoreFieldType;
  property: IFieldProperty;
  desc?: string;
  required?: boolean;
}

export type ICellValue = any;

export interface IStandardValue {
  sourceType: CoreFieldType;
  data: any[];
}

export interface IJsonSchema {
  type: string;
  title?: string;
  properties?: { [key: string]: IJsonSchema };
  items?: IJsonSchema;
}

export interface IFilterCondition {
  fieldId: string;
  operator: FOperator;
  value: any;
  fieldType?: CoreFieldType;
}

export enum SegmentType {
  Text = 0,
  Link = 1,
}

export interface ISegment {
  type: SegmentType;
  text: string;
  link?: string;
}

export enum SymbolAlign {

  left = 'left',

  right = 'right',

}



export enum FilterConjunction {

  And = 'and',

  Or = 'or',

}



export interface IFilterInfo {

  conjunction: FilterConjunction;

  conditions: IFilterCondition[];

}



export interface ISortInfo {

  keepSort?: boolean;

  rules: ISortRule[];

}



export interface ISortRule {

  fieldId: string;

  desc: boolean;

}



export interface IGroupInfo {

  fieldId: string;

  desc: boolean;

}
