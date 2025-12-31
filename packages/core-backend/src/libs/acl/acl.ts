
import lodash from 'lodash';
import { ACLRole, ResourceActionsOptions, RoleActionParams } from './acl-role';
import { AllowManager, ConditionFunc } from './allow-manager';

export interface CanResult {
  role: string;
  resource: string;
  action: string;
  params?: any;
}

export interface DefineOptions {
  role: string;
  actions?: ResourceActionsOptions;
}

interface CanArgs {
  role?: string;
  resource: string;
  action: string;
  roles?: string[];
}

export class ACL {
  public allowManager = new AllowManager(this);
  roles = new Map<string, ACLRole>();

  constructor() {}

  define(options: DefineOptions): ACLRole {
    const roleName = options.role;
    const role = new ACLRole(this, roleName);
    const actions = options.actions || {};

    for (const [actionName, actionParams] of Object.entries(actions)) {
      role.grantAction(actionName, actionParams);
    }
    this.roles.set(roleName, role);
    return role;
  }

  getRole(name: string): ACLRole | undefined {
    return this.roles.get(name);
  }

  can(options: CanArgs): CanResult | null {
    if (options.role) {
      return lodash.cloneDeep(this.getCanByRole(options));
    }
    if (options.roles?.length) {
      // Simplified: Just check first allowed role
      for (const role of options.roles) {
         const result = this.getCanByRole({ ...options, role });
         if (result) return lodash.cloneDeep(result);
      }
    }
    return null;
  }

  private getCanByRole(options: CanArgs) {
    const { role, resource, action } = options;
    const aclRole = this.roles.get(role!);

    if (!aclRole) {
      return null;
    }

    const aclResource = aclRole.getResource(resource);
    if (aclResource) {
      const actionParams = aclResource.getAction(action);
      if (actionParams) {
        return {
          role: role!,
          resource,
          action,
          params: actionParams,
        };
      }
    }
    return null;
  }

  allow(resourceName: string, actionNames: string[] | string, condition?: string | ConditionFunc) {
    if (!Array.isArray(actionNames)) {
      actionNames = [actionNames];
    }
    for (const actionName of actionNames) {
      this.allowManager.allow(resourceName, actionName, condition);
    }
  }
}
