import type { MetaField } from '../types'
import {
  formulaCategoryLabel,
  formulaDiagnosticLabel,
  formulaEmptyArgument,
  formulaFieldNameReference,
  formulaFunctionDescription,
  formulaMaxArgs,
  formulaMinArgs,
  formulaUndocumentedFunction,
  formulaUnknownFieldReference,
} from './meta-formula-labels'

export type FormulaFunctionCategory =
  | 'aggregate'
  | 'math'
  | 'operator'
  | 'logic'
  | 'text'
  | 'date'
  | 'lookup'
  | 'statistical'

export interface FormulaFunctionDoc {
  name: string
  signature: string
  category: FormulaFunctionCategory
  description: string
  example: string
  insertText?: string
  minArgs?: number
  maxArgs?: number
}

export interface FormulaFunctionCategoryDoc {
  id: FormulaFunctionCategory
  label: string
  description: string
}

export interface FormulaFunctionCatalogSection {
  category: FormulaFunctionCategory
  label: string
  description: string
  functions: FormulaFunctionDoc[]
}

export interface FormulaDiagnostic {
  severity: 'warning' | 'error'
  message: string
}

export const FORMULA_FUNCTION_CATEGORIES: FormulaFunctionCategoryDoc[] = [
  { id: 'aggregate', label: 'Aggregate', description: 'Summarize numeric or non-empty values.' },
  { id: 'math', label: 'Math', description: 'Round, transform, and compare numbers.' },
  { id: 'operator', label: 'Operators', description: 'Combine values with spreadsheet operators.' },
  { id: 'logic', label: 'Logic', description: 'Branch and combine conditions.' },
  { id: 'text', label: 'Text', description: 'Join, slice, and normalize text.' },
  { id: 'date', label: 'Date', description: 'Create or extract date values.' },
  { id: 'lookup', label: 'Lookup', description: 'Find values from arrays or ranges.' },
  { id: 'statistical', label: 'Statistical', description: 'Calculate distribution helpers.' },
]

