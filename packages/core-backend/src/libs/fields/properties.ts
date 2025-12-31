
// Currency field properties
export interface CurrencyFieldProperty {
  precision: number;           // Decimal places (0-4)
  symbol: string;              // Currency symbol ($, ¥, €, etc.)
  symbolPosition: 'prefix' | 'suffix';
}

// Rating field properties
export interface RatingFieldProperty {
  max: number;                 // Maximum value (default 5)
  icon: 'star' | 'heart' | 'thumbs' | 'flag';
}

// Percent field properties
export interface PercentFieldProperty {
  precision: number;           // Decimal places (0-4)
}

// Phone field properties
export interface PhoneFieldProperty {
  format?: string;             // Format template
  defaultCountryCode?: string; // Default country code
}

// Email field properties (no special properties, only validation)
export interface EmailFieldProperty {}

// URL field properties
export interface URLFieldProperty {
  displayAs: 'link' | 'button' | 'preview';
}

// Member field properties
export interface MemberFieldProperty {
  allowMultiple: boolean;      // Allow multiple selection
  notifyOnAssign: boolean;     // Notify on assignment
  scope: 'workspace' | 'team' | 'all'; // Scope
}

// AutoNumber properties
export interface AutoNumberFieldProperty {
  prefix?: string;             // Prefix (e.g., "INV-")
  startNumber: number;         // Starting number
  digits: number;              // Number of digits (padding with zeros)
}

// Rollup aggregate field properties
export interface RollupFieldProperty {
  linkedFieldId: string;       // Linked Link field
  targetFieldId: string;       // Target field in the linked table
  aggregation: 'sum' | 'avg' | 'count' | 'counta' | 'min' | 'max' |
               'and' | 'or' | 'xor' | 'concatenate' | 'arrayunique' | 'arraycompact';
}

// Button field properties
export interface ButtonFieldProperty {
  label: string;               // Button text
  color: string;               // Button color
  action: {
    type: 'openUrl' | 'runAutomation' | 'openRecord' | 'copyValue';
    config: Record<string, any>;
  };
}
