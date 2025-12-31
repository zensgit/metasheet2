
import { IConditionFormattingRule } from '../libs/conditional-formatting/types';
import { RuleEvaluator } from '../libs/conditional-formatting/evaluator';

export class ConditionalFormattingService {
    private rulesMap = new Map<string, IConditionFormattingRule[]>();

    public addRule(spreadsheetId: string, rule: IConditionFormattingRule) {
        const rules = this.rulesMap.get(spreadsheetId) || [];
        rules.push(rule);
        this.rulesMap.set(spreadsheetId, rules);
    }

    public getRules(spreadsheetId: string): IConditionFormattingRule[] {
        return this.rulesMap.get(spreadsheetId) || [];
    }

    /**
     * Evaluates all rules for a given cell and returns the style of the first matching rule.
     */
    public getCellStyle(spreadsheetId: string, row: number, col: number, value: any): any | null {
        const rules = this.getRules(spreadsheetId);
        
        for (const rule of rules) {
            // Check if cell is in range
            const inRange = rule.ranges.some(r => 
                row >= r.startRow && row <= r.endRow && 
                col >= r.startCol && col <= r.endCol
            );

            if (inRange) {
                const isMatch = RuleEvaluator.evaluate(value, rule.rule);
                if (isMatch) {
                    // Return style (e.g. background color)
                    return (rule.rule as any).style;
                }
            }
        }
        return null;
    }
}