export const FORMULA_FUNCTION_DOCS: FormulaFunctionDoc[] = [
  {
    name: 'SUM',
    signature: 'SUM(number, ...)',
    category: 'aggregate',
    description: 'Adds numeric values together.',
    example: '=SUM({fld_price}, {fld_tax})',
    insertText: 'SUM()',
  },
  {
    name: 'AVERAGE',
    signature: 'AVERAGE(number, ...)',
    category: 'aggregate',
    description: 'Returns the arithmetic mean of numeric values.',
    example: '=AVERAGE({fld_score_1}, {fld_score_2})',
    insertText: 'AVERAGE()',
  },
  {
    name: 'COUNT',
    signature: 'COUNT(value, ...)',
    category: 'aggregate',
    description: 'Counts numeric values.',
    example: '=COUNT({fld_score_1}, {fld_score_2})',
    insertText: 'COUNT()',
  },
  {
    name: 'COUNTA',
    signature: 'COUNTA(value, ...)',
    category: 'aggregate',
    description: 'Counts values that are not empty.',
    example: '=COUNTA({fld_name}, {fld_status})',
    insertText: 'COUNTA()',
  },
  {
    name: 'MIN',
    signature: 'MIN(number, ...)',
    category: 'aggregate',
    description: 'Returns the smallest numeric value.',
    example: '=MIN({fld_quote_a}, {fld_quote_b})',
    insertText: 'MIN()',
  },
  {
    name: 'MAX',
    signature: 'MAX(number, ...)',
    category: 'aggregate',
    description: 'Returns the largest numeric value.',
    example: '=MAX({fld_quote_a}, {fld_quote_b})',
    insertText: 'MAX()',
  },
  {
    name: 'ROUND',
    signature: 'ROUND(number, digits)',
    category: 'math',
    description: 'Rounds a number to the requested decimal places.',
    example: '=ROUND({fld_amount}, 2)',
    insertText: 'ROUND(, 2)',
  },
  {
    name: 'CEILING',
    signature: 'CEILING(number)',
    category: 'math',
    description: 'Rounds a number up to the nearest integer.',
    example: '=CEILING({fld_amount})',
    insertText: 'CEILING()',
  },
  {
    name: 'FLOOR',
    signature: 'FLOOR(number)',
    category: 'math',
    description: 'Rounds a number down to the nearest integer.',
    example: '=FLOOR({fld_amount})',
    insertText: 'FLOOR()',
  },
  {
    name: 'POWER',
    signature: 'POWER(number, power)',
    category: 'math',
    description: 'Raises a number to a power.',
    example: '=POWER({fld_base}, 2)',
    insertText: 'POWER(, 2)',
  },
  {
    name: 'SQRT',
    signature: 'SQRT(number)',
    category: 'math',
    description: 'Returns the square root of a number.',
    example: '=SQRT({fld_area})',
    insertText: 'SQRT()',
  },
  {
    name: 'MOD',
    signature: 'MOD(number, divisor)',
    category: 'math',
    description: 'Returns the remainder after division.',
    example: '=MOD({fld_index}, 2)',
    insertText: 'MOD(, )',
  },
  {
    name: 'ABS',
    signature: 'ABS(number)',
    category: 'math',
    description: 'Returns the absolute value of a number.',
    example: '=ABS({fld_delta})',
    insertText: 'ABS()',
  },
  {
    name: 'ADD',
    signature: 'left + right',
    category: 'operator',
    description: 'Adds two numeric values. Text numbers are coerced to numbers.',
    example: '={fld_price} + {fld_tax}',
    insertText: '+',
  },
  {
    name: 'SUBTRACT',
    signature: 'left - right',
    category: 'operator',
    description: 'Subtracts the right numeric value from the left value.',
    example: '={fld_budget} - {fld_actual}',
    insertText: '-',
  },
  {
    name: 'MULTIPLY',
    signature: 'left * right',
    category: 'operator',
    description: 'Multiplies two numeric values.',
    example: '={fld_qty} * {fld_price}',
    insertText: '*',
  },
  {
    name: 'DIVIDE',
    signature: 'left / right',
    category: 'operator',
    description: 'Divides the left numeric value by the right value.',
    example: '={fld_total} / {fld_count}',
    insertText: '/',
  },
  {
    name: 'POWER_OPERATOR',
    signature: 'left ^ right',
    category: 'operator',
    description: 'Raises the left numeric value to the power of the right value.',
    example: '={fld_base} ^ 2',
    insertText: '^',
  },
  {
    name: 'PERCENT_OPERATOR',
    signature: 'value%',
    category: 'operator',
    description: 'Converts a number to a percentage value, for example 50% becomes 0.5.',
    example: '={fld_price} * 10%',
    insertText: '10%',
  },
  {
    name: 'CONCAT_OPERATOR',
    signature: 'left & right',
    category: 'operator',
    description: 'Concatenates values as text.',
    example: '={fld_first_name} & " " & {fld_last_name}',
    insertText: '&',
  },
  {
    name: 'COMPARISON',
    signature: '=, <>, >, >=, <, <=',
    category: 'operator',
    description: 'Compares two values and returns TRUE or FALSE.',
    example: '={fld_amount} >= 1000',
    insertText: '>=',
  },
  {
    name: 'IF',
    signature: 'IF(condition, value_if_true, value_if_false)',
    category: 'logic',
    description: 'Chooses one of two values based on a condition.',
    example: '=IF({fld_amount} > 1000, "Large", "Small")',
    insertText: 'IF(, , )',
  },
  {
    name: 'AND',
    signature: 'AND(condition, ...)',
    category: 'logic',
    description: 'Returns true only when all conditions are true.',
    example: '=AND({fld_status} = "Open", {fld_amount} > 0)',
    insertText: 'AND()',
  },
  {
    name: 'OR',
    signature: 'OR(condition, ...)',
    category: 'logic',
    description: 'Returns true when any condition is true.',
    example: '=OR({fld_status} = "Open", {fld_status} = "Pending")',
    insertText: 'OR()',
  },
  {
    name: 'NOT',
    signature: 'NOT(value)',
    category: 'logic',
    description: 'Reverses a boolean value.',
    example: '=NOT({fld_done})',
    insertText: 'NOT()',
  },
  {
    name: 'TRUE',
    signature: 'TRUE()',
    category: 'logic',
    description: 'Returns the boolean value TRUE.',
    example: '=TRUE()',
    insertText: 'TRUE()',
  },
  {
    name: 'FALSE',
    signature: 'FALSE()',
    category: 'logic',
    description: 'Returns the boolean value FALSE.',
    example: '=FALSE()',
    insertText: 'FALSE()',
  },
  {
    name: 'SWITCH',
    signature: 'SWITCH(value, match, result, ..., default)',
    category: 'logic',
    description: 'Returns the result for the first matching value, with an optional default.',
    example: '=SWITCH({fld_status}, "open", "Open", "closed", "Closed", "Other")',
    insertText: 'SWITCH(, , , )',
  },
  {
    name: 'CONCAT',
    signature: 'CONCAT(text, ...)',
    category: 'text',
    description: 'Joins text values together.',
    example: '=CONCAT({fld_first_name}, " ", {fld_last_name})',
    insertText: 'CONCAT()',
  },
  {
    name: 'CONCATENATE',
    signature: 'CONCATENATE(text, ...)',
    category: 'text',
    description: 'Joins text values together.',
    example: '=CONCATENATE({fld_first_name}, " ", {fld_last_name})',
    insertText: 'CONCATENATE()',
  },
  {
    name: 'LEFT',
    signature: 'LEFT(text, chars)',
    category: 'text',
    description: 'Returns characters from the start of a text value.',
    example: '=LEFT({fld_code}, 3)',
    insertText: 'LEFT(, )',
  },
  {
    name: 'RIGHT',
    signature: 'RIGHT(text, chars)',
    category: 'text',
    description: 'Returns characters from the end of a text value.',
    example: '=RIGHT({fld_code}, 4)',
    insertText: 'RIGHT(, )',
  },
  {
    name: 'MID',
    signature: 'MID(text, start, length)',
    category: 'text',
    description: 'Returns characters from the middle of a text value.',
    example: '=MID({fld_code}, 2, 3)',
    insertText: 'MID(, , )',
  },
  {
    name: 'LEN',
    signature: 'LEN(text)',
    category: 'text',
    description: 'Returns the length of a text value.',
    example: '=LEN({fld_description})',
    insertText: 'LEN()',
  },
  {
    name: 'UPPER',
    signature: 'UPPER(text)',
    category: 'text',
    description: 'Converts text to uppercase.',
    example: '=UPPER({fld_code})',
    insertText: 'UPPER()',
  },
  {
    name: 'LOWER',
    signature: 'LOWER(text)',
    category: 'text',
    description: 'Converts text to lowercase.',
    example: '=LOWER({fld_code})',
    insertText: 'LOWER()',
  },
  {
    name: 'TRIM',
    signature: 'TRIM(text)',
    category: 'text',
    description: 'Removes leading and trailing whitespace from text.',
    example: '=TRIM({fld_name})',
    insertText: 'TRIM()',
  },
  {
    name: 'SUBSTITUTE',
    signature: 'SUBSTITUTE(text, old_text, new_text)',
    category: 'text',
    description: 'Replaces all occurrences of old text with new text.',
    example: '=SUBSTITUTE({fld_code}, "-", "")',
    insertText: 'SUBSTITUTE(, , )',
  },
  {
    name: 'NOW',
    signature: 'NOW()',
    category: 'date',
    description: 'Returns the current date and time.',
    example: '=NOW()',
    insertText: 'NOW()',
  },
  {
    name: 'TODAY',
    signature: 'TODAY()',
    category: 'date',
    description: 'Returns the current date.',
    example: '=TODAY()',
    insertText: 'TODAY()',
  },
  {
    name: 'DATE',
    signature: 'DATE(year, month, day)',
    category: 'date',
    description: 'Creates a date from year, month, and day numbers.',
    example: '=DATE(2026, 5, 5)',
    insertText: 'DATE(, , )',
  },
  {
    name: 'DATEDIF',
    signature: 'DATEDIF(start_date, end_date, unit)',
    category: 'date',
    description: 'Returns the difference between two dates using unit D, M, or Y.',
    example: '=DATEDIF({fld_start_date}, {fld_due_date}, "D")',
    insertText: 'DATEDIF(, , "D")',
  },
  {
    name: 'DATEDIFF',
    signature: 'DATEDIFF(end_date, start_date)',
    category: 'date',
    description: 'Returns the number of days between two dates.',
    example: '=DATEDIFF({fld_due_date}, {fld_start_date})',
    insertText: 'DATEDIFF(, )',
  },
  {
    name: 'YEAR',
    signature: 'YEAR(date)',
    category: 'date',
    description: 'Returns the year from a date value.',
    example: '=YEAR({fld_due_date})',
    insertText: 'YEAR()',
  },
  {
    name: 'MONTH',
    signature: 'MONTH(date)',
    category: 'date',
    description: 'Returns the month from a date value.',
    example: '=MONTH({fld_due_date})',
    insertText: 'MONTH()',
  },
  {
    name: 'DAY',
    signature: 'DAY(date)',
    category: 'date',
    description: 'Returns the day of month from a date value.',
    example: '=DAY({fld_due_date})',
    insertText: 'DAY()',
  },
  {
    name: 'VLOOKUP',
    signature: 'VLOOKUP(value, table, column, approximate)',
    category: 'lookup',
    description: 'Looks up a value in the first column of a table-like range.',
    example: '=VLOOKUP({fld_sku}, {fld_table}, 2, FALSE)',
    insertText: 'VLOOKUP(, , , FALSE)',
  },
  {
    name: 'HLOOKUP',
    signature: 'HLOOKUP(value, table, row, approximate)',
    category: 'lookup',
    description: 'Looks up a value in the first row of a table-like range.',
    example: '=HLOOKUP({fld_month}, {fld_table}, 2, FALSE)',
    insertText: 'HLOOKUP(, , , FALSE)',
  },
  {
    name: 'INDEX',
    signature: 'INDEX(range, row, column)',
    category: 'lookup',
    description: 'Returns a value from a range by row and column position.',
    example: '=INDEX({fld_table}, 2, 1)',
    insertText: 'INDEX(, , )',
  },
  {
    name: 'MATCH',
    signature: 'MATCH(value, range, match_type)',
    category: 'lookup',
    description: 'Returns the position of a value in a range.',
    example: '=MATCH({fld_sku}, {fld_table}, 0)',
    insertText: 'MATCH(, , 0)',
  },
  {
    name: 'RELSUMIF',
    signature: 'RELSUMIF(linkField, targetField, criteriaField, operator, value)',
    category: 'lookup',
    description: 'Sums a foreign field over the linked records matching one criteria (relation-scoped — NOT whole-sheet SUMIF).',
    example: '=RELSUMIF("fld_link", "fld_amount", "fld_status", "is", "paid")',
    insertText: 'RELSUMIF("", "", "", "is", "")',
    minArgs: 5,
    maxArgs: 5,
  },
  {
    name: 'RELAVGIF',
    signature: 'RELAVGIF(linkField, targetField, criteriaField, operator, value)',
    category: 'lookup',
    description: 'Averages a foreign field over the linked records matching one criteria (relation-scoped).',
    example: '=RELAVGIF("fld_link", "fld_amount", "fld_status", "is", "paid")',
    insertText: 'RELAVGIF("", "", "", "is", "")',
    minArgs: 5,
    maxArgs: 5,
  },
  {
    name: 'RELCOUNTIF',
    signature: 'RELCOUNTIF(linkField, criteriaField, operator, value)',
    category: 'lookup',
    description: 'Counts the linked records matching one criteria (relation-scoped; no target field).',
    example: '=RELCOUNTIF("fld_link", "fld_status", "is", "paid")',
    insertText: 'RELCOUNTIF("", "", "is", "")',
    minArgs: 4,
    maxArgs: 4,
  },
  {
    name: 'RELLOOKUP',
    signature: 'RELLOOKUP(linkField, returnField, matchField, operator, value)',
    category: 'lookup',
    description: 'Returns a foreign field from the FIRST linked record matching one criteria; #N/A if none (relation-scoped).',
    example: '=RELLOOKUP("fld_link", "fld_name", "fld_status", "is", "paid")',
    insertText: 'RELLOOKUP("", "", "", "is", "")',
    minArgs: 5,
    maxArgs: 5,
  },
  {
    name: 'RELVALUES',
    signature: 'RELVALUES(linkField, targetField, criteriaField, operator, value)',
    category: 'lookup',
    description: 'Returns the array of a foreign field across the linked records matching one criteria (relation-scoped).',
    example: '=RELVALUES("fld_link", "fld_tag", "fld_status", "is", "paid")',
    insertText: 'RELVALUES("", "", "", "is", "")',
    minArgs: 5,
    maxArgs: 5,
  },
  {
    name: 'STDEV',
    signature: 'STDEV(number, ...)',
    category: 'statistical',
    description: 'Returns the sample standard deviation of numeric values.',
    example: '=STDEV({fld_score_1}, {fld_score_2})',
    insertText: 'STDEV()',
  },
  {
    name: 'VAR',
    signature: 'VAR(number, ...)',
    category: 'statistical',
    description: 'Returns the sample variance of numeric values.',
    example: '=VAR({fld_score_1}, {fld_score_2})',
    insertText: 'VAR()',
  },
  {
    name: 'MEDIAN',
    signature: 'MEDIAN(number, ...)',
    category: 'statistical',
    description: 'Returns the median of numeric values.',
    example: '=MEDIAN({fld_score_1}, {fld_score_2})',
    insertText: 'MEDIAN()',
  },
  {
    name: 'MODE',
    signature: 'MODE(number, ...)',
    category: 'statistical',
    description: 'Returns the most common numeric value.',
    example: '=MODE({fld_score_1}, {fld_score_2})',
    insertText: 'MODE()',
  },
  // ── Capability-depth 1a: scalar function expansion (catalog reconcile — math #2930 + text/date here) ──
  {
    name: 'INT',
    signature: 'INT(number)',
    category: 'math',
    description: 'Rounds a number down to the nearest integer (toward negative infinity).',
    example: '=INT({fld_amount})',
    insertText: 'INT()',
  },
  {
    name: 'TRUNC',
    signature: 'TRUNC(number, [digits])',
    category: 'math',
    description: 'Truncates a number toward zero, optionally to a number of decimals.',
    example: '=TRUNC({fld_amount}, 2)',
    insertText: 'TRUNC()',
  },
  {
    name: 'EXP',
    signature: 'EXP(number)',
    category: 'math',
    description: 'Returns e raised to the given power.',
    example: '=EXP({fld_rate})',
    insertText: 'EXP()',
  },
  {
    name: 'LN',
    signature: 'LN(number)',
    category: 'math',
    description: 'Returns the natural logarithm of a positive number.',
    example: '=LN({fld_value})',
    insertText: 'LN()',
  },
  {
    name: 'LOG',
    signature: 'LOG(number, [base])',
    category: 'math',
    description: 'Returns the logarithm of a number to the given base (default 10).',
    example: '=LOG({fld_value}, 2)',
    insertText: 'LOG()',
  },
  {
    name: 'FIND',
    signature: 'FIND(find_text, within_text, [start])',
    category: 'text',
    description: 'Returns the 1-based position of one text inside another (case-sensitive).',
    example: '=FIND("@", {fld_email})',
    insertText: 'FIND()',
  },
  {
    name: 'SEARCH',
    signature: 'SEARCH(find_text, within_text, [start])',
    category: 'text',
    description: 'Like FIND but case-insensitive.',
    example: '=SEARCH("error", {fld_log})',
    insertText: 'SEARCH()',
  },
  {
    name: 'REPLACE',
    signature: 'REPLACE(text, start, num_chars, new_text)',
    category: 'text',
    description: 'Replaces a span of characters (by position) with new text.',
    example: '=REPLACE({fld_code}, 1, 3, "NEW")',
    insertText: 'REPLACE()',
  },
  {
    name: 'REPT',
    signature: 'REPT(text, count)',
    category: 'text',
    description: 'Repeats text a given number of times.',
    example: '=REPT("*", {fld_score})',
    insertText: 'REPT()',
  },
  {
    name: 'TEXT',
    signature: 'TEXT(value, format)',
    category: 'text',
    description: 'Formats a number as text (percent, fixed decimals, or thousands grouping).',
    example: '=TEXT({fld_ratio}, "0.0%")',
    insertText: 'TEXT()',
  },
  {
    name: 'REGEXMATCH',
    signature: 'REGEXMATCH(text, pattern)',
    category: 'text',
    description: 'Returns true if the text matches the regular expression.',
    example: '=REGEXMATCH({fld_sku}, "^[A-Z]{3}-[0-9]+$")',
    insertText: 'REGEXMATCH()',
  },
  {
    name: 'REGEXEXTRACT',
    signature: 'REGEXEXTRACT(text, pattern)',
    category: 'text',
    description: 'Returns the first match (or first capture group) of the regular expression.',
    example: '=REGEXEXTRACT({fld_url}, "id=([0-9]+)")',
    insertText: 'REGEXEXTRACT()',
  },
  {
    name: 'REGEXREPLACE',
    signature: 'REGEXREPLACE(text, pattern, replacement)',
    category: 'text',
    description: 'Replaces every match of the regular expression with the replacement text.',
    example: '=REGEXREPLACE({fld_phone}, "[^0-9]", "")',
    insertText: 'REGEXREPLACE()',
  },
  {
    name: 'HOUR',
    signature: 'HOUR(datetime)',
    category: 'date',
    description: 'Returns the hour (0–23) of a date-time value.',
    example: '=HOUR({fld_logged_at})',
    insertText: 'HOUR()',
  },
  {
    name: 'MINUTE',
    signature: 'MINUTE(datetime)',
    category: 'date',
    description: 'Returns the minute (0–59) of a date-time value.',
    example: '=MINUTE({fld_logged_at})',
    insertText: 'MINUTE()',
  },
  {
    name: 'DATEADD',
    signature: 'DATEADD(date, count, unit)',
    category: 'date',
    description: 'Adds count units (days/weeks/months/years/hours/minutes/seconds) to a date.',
    example: '=DATEADD({fld_start}, 7, "days")',
    insertText: 'DATEADD()',
  },
  {
    name: 'EOMONTH',
    signature: 'EOMONTH(date, [months])',
    category: 'date',
    description: 'Returns the last day of the month, optionally months forward or back.',
    example: '=EOMONTH({fld_invoice_date}, 1)',
    insertText: 'EOMONTH()',
  },
  {
    name: 'WORKDAY',
    signature: 'WORKDAY(date, days)',
    category: 'date',
    description: 'Returns the date a number of working days away (skips weekends).',
    example: '=WORKDAY({fld_start}, 5)',
    insertText: 'WORKDAY()',
  },
  {
    name: 'WEEKNUM',
    signature: 'WEEKNUM(date)',
    category: 'date',
    description: 'Returns the ISO-8601 week number of a date.',
    example: '=WEEKNUM({fld_date})',
    insertText: 'WEEKNUM()',
  },
]

