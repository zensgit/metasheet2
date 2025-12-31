
import { SymbolAlign } from './types';

// Convert string to number
export function str2number(value: string): number | null {
  if (value == null || value.trim() === '') {
    return null;
  }
  const num = Number(value);
  return num2number(num);
}

export function num2number(num: number): number | null {
  if (num == null || !Number.isFinite(num)) {
    return null;
  }
  return numberSpecification(num.toString());
}

function e2number(value: string): string {
  const val = value.split('e') as [string, string];
  const p = parseInt(val[1], 10);
  if (p === 0) return val[0];

  const num = val[0].split('.');
  const dotLeft: string = num[0]!;
  const dotRight: string = num[1] || '';

  if (p > 0) {
    value = dotLeft + dotRight.substr(0, p) +
      (dotRight.length > p ? '.' + dotRight.substr(p) : '0'.repeat(p - dotRight.length));
  } else {
    const left = parseInt(dotLeft, 10);
    value = (left < 0 ? '-0.' : '0.') + '0'.repeat(-p - 1) + Math.abs(left) + dotRight;
  }

  return value;
}

export function numberSpecification(value: string) {
  if (value.includes('e')) {
    value = e2number(value);
  }
  const str = value.replace('.', '').replace('-', '').replace(/^[0]+/, '');
  const len = str.length;

  const demarcationLen = 15;
  if (len > demarcationLen) {
    let isNegative = 0; 
    if (Number(value) < 0) {
      isNegative = 1;
    }
    const valLen = value.length - isNegative;
    if (valLen === len) {
      value = value.substr(0, demarcationLen + isNegative) + '0'.repeat(len - demarcationLen);
    } else if (valLen === len + 1) {
      const dotIndex = value.indexOf('.') - isNegative;
      if (dotIndex > demarcationLen) {
        value = value.substr(0, demarcationLen + isNegative) + '0'.repeat(dotIndex - demarcationLen);
      } else if (dotIndex === demarcationLen) {
        value = value.substr(0, demarcationLen + isNegative);
      } else {
        value = value.substr(0, demarcationLen + isNegative + 1);
      }
    } else {
      value = (isNegative > 0 ? '-0.' : '0.') + '0'.repeat(valLen - len - 2) + str.substr(0, demarcationLen);
    }
  }
  return Number(value);
}

export function str2NumericStr(input: string | null): string | null {
  if (input == null || input === '') {
    return null;
  }

  const regNumber = /[^0-9\.e+-]/g;
  const regSymbol = /(\+|\-|\.)+/g;
  let tempStr: string | null = (input + '').trim();

  tempStr = tempStr.replace(regNumber, '');
  tempStr = tempStr.replace(regSymbol, '$1');

  const result = parseFloat(tempStr);

  if (!result && result !== 0) {
    return null;
  }
  return result.toString();
}

export const toFixed = function (value: number, precision = 0): string {
  if (isNaN(value)) return '0';
  const that = Math.abs(value);
  let changenum;
  let index;

  if (precision < 0) precision = 0;
  changenum = that * Math.pow(10, precision) + 0.5;
  changenum = (parseInt(String(changenum), 10) / Math.pow(10, precision)).toString();
  index = changenum.indexOf('.');
  if (index < 0 && precision > 0) {
    changenum = changenum + '.' + '0'.repeat(precision);
  } else {
    index = precision - changenum.length + index + 1;
    if (index < 0) index = 0;
    changenum = changenum + '0'.repeat(index);
  }

  if (value < 0) {
    return '-' + changenum;
  }
  return changenum;
};

export function numberToShow(value: number, precision = 0): string | null {
  value = Number(value);
  if (isNaN(value)) {
    return 'NaN';
  }

  if (value === Infinity) {
    return 'Infinity';
  }

  let str = value.toString();

  const integerCount = str.split('.')[0]!.length;
  const demarcationLen = 17;
  if (integerCount >= demarcationLen || (str.includes('e') && !str.includes('e-'))) {
    const significanceDigitCount = 5;
    str = value.toExponential(significanceDigitCount);
  } else {
    str = toFixed(value, precision);
  }

  return str;
}

export function str2Currency(
  input: string | null,
  symbol: string = '',
  digits: number = 3,
  splitter: string = ',',
  symbolAlign = SymbolAlign.right,
): string | null {
  let tempStr = ('' + input).trim();
  let sign = '';

  if (input == null || tempStr === '') {
    return null;
  }
  if (tempStr.startsWith('-')) {
    sign = '-';
    tempStr = tempStr.substring(1);
  }
  if (tempStr.includes('e')) {
    if (symbolAlign === SymbolAlign.right) {
      return `${sign}${tempStr}${symbol}`;
    }
    return `${sign}${symbol}${tempStr}`;
  }
  if (!tempStr.includes('.')) {
    tempStr += '.';
  }

  const regExp = new RegExp(`(\\d)(?=(\\d{${digits}})+\\.)`, 'g');

  tempStr = tempStr.replace(regExp, function(_$0: string, $1: any) {
    return $1 + splitter;
  }).replace(/\.$/, '');
  if (!tempStr) {
    return null;
  }

  if (symbolAlign === SymbolAlign.right) {
    return `${sign}${tempStr}${symbol}`;
  }
  return `${sign}${symbol}${tempStr}`;
}

// Math precision helpers
export function strip(num: number, precision = 15): number {
  return parseFloat(Number(num).toPrecision(precision));
}

export function digitLength(num: number): number {
  const eSplit = num.toString().split(/[eE]/);
  const dLen = (eSplit[0]!.split('.')[1] || '').length;
  const power = Number(eSplit[1]) || 0;
  const len = dLen - power;
  return len > 0 ? len : 0;
}

export function float2Fixed(num: number): number {
  if (num.toString().indexOf('e') === -1) {
    return Number(num.toString().replace('.', ''));
  }
  const dLen = digitLength(num);
  return dLen > 0 ? strip(Number(num) * Math.pow(10, dLen)) : Number(num);
}

export function times(num1: number, num2: number): number {
  const intNum1 = float2Fixed(num1);
  const intNum2 = float2Fixed(num2);
  const baseNum = digitLength(num1) + digitLength(num2);
  const dividend = intNum1 * intNum2;
  return dividend / Math.pow(10, baseNum);
}

export function divide(num1: number, num2: number): number {
  const intNum1 = float2Fixed(num1);
  const intNum2 = float2Fixed(num2);
  const baseNum = digitLength(num2) - digitLength(num1);
  const dividend = intNum1 / intNum2;
  return times(dividend, strip(Math.pow(10, baseNum)));
}

export function plus(num1: number, num2: number): number {
  const baseNum = Math.pow(10, Math.max(digitLength(num1), digitLength(num2)));
  return (times(num1, baseNum) + times(num2, baseNum)) / baseNum;
}

export function minus(num1: number, num2: number): number {
  const baseNum = Math.pow(10, Math.max(digitLength(num1), digitLength(num2)));
  return (times(num1, baseNum) - times(num2, baseNum)) / baseNum;
}
