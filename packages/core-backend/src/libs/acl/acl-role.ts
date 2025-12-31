
import { ACL, DefineOptions } from './acl';
import lodash from 'lodash';

export interface RoleActionParams {
  fields?: string[];
  filter?: any;
  own?: boolean;
  whitelist?: string[];
  blacklist?: string[];
  [key: string]: any;
}

export interface ResourceActionsOptions {
  [actionName: string]: RoleActionParams;
}

export type ResourceActions = { [key: string]: RoleActionParams };

export class ACLRole {
  resources = new Map<string, ACLResource>();
  snippets: Set<string> = new Set();
  
  constructor(
    public acl: ACL,
    public name: string,
  ) {}

  getResource(name: string): ACLResource | undefined {
    return this.resources.get(name);
  }

  public grantAction(path: string, options?: RoleActionParams) {
    const { resourceName, actionName } = this.getResourceActionFromPath(path);
    let resource = this.getResource(resourceName);

    if (!resource) {
      resource = new ACLResource({
        role: this,
        name: resourceName,
      });
      this.resources.set(resourceName, resource);
    }

    resource.setAction(actionName, options || {});
  }

  public getActionParams(path: string): RoleActionParams | null {
    const { action } = this.getResourceActionFromPath(path);
    return action;
  }

  protected getResourceActionFromPath(path: string) {
    const [resourceName, actionName] = path.split(':');
    const resource = this.resources.get(resourceName);
    let action = null;

    if (resource) {
      action = resource.getAction(actionName);
    }

    return {
      resourceName,
      actionName,
      resource,
      action,
    };
  }
}

interface AclResourceOptions {
  name: string;
  role: ACLRole;
  actions?: ResourceActions;
}

export class ACLResource {
  actions = new Map<string, RoleActionParams>();
  acl: ACL;
  role: ACLRole;
  name: string;

  constructor(options: AclResourceOptions) {
    this.acl = options.role.acl;
    this.role = options.role;
    this.name = options.name;

    const actionsOption: ResourceActions = options.actions || {};
    for (const actionName of Object.keys(actionsOption)) {
      this.actions.set(actionName, actionsOption[actionName]);
    }
  }

  getAction(name: string) {
    return lodash.cloneDeep(this.actions.get(name) || null);
  }

  setAction(name: string, params: RoleActionParams) {
    this.actions.set(name, params);
  }
  
  removeAction(name: string) {
    this.actions.delete(name);
  }
  
  getActions() {
    return Array.from(this.actions.keys()).reduce((carry, key) => {
      carry[key] = this.actions.get(key);
      return carry;
    }, {} as any);
  }
}