const FUNCTION_CALL_PATTERN = /\b([A-Z][A-Z0-9_]*)\s*\(/g
const FIELD_REF_PATTERN = /\{([^{}]+)\}/g
const TRAILING_BINARY_OPERATOR_PATTERN = /(?:>=|<=|<>|[+\-*/^&=><])$/
const IDENTIFIER_START_PATTERN = /[A-Za-z_]/
const IDENTIFIER_PART_PATTERN = /[A-Za-z0-9_]/

const FORMULA_FUNCTION_ARITY: Record<string, Pick<FormulaFunctionDoc, 'minArgs' | 'maxArgs'>> = {
  ABS: { minArgs: 1, maxArgs: 1 },
  AND: { minArgs: 1 },
  AVERAGE: { minArgs: 1 },
  CEILING: { minArgs: 1, maxArgs: 1 },
  CONCAT: { minArgs: 1 },
  CONCATENATE: { minArgs: 1 },
  COUNT: { minArgs: 1 },
  COUNTA: { minArgs: 1 },
  DATE: { minArgs: 3, maxArgs: 3 },
  DATEDIF: { minArgs: 3, maxArgs: 3 },
  DATEDIFF: { minArgs: 2, maxArgs: 2 },
  DAY: { minArgs: 1, maxArgs: 1 },
  FALSE: { minArgs: 0, maxArgs: 0 },
  FLOOR: { minArgs: 1, maxArgs: 1 },
  HLOOKUP: { minArgs: 3, maxArgs: 4 },
  IF: { minArgs: 3, maxArgs: 3 },
  INDEX: { minArgs: 2, maxArgs: 3 },
  LEFT: { minArgs: 2, maxArgs: 2 },
  LEN: { minArgs: 1, maxArgs: 1 },
  LOWER: { minArgs: 1, maxArgs: 1 },
  MATCH: { minArgs: 2, maxArgs: 3 },
  MAX: { minArgs: 1 },
  MEDIAN: { minArgs: 1 },
  MID: { minArgs: 3, maxArgs: 3 },
  MIN: { minArgs: 1 },
  MOD: { minArgs: 2, maxArgs: 2 },
  MODE: { minArgs: 1 },
  MONTH: { minArgs: 1, maxArgs: 1 },
  NOT: { minArgs: 1, maxArgs: 1 },
  NOW: { minArgs: 0, maxArgs: 0 },
  OR: { minArgs: 1 },
  POWER: { minArgs: 2, maxArgs: 2 },
  RIGHT: { minArgs: 2, maxArgs: 2 },
  ROUND: { minArgs: 1, maxArgs: 2 },
  SQRT: { minArgs: 1, maxArgs: 1 },
  STDEV: { minArgs: 1 },
  SUBSTITUTE: { minArgs: 3, maxArgs: 3 },
  SUM: { minArgs: 1 },
  SWITCH: { minArgs: 3 },
  TODAY: { minArgs: 0, maxArgs: 0 },
  TRIM: { minArgs: 1, maxArgs: 1 },
  TRUE: { minArgs: 0, maxArgs: 0 },
  UPPER: { minArgs: 1, maxArgs: 1 },
  VAR: { minArgs: 1 },
  VLOOKUP: { minArgs: 3, maxArgs: 4 },
  YEAR: { minArgs: 1, maxArgs: 1 },
}

function localizeFormulaFunctionDoc(doc: FormulaFunctionDoc, isZh: boolean): FormulaFunctionDoc {
  const description = formulaFunctionDescription(doc.name, isZh) || doc.description
  return description === doc.description ? doc : { ...doc, description }
}

export function getFormulaFunctionCategories(isZh = false): FormulaFunctionCategoryDoc[] {
  return FORMULA_FUNCTION_CATEGORIES.map((category) => formulaCategoryLabel(category.id, isZh))
}

export function searchFormulaFunctionDocs(query: string, isZh = false): FormulaFunctionDoc[] {
  const trimmed = query.trim()
  const normalized = trimmed.toUpperCase()
  if (!normalized) return FORMULA_FUNCTION_DOCS.map((doc) => localizeFormulaFunctionDoc(doc, isZh))
  return FORMULA_FUNCTION_DOCS.filter((doc) =>
    doc.name.includes(normalized)
    || doc.signature.toUpperCase().includes(normalized)
    || doc.description.toUpperCase().includes(normalized)
    || (isZh && formulaFunctionDescription(doc.name, true).includes(trimmed)),
  ).map((doc) => localizeFormulaFunctionDoc(doc, isZh))
}

export function getFormulaFunctionCatalog(
  query = '',
  category: FormulaFunctionCategory | 'all' = 'all',
  isZh = false,
): FormulaFunctionCatalogSection[] {
  const docs = searchFormulaFunctionDocs(query, isZh).filter((doc) => category === 'all' || doc.category === category)
  return getFormulaFunctionCategories(isZh)
    .map((categoryDoc) => ({
      category: categoryDoc.id,
      label: categoryDoc.label,
      description: categoryDoc.description,
      functions: docs.filter((doc) => doc.category === categoryDoc.id),
    }))
    .filter((section) => section.functions.length > 0)
}

export function appendFormulaToken(expression: string, token: string): string {
  const current = expression.trimEnd()
  if (!current) return token
  return `${current}${current.endsWith(' ') ? '' : ' '}${token}`
}

export function buildFormulaFieldTokenInsertion(expression: string, fieldId: string): string {
  return appendFormulaToken(expression, `{${fieldId}}`)
}

export function buildFormulaFunctionInsertion(
  expression: string,
  docOrName: FormulaFunctionDoc | string,
): string {
  const token = typeof docOrName === 'string'
    ? `${docOrName.toUpperCase()}()`
    : (docOrName.insertText ?? `${docOrName.name}()`)
  const normalizedToken = expression.trim() ? token : `=${token}`
  return appendFormulaToken(expression, normalizedToken)
}

export function extractFormulaFieldRefs(expression: string): string[] {
  const refs: string[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null
  FIELD_REF_PATTERN.lastIndex = 0
  while ((match = FIELD_REF_PATTERN.exec(expression)) !== null) {
    const ref = match[1]?.trim()
    if (ref && !seen.has(ref)) {
      seen.add(ref)
      refs.push(ref)
    }
  }
  return refs
}

function getFormulaSyntaxDiagnostics(expression: string, isZh: boolean): FormulaDiagnostic[] {
  const diagnostics: FormulaDiagnostic[] = []
  let parenthesesDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let inQuotes = false
  let escaped = false

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i]

    if (inQuotes) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inQuotes = false
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }

    if (char === '(') {
      parenthesesDepth++
      continue
    }
    if (char === ')') {
      if (parenthesesDepth === 0) {
        diagnostics.push({ severity: 'error', message: formulaDiagnosticLabel('diagnostic.unexpectedClosingParenthesis', isZh) })
      } else {
        parenthesesDepth--
      }
      continue
    }

    if (char === '[') {
      bracketDepth++
      continue
    }
    if (char === ']') {
      if (bracketDepth === 0) {
        diagnostics.push({ severity: 'error', message: formulaDiagnosticLabel('diagnostic.unexpectedClosingArrayBracket', isZh) })
      } else {
        bracketDepth--
      }
      continue
    }

    if (char === '{') {
      braceDepth++
      continue
    }
    if (char === '}') {
      if (braceDepth === 0) {
        diagnostics.push({ severity: 'error', message: formulaDiagnosticLabel('diagnostic.unexpectedClosingFieldReferenceBrace', isZh) })
      } else {
        braceDepth--
      }
    }
  }

  if (inQuotes) {
    diagnostics.push({ severity: 'error', message: formulaDiagnosticLabel('diagnostic.quotedStringNotClosed', isZh) })
  }
  if (parenthesesDepth > 0) {
    diagnostics.push({ severity: 'error', message: formulaDiagnosticLabel('diagnostic.parenthesesNotBalanced', isZh) })
  }
  if (bracketDepth > 0) {
    diagnostics.push({ severity: 'error', message: formulaDiagnosticLabel('diagnostic.arrayBracketsNotBalanced', isZh) })
  }
  if (braceDepth > 0) {
    diagnostics.push({ severity: 'error', message: formulaDiagnosticLabel('diagnostic.fieldReferenceBracesNotBalanced', isZh) })
  }

  const withoutWhitespace = expression.trimEnd()
  if (TRAILING_BINARY_OPERATOR_PATTERN.test(withoutWhitespace)) {
    diagnostics.push({ severity: 'error', message: formulaDiagnosticLabel('diagnostic.trailingBinaryOperator', isZh) })
  }

  return diagnostics
}

