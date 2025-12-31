
import { ACL, DefineOptions } from '../libs/acl';

export class AccessControlService {
  private acl: ACL;

  constructor() {
    this.acl = new ACL();
    this.initDefaultRoles();
  }

  private initDefaultRoles() {
    // Define 'admin' role with full access
    this.defineRole({
      role: 'admin',
      actions: {
        '*:*': {} // Allow everything
      }
    });

    // Define 'member' role with limited access
    this.defineRole({
      role: 'member',
      actions: {
        'posts:view': {},
        'posts:create': {},
        'posts:update': { own: true } // Example constraint
      }
    });

    // Define 'editor' role for Spreadsheet access
    this.defineRole({
      role: 'editor',
      actions: {
        'spreadsheet:read': {},
        'spreadsheet:update': {}
      }
    });
  }

  public defineRole(options: DefineOptions) {
    return this.acl.define(options);
  }

  public can(role: string | string[], resource: string, action: string): boolean {
    const roles = Array.isArray(role) ? role : [role];
    const result = this.acl.can({ roles, resource, action });
    return !!result;
  }
  
  public getACLInstance(): ACL {
      return this.acl;
  }
}
