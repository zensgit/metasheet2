
import { ACL } from './acl';

export type ConditionFunc = (context: any) => Promise<boolean> | boolean;

export class AllowManager {
  protected skipActions = new Map<string, Map<string, string | ConditionFunc | true>>();
  protected registeredCondition = new Map<string, ConditionFunc>();

  constructor(public acl: ACL) {
    this.registerAllowCondition('loggedIn', (ctx: any) => {
      return !!ctx?.user;
    });

    this.registerAllowCondition('public', () => {
      return true;
    });
  }

  allow(resourceName: string, actionName: string, condition?: string | ConditionFunc) {
    const actionMap = this.skipActions.get(resourceName) || new Map<string, string | ConditionFunc>();
    actionMap.set(actionName, condition || true);
    this.skipActions.set(resourceName, actionMap);
  }

  getAllowedConditions(resourceName: string, actionName: string): Array<ConditionFunc | true> {
    const fetchActionSteps: string[] = ['*', resourceName];
    const results: Array<ConditionFunc | true> = [];

    for (const fetchActionStep of fetchActionSteps) {
      const resource = this.skipActions.get(fetchActionStep);
      if (resource) {
        for (const actionStep of ['*', actionName]) {
          const condition = resource.get(actionStep);
          if (condition) {
             if (typeof condition === 'string') {
                 const registered = this.registeredCondition.get(condition);
                 if(registered) results.push(registered);
             } else {
                 results.push(condition as any);
             }
          }
        }
      }
    }

    return results;
  }

  registerAllowCondition(name: string, condition: ConditionFunc) {
    this.registeredCondition.set(name, condition);
  }

  async isAllowed(resourceName: string, actionName: string, ctx: any) {
    const skippedConditions = this.getAllowedConditions(resourceName, actionName);

    for (const skippedCondition of skippedConditions) {
      if (skippedCondition) {
        let skipResult = false;
        if (typeof skippedCondition === 'function') {
          skipResult = await skippedCondition(ctx);
        } else if (skippedCondition === true) {
          skipResult = true;
        }

        if (skipResult) {
          return true;
        }
      }
    }

    return false;
  }
}