interface ParsedFormulaFunctionCall {
  name: string
  args: string[]
}

function findClosingParenthesis(expression: string, openIndex: number): number | null {
  let depth = 0
  let inQuotes = false
  let escaped = false

  for (let i = openIndex; i < expression.length; i++) {
    const char = expression[i]

    if (inQuotes) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inQuotes = false
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === '(') {
      depth++
      continue
    }
    if (char === ')') {
      depth--
      if (depth === 0) return i
    }
  }

  return null
}

function splitFormulaArguments(source: string): string[] {
  if (!source.trim()) return []

  const args: string[] = []
  let current = ''
  let parenthesesDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let inQuotes = false
  let escaped = false

  for (let i = 0; i < source.length; i++) {
    const char = source[i]

    if (inQuotes) {
      current += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inQuotes = false
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      current += char
      continue
    }
    if (char === '(') {
      parenthesesDepth++
      current += char
      continue
    }
    if (char === ')') {
      parenthesesDepth = Math.max(0, parenthesesDepth - 1)
      current += char
      continue
    }
    if (char === '[') {
      bracketDepth++
      current += char
      continue
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
      current += char
      continue
    }
    if (char === '{') {
      braceDepth++
      current += char
      continue
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      current += char
      continue
    }

    if (char === ',' && parenthesesDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      args.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  args.push(current.trim())
  return args
}

function collectFormulaFunctionCalls(expression: string): ParsedFormulaFunctionCall[] {
  const calls: ParsedFormulaFunctionCall[] = []
  let inQuotes = false
  let escaped = false

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i]

    if (inQuotes) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inQuotes = false
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }

    if (!IDENTIFIER_START_PATTERN.test(char)) continue

    const start = i
    i++
    while (i < expression.length && IDENTIFIER_PART_PATTERN.test(expression[i] ?? '')) {
      i++
    }

    const rawName = expression.slice(start, i)
    let cursor = i
    while (cursor < expression.length && /\s/.test(expression[cursor] ?? '')) {
      cursor++
    }
    if (expression[cursor] !== '(') {
      i--
      continue
    }

    const closeIndex = findClosingParenthesis(expression, cursor)
    if (closeIndex === null) {
      i--
      continue
    }

    const argsSource = expression.slice(cursor + 1, closeIndex)
    const args = splitFormulaArguments(argsSource)
    calls.push({ name: rawName.toUpperCase(), args })
    calls.push(...collectFormulaFunctionCalls(argsSource))
    i = closeIndex
  }

  return calls
}

