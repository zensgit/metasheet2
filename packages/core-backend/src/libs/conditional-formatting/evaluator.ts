
import { CFNumberOperator, CFTextOperator, CFSubRuleType, ICFRuleConfig, IConditionFormattingRule } from './types';

export class RuleEvaluator {
    
    public static evaluate(value: any, ruleConfig: ICFRuleConfig): boolean {
        switch (ruleConfig.subType) {
            case CFSubRuleType.number:
                return this.evaluateNumber(value, ruleConfig as any);
            case CFSubRuleType.text:
                return this.evaluateText(value, ruleConfig as any);
            default:
                return false;
        }
    }

    private static evaluateNumber(value: any, rule: { operator: CFNumberOperator, value: number | [number, number] }): boolean {
        const numValue = Number(value);
        if (isNaN(numValue)) return false;

        const target = rule.value;

        switch (rule.operator) {
            case CFNumberOperator.greaterThan:
                return numValue > (target as number);
            case CFNumberOperator.greaterThanOrEqual:
                return numValue >= (target as number);
            case CFNumberOperator.lessThan:
                return numValue < (target as number);
            case CFNumberOperator.lessThanOrEqual:
                return numValue <= (target as number);
            case CFNumberOperator.equal:
                return numValue === (target as number);
            case CFNumberOperator.notEqual:
                return numValue !== (target as number);
            case CFNumberOperator.between:
                return Array.isArray(target) && numValue >= target[0] && numValue <= target[1];
            case CFNumberOperator.notBetween:
                return Array.isArray(target) && (numValue < target[0] || numValue > target[1]);
            default:
                return false;
        }
    }

    private static evaluateText(value: any, rule: { operator: CFTextOperator, value: string }): boolean {
        const strValue = String(value || '');
        const target = rule.value || '';

        switch (rule.operator) {
            case CFTextOperator.containsText:
                return strValue.includes(target);
            case CFTextOperator.notContainsText:
                return !strValue.includes(target);
            case CFTextOperator.beginsWith:
                return strValue.startsWith(target);
            case CFTextOperator.endsWith:
                return strValue.endsWith(target);
            case CFTextOperator.equal:
                return strValue === target;
            case CFTextOperator.notEqual:
                return strValue !== target;
            default:
                return false;
        }
    }
}