function getFormulaFunctionArgumentDiagnostics(expression: string, isZh: boolean): FormulaDiagnostic[] {
  const diagnostics: FormulaDiagnostic[] = []
  const knownFunctions = new Set(FORMULA_FUNCTION_DOCS.map((doc) => doc.name))
  for (const call of collectFormulaFunctionCalls(expression)) {
    if (!knownFunctions.has(call.name)) continue

    const emptyArgument = call.args.some((arg) => !arg)
    if (emptyArgument) {
      diagnostics.push({ severity: 'error', message: formulaEmptyArgument(call.name, isZh) })
      continue
    }

    const arity = FORMULA_FUNCTION_ARITY[call.name]
    if (!arity) continue

    if (typeof arity.minArgs === 'number' && call.args.length < arity.minArgs) {
      diagnostics.push({
        severity: 'error',
        message: formulaMinArgs(call.name, arity.minArgs, isZh),
      })
      continue
    }

    if (typeof arity.maxArgs === 'number' && call.args.length > arity.maxArgs) {
      diagnostics.push({
        severity: 'error',
        message: formulaMaxArgs(call.name, arity.maxArgs, isZh),
      })
    }
  }

  return diagnostics
}

export function validateFormulaExpression(expression: string, fields: MetaField[], isZh = false): FormulaDiagnostic[] {
  const diagnostics: FormulaDiagnostic[] = []
  const trimmed = expression.trim()
  if (!trimmed) {
    diagnostics.push({ severity: 'warning', message: formulaDiagnosticLabel('diagnostic.emptyExpression', isZh) })
    return diagnostics
  }

  diagnostics.push(...getFormulaSyntaxDiagnostics(trimmed, isZh))
  diagnostics.push(...getFormulaFunctionArgumentDiagnostics(trimmed, isZh))

  const fieldIds = new Set(fields.map((field) => field.id))
  const fieldNames = new Set(fields.map((field) => field.name))
  for (const ref of extractFormulaFieldRefs(trimmed)) {
    if (fieldIds.has(ref)) continue
    if (fieldNames.has(ref)) {
      diagnostics.push({
        severity: 'warning',
        message: formulaFieldNameReference(ref, isZh),
      })
      continue
    }
    diagnostics.push({ severity: 'error', message: formulaUnknownFieldReference(ref, isZh) })
  }

  const knownFunctions = new Set(FORMULA_FUNCTION_DOCS.map((doc) => doc.name))
  let match: RegExpExecArray | null
  FUNCTION_CALL_PATTERN.lastIndex = 0
  while ((match = FUNCTION_CALL_PATTERN.exec(trimmed.toUpperCase())) !== null) {
    const fn = match[1]
    if (fn && !knownFunctions.has(fn)) {
      diagnostics.push({ severity: 'warning', message: formulaUndocumentedFunction(fn, isZh) })
    }
  }

  return diagnostics
}
