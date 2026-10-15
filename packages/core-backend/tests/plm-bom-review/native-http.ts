import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createServer } from "http";
import { randomUUID } from "crypto";
import type { Pool } from "pg";
import type { BomReviewPool } from "../../src/multitable/plm-bom-review-service";
import { bootstrapBomReviewNativeHttpDb } from "./native-bootstrap";
import { shareSnapshot } from "./fixture";

// Registered after the existing real-auth suite. Uses real login JWTs, current PG users/permissions,
// the native routers and real CommentService DI; there is no req.user injection or auth mock.
export function registerBomReviewNativeHttpTests(pool: Pool): void {
  describe("BOM share followed through native multitable HTTP entry points", () => {
    let app: ReturnType<typeof createServer>;
    let ownerToken: string;
    let memberToken: string;
    let outsiderToken: string;
    let binding: {
      id: string;
      sheetId: string;
      viewId: string;
      baseId: string;
      version: number;
    };
    let recordId: string;
    let sourceFields: Record<string, string>;
    let localFields: Record<string, string>;
    let invalidateUserPerms: (id: string) => void;
    let providerCalls = 0;
    const current = shareSnapshot();
    const priorEnv = Object.fromEntries(
      ["NODE_ENV", "JWT_SECRET", "RBAC_TOKEN_TRUST", "PRODUCT_MODE"].map(
        (key) => [key, process.env[key]],
      ),
    );
    const authorization = (token: string) => ({
      Authorization: `Bearer ${token}`,
    });
    const query = () => ({ sheetId: binding.sheetId, viewId: binding.viewId });
    const record = async () =>
      (
        await pool.query("SELECT data,version FROM meta_records WHERE id=$1", [
          recordId,
        ])
      ).rows[0];
    const patch = (token: string, fieldId: string, value: unknown) =>
      request(app)
        .post("/api/multitable/patch")
        .set(authorization(token))
        .send({ ...query(), changes: [{ recordId, fieldId, value }] });
    const view = (token = memberToken) =>
      request(app)
        .get("/api/multitable/view")
        .set(authorization(token))
        .query(query());
    const commentInput = () => ({
      spreadsheetId: binding.sheetId,
      rowId: recordId,
      content: "Native BOM review comment",
    });

    beforeAll(async () => {
      process.env.JWT_SECRET =
        "w20-auth-http-synthetic-signing-key-20261001-not-production";
      process.env.RBAC_TOKEN_TRUST = "false";
      process.env.PRODUCT_MODE = "plm-workbench";
      process.env.NODE_ENV = "production";
      await bootstrapBomReviewNativeHttpDb(pool);
      await pool.query(`INSERT INTO users(id,is_active,role,activation_status,local_password_set,permissions,name,email)
        VALUES('native-owner',true,'user','activated',true,'{}','Native Owner','native-owner@synthetic.invalid'),
          ('native-member',true,'user','activated',true,'{}','Native Member','native-member@synthetic.invalid'),
          ('native-outsider',true,'user','activated',true,'{}','Native Outsider','native-outsider@synthetic.invalid'),
          ('native-assignee',true,'user','activated',true,'{}','Native Assignee','native-assignee@synthetic.invalid');
        INSERT INTO user_permissions(user_id,permission_code) VALUES('native-assignee','multitable:read');
        INSERT INTO meta_bases(id,name,owner_id) VALUES('native-base','Native HTTP Base','native-owner'),
          ('native-member-base','Native Member Base','native-member');`);

      const { authService } = await import("../../src/auth/AuthService");
      ({ invalidateUserPerms } = await import("../../src/rbac/service"));
      const tokens = await Promise.all(
        ["native-owner", "native-member", "native-outsider"].map(async (id) => {
          const user = (
            await pool.query("SELECT * FROM users WHERE id=$1", [id])
          ).rows[0];
          const token = authService.createToken(user);
          expect(await authService.verifyToken(token)).toMatchObject({ id });
          return token;
        }),
      );
      [ownerToken, memberToken, outsiderToken] = tokens;
      const tx: BomReviewPool = {
        query: pool.query.bind(pool),
        async transaction(fn) {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const value = await fn({ query: client.query.bind(client) });
            await client.query("COMMIT");
            return value;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
        },
      };
      const config = {
        id: "native-ds",
        name: "Native HTTP fixture",
        type: "plm",
        connection: { baseUrl: "https://synthetic.invalid" },
        credentials: { token: "synthetic-no-network" },
        options: {},
      };
      await pool.query(
        "INSERT INTO data_sources(id,name,type,config,owner_id,is_active,scope_kind) VALUES($1,$2,'plm',$3::jsonb,'native-owner',true,'user')",
        [config.id, config.name, JSON.stringify(config)],
      );
      const adapter = {
        getConfig: () => config,
        getBomShareContext: async () => {
          providerCalls += 1;
          return structuredClone(current);
        },
        getEffectiveTenantId: () => "t",
        getEffectiveOrgId: () => "o",
      };
      const [
        { authenticate },
        { univerMetaRouter },
        { commentsRouter },
        { createContainer },
        { createPlmBomReviewsRouter },
      ] = await Promise.all([
        import("../../src/middleware/auth"),
        import("../../src/routes/univer-meta"),
        import("../../src/routes/comments"),
        import("../../src/di/container"),
        import("../../src/routes/plm-bom-reviews"),
      ]);
      const routes = express();
      routes.use(express.json());
      routes.use(authenticate);
      routes.use(
        "/api/plm-bom-reviews",
        createPlmBomReviewsRouter({
          pool: tx,
          dataSourceManager: { getDataSource: () => adapter as never },
        }),
      );
      routes.use("/api/multitable", univerMetaRouter());
      routes.use(commentsRouter(createContainer()));
      // One owned listener, rather than a throwaway listener per Supertest request.
      app = createServer(routes);
      await new Promise<void>((resolve,reject) => { app.once('error',reject); app.listen(0,'127.0.0.1',resolve); });
    });

    afterAll(async () => {
      if (app?.listening) await new Promise<void>((resolve,reject) => app.close(error => error ? reject(error) : resolve()));
      if (app) expect(app.listening).toBe(false);
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("creates by owner JWT, then grants native sheet access without granting provider access", async () => {
      const preview = await request(app)
        .post("/api/plm-bom-reviews/preview")
        .set(authorization(ownerToken))
        .send({
          dataSourceId: "native-ds",
          partId: "P",
          baseId: "native-base",
          name: "Native HTTP collaboration",
        });
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      const confirmed = await request(app)
        .post("/api/plm-bom-reviews")
        .set(authorization(ownerToken))
        .send({
          previewId: preview.body.data.previewId,
          requestId: randomUUID(),
        });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      binding = confirmed.body.data;
      expect(confirmed.body.data.navigationPath).toBe(
        `/multitable/${binding.sheetId}/${binding.viewId}`,
      );
      const granted = await request(app)
        .put(
          `/api/multitable/sheets/${binding.sheetId}/permissions/user/native-member`,
        )
        .set(authorization(ownerToken))
        .send({ accessLevel: "write" });
      expect(granted.status, JSON.stringify(granted.body)).toBe(200);
      await pool.query(
        "INSERT INTO user_permissions(user_id,permission_code) VALUES('native-member','comments:read'),('native-member','comments:write')",
      );
      // Fixture RBAC changes use the same cache invalidator as routes/permissions.ts.
      invalidateUserPerms("native-member");
      const stored = (
        await pool.query(
          "SELECT fields FROM meta_plm_bom_review_bindings WHERE id=$1",
          [binding.id],
        )
      ).rows[0];
      sourceFields = stored.fields;
      localFields = Object.fromEntries(
        (
          await pool.query(
            "SELECT id,name FROM meta_fields WHERE sheet_id=$1",
            [binding.sheetId],
          )
        ).rows.map((f) => [f.name, f.id]),
      );
      recordId = (
        await pool.query(
          "SELECT record_id FROM meta_plm_bom_review_rows WHERE binding_id=$1 AND bom_line_id='RC'",
          [binding.id],
        )
      ).rows[0].record_id;
      const calls = providerCalls;
      const forbidden = await request(app)
        .post("/api/plm-bom-reviews/preview")
        .set(authorization(memberToken))
        .send({
          dataSourceId: "native-ds",
          partId: "P",
          baseId: "native-member-base",
          name: "Cannot borrow owner source",
        });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.code).toBe("SOURCE_FORBIDDEN");
      expect(providerCalls).toBe(calls);
    });

    const nativeContext = (token = ownerToken) =>
      request(app)
        .get("/api/multitable/context")
        .set(authorization(token))
        .query(query());
    const admitNamespace = async (actor: string, namespace: string) => {
      const role = `return-link-scope-${namespace}`;
      await pool.query("INSERT INTO roles(id,name) VALUES($1,$1) ON CONFLICT (id) DO NOTHING", [role]);
      await pool.query("DELETE FROM role_permissions WHERE role_id=$1", [role]);
      await pool.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)", [role, `${namespace}:read`]);
      await pool.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)", [actor, role]);
      await pool.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled) VALUES($1,$2,true) ON CONFLICT (user_id,namespace) DO UPDATE SET enabled=true", [actor, namespace]);
    };
    const ownerPermission = async (permission?: string) => {
      await pool.query("DELETE FROM user_permissions WHERE user_id='native-owner'");
      await pool.query("DELETE FROM user_roles WHERE user_id='native-owner' AND role_id LIKE 'return-link-scope-%'");
      await pool.query("DELETE FROM user_namespace_admissions WHERE user_id='native-owner'");
      if (permission) {
        await pool.query(
          "INSERT INTO user_permissions(user_id,permission_code) VALUES('native-owner',$1)",
          [permission],
        );
        const { derivePermissionNamespace } = await import("../../src/rbac/namespace-admission");
        const namespace = derivePermissionNamespace(permission);
        if (namespace) await admitNamespace("native-owner", namespace);
      }
      invalidateUserPerms("native-owner");
    };

    it.each([
      "integration:write", "integration:*", "integration:admin", "*:*",
      "admin:all", "users:write", "roles:write", "permissions:write",
    ])("discloses the exact source only to a current owner admitted by the workbench %s gate", async (permission) => {
      const calls = providerCalls;
      await ownerPermission(permission);
      try {
        const response = await nativeContext();
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body.data.plmBomSource).toEqual({ dataSourceId: "native-ds", partId: "P" });
        expect(JSON.stringify(response.body)).not.toContain("synthetic-no-network");
        expect(providerCalls).toBe(calls);
      } finally {
        await ownerPermission();
      }
    });

    it.each(["integration:write", "users:write"])("filters raw %s before shortcut matching and immediately honors namespace admission and role revocation", async (permission) => {
      const namespace = permission.split(":")[0];
      await ownerPermission(permission);
      const calls = providerCalls;
      try {
        const allowed = await nativeContext();
        expect(allowed.status).toBe(200);
        expect(allowed.body.data.plmBomSource).toEqual({ dataSourceId: "native-ds", partId: "P" });
        // Keep AuthService's cached permissions warm. The optional hint must still read current admission.
        await pool.query("UPDATE user_namespace_admissions SET enabled=false WHERE user_id='native-owner' AND namespace=$1", [namespace]);
        const revoked = await nativeContext();
        expect(revoked.status).toBe(200);
        expect(revoked.body.data).not.toHaveProperty("plmBomSource");
        await pool.query("DELETE FROM user_namespace_admissions WHERE user_id='native-owner' AND namespace=$1", [namespace]);
        expect((await nativeContext()).body.data).not.toHaveProperty("plmBomSource");
        await pool.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled) VALUES('native-owner',$1,true)", [namespace]);
        expect((await nativeContext()).body.data.plmBomSource).toEqual({ dataSourceId: "native-ds", partId: "P" });
        await pool.query("DELETE FROM user_roles WHERE user_id='native-owner' AND role_id=$1", [`return-link-scope-${namespace}`]);
        const noRole = await nativeContext();
        expect(noRole.status).toBe(200);
        expect(noRole.body.data).not.toHaveProperty("plmBomSource");
        await pool.query("INSERT INTO user_roles(user_id,role_id) VALUES('native-owner',$1)", [`return-link-scope-${namespace}`]);
        expect((await nativeContext()).body.data.plmBomSource).toEqual({ dataSourceId: "native-ds", partId: "P" });
        expect(providerCalls).toBe(calls);
      } finally {
        await ownerPermission();
      }
    });

    it("honours current admin role, and hides the source after fresh permission revocation without relying on auth cache invalidation", async () => {
      const calls = providerCalls;
      await pool.query("UPDATE users SET role='admin' WHERE id='native-owner'");
      try {
        const admin = await nativeContext();
        expect(admin.status).toBe(200);
        expect(admin.body.data.plmBomSource).toEqual({ dataSourceId: "native-ds", partId: "P" });
      } finally {
        await pool.query("UPDATE users SET role='user' WHERE id='native-owner'");
      }
      await ownerPermission("integration:write");
      const allowed = await nativeContext();
      expect(allowed.body.data.plmBomSource).toEqual({ dataSourceId: "native-ds", partId: "P" });
      await pool.query("DELETE FROM user_permissions WHERE user_id='native-owner'");
      try {
        const revoked = await nativeContext();
        expect(revoked.status).toBe(200);
        expect(revoked.body.data).not.toHaveProperty("plmBomSource");
        expect(providerCalls).toBe(calls);
      } finally {
        invalidateUserPerms("native-owner");
      }
    });

    it("a readable ordinary native sheet and a source owner with only integration read receive no source hint", async () => {
      await ownerPermission("integration:read");
      const reader = await nativeContext();
      expect(reader.status).toBe(200);
      expect(reader.body.data).not.toHaveProperty("plmBomSource");
      await ownerPermission("integration:write");
      try {
        await pool.query(`INSERT INTO meta_sheets(id,base_id,name) VALUES('return-link-ordinary','native-base','Ordinary');
          INSERT INTO meta_views(id,sheet_id,name,type,config) VALUES('return-link-ordinary-view','return-link-ordinary','Default','grid','{}');
          INSERT INTO spreadsheet_permissions(sheet_id,subject_type,subject_id,perm_code) VALUES('return-link-ordinary','user','native-owner','spreadsheet:admin');`);
        const ordinary = await request(app).get("/api/multitable/context").set(authorization(ownerToken)).query({ sheetId: "return-link-ordinary", viewId: "return-link-ordinary-view" });
        expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(200);
        expect(ordinary.body.data.sheet.id).toBe("return-link-ordinary");
        expect(ordinary.body.data).not.toHaveProperty("plmBomSource");
      } finally {
        await ownerPermission();
      }
    });

    it("current inactive actor is refused by real authentication and restoration retains the owner hint", async () => {
      await ownerPermission("integration:write");
      try {
        await pool.query("UPDATE users SET is_active=false WHERE id='native-owner'");
        const denied = await nativeContext();
        expect(denied.status).toBe(401);
        expect(denied.body).not.toHaveProperty("data.plmBomSource");
      } finally {
        await pool.query("UPDATE users SET is_active=true WHERE id='native-owner'");
      }
      try {
        const restored = await nativeContext();
        expect(restored.status).toBe(200);
        expect(restored.body.data.plmBomSource).toEqual({ dataSourceId: "native-ds", partId: "P" });
      } finally {
        await ownerPermission();
      }
    });

    it("does not disclose a source to a table member or outsider even with integration write", async () => {
      const calls = providerCalls;
      await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES('native-member','integration:write'),('native-outsider','integration:write')");
      await admitNamespace("native-member", "integration");
      await admitNamespace("native-outsider", "integration");
      invalidateUserPerms("native-member");
      invalidateUserPerms("native-outsider");
      try {
        const member = await nativeContext(memberToken);
        expect(member.status).toBe(200);
        expect(member.body.data).not.toHaveProperty("plmBomSource");
        const outsider = await nativeContext(outsiderToken);
        expect(outsider.status).toBe(403);
        expect(outsider.body).not.toHaveProperty("data.plmBomSource");
        expect(providerCalls).toBe(calls);
      } finally {
        await pool.query("DELETE FROM user_permissions WHERE user_id IN ('native-member','native-outsider') AND permission_code='integration:write'");
        await pool.query("DELETE FROM user_roles WHERE user_id IN ('native-member','native-outsider') AND role_id='return-link-scope-integration'");
        await pool.query("DELETE FROM user_namespace_admissions WHERE user_id IN ('native-member','native-outsider') AND namespace='integration'");
        invalidateUserPerms("native-member");
        invalidateUserPerms("native-outsider");
      }
    });

    it.each([
      ["owner", "owner_id='native-member'"],
      ["inactive", "is_active=false"],
      ["deleted", "deleted_at=now()"],
      ["type", "type='postgresql'"],
      ["configuration", "config=jsonb_set(config,'{connection,baseUrl}','\"https://changed.invalid\"'::jsonb)"],
      ["credential", "config=jsonb_set(config,'{credentials,token}','\"changed-synthetic\"'::jsonb)"],
      ["workspace", "workspace_id='changed-workspace'"],
      ["tenant", "tenant_id='changed-tenant'"],
      ["scope", "scope_kind='org'"],
    ])("omits metadata for current source %s drift and restores it only when the original source is restored", async (_name, assignment) => {
      await ownerPermission("integration:write");
      const source = (await pool.query("SELECT * FROM data_sources WHERE id='native-ds'")).rows[0];
      const calls = providerCalls;
      try {
        await pool.query(`UPDATE data_sources SET ${assignment} WHERE id='native-ds'`);
        const denied = await nativeContext();
        expect(denied.status).toBe(200);
        expect(denied.body.data).not.toHaveProperty("plmBomSource");
      } finally {
        await pool.query("UPDATE data_sources SET config=$1,owner_id=$2,is_active=$3,deleted_at=$4,type=$5,workspace_id=$6,tenant_id=$7,scope_kind=$8 WHERE id='native-ds'",
          [source.config,source.owner_id,source.is_active,source.deleted_at,source.type,source.workspace_id,source.tenant_id,source.scope_kind]);
      }
      try {
        const restored = await nativeContext();
        expect(restored.status).toBe(200);
        expect(restored.body.data.plmBomSource).toEqual({ dataSourceId: "native-ds", partId: "P" });
        expect(providerCalls).toBe(calls);
      } finally {
        await ownerPermission();
      }
    });

    it("keeps native context available without metadata while the feature is off or the binding schema is unavailable", async () => {
      await ownerPermission("integration:write");
      const calls = providerCalls;
      try {
        process.env.PLM_BOM_REVIEW_ENABLED = "false";
        const off = await nativeContext();
        expect(off.status).toBe(200);
        expect(off.body.data).not.toHaveProperty("plmBomSource");
        process.env.PLM_BOM_REVIEW_ENABLED = "true";
        await pool.query("ALTER TABLE meta_plm_bom_review_bindings RENAME TO return_link_bindings_unavailable");
        try {
          const unavailable = await nativeContext();
          expect(unavailable.status).toBe(200);
          expect(unavailable.body.data).not.toHaveProperty("plmBomSource");
        } finally {
          await pool.query("ALTER TABLE return_link_bindings_unavailable RENAME TO meta_plm_bom_review_bindings");
        }
        expect(providerCalls).toBe(calls);
      } finally {
        process.env.PLM_BOM_REVIEW_ENABLED = "true";
        await ownerPermission();
      }
    });

    it("loads context, serialized fields and repeated BOM occurrences through the actual native read routes", async () => {
      const context = await request(app)
        .get("/api/multitable/context")
        .set(authorization(memberToken))
        .query({ ...query(), baseId: binding.baseId });
      expect(context.status, JSON.stringify(context.body)).toBe(200);
      expect(context.body.data.sheet.id).toBe(binding.sheetId);
      expect(context.body.data.capabilities).toMatchObject({
        canRead: true,
        canEditRecord: true,
        canComment: true,
      });
      expect(
        context.body.data.fieldPermissions[sourceFields.quantity].readOnly,
      ).toBe(true);
      const fields = await request(app)
        .get("/api/multitable/fields")
        .set(authorization(memberToken))
        .query({ sheetId: binding.sheetId });
      expect(fields.status, JSON.stringify(fields.body)).toBe(200);
      expect(fields.body.data.fields).toHaveLength(22);
      expect(
        fields.body.data.fields.find(
          (f: { id: string }) => f.id === localFields["负责人"],
        ).type,
      ).toBe("person");
      expect(
        fields.body.data.fields.find(
          (f: { id: string }) => f.id === localFields["备注"],
        ).type,
      ).toBe("longText");
      expect(
        fields.body.data.fields.find(
          (f: { id: string }) => f.id === localFields["截止时间"],
        ).type,
      ).toBe("dateTime");
      const response = await view();
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.rows).toHaveLength(3);
      const child = response.body.data.rows.find(
        (r: { id: string }) => r.id === recordId,
      );
      expect(JSON.parse(child.data[sourceFields.occurrences])).toHaveLength(2);
    });

    it("native saved pending and issue views filter the actual BOM rows through authorized HTTP", async () => {
      const listed = await request(app).get('/api/multitable/views').set(authorization(memberToken)).query({ sheetId: binding.sheetId });
      expect(listed.status).toBe(200);
      expect(listed.body.data.views.map((v: { name: string }) => v.name)).toEqual(['全部','按负责人','待评审','问题项']);
      const pending = listed.body.data.views.find((v: { name: string }) => v.name === '待评审');
      const issues = listed.body.data.views.find((v: { name: string }) => v.name === '问题项');
      const read = (id: string,token = memberToken) => request(app).get('/api/multitable/view').set(authorization(token)).query({ sheetId: binding.sheetId,viewId: id });
      expect((await read(pending.id)).body.data.rows).toHaveLength(3);
      expect((await read(issues.id)).body.data.rows).toEqual([]);
      const other = (await pool.query(`SELECT record_id FROM meta_plm_bom_review_rows WHERE binding_id=$1 AND record_id<>$2 ORDER BY record_id LIMIT 1`,[binding.id,recordId])).rows[0].record_id;
      for (const state of ['评审中','有问题']) {
        const updated = await request(app).post('/api/multitable/patch').set(authorization(memberToken))
          .send({ ...query(),changes: [{ recordId: other,fieldId: localFields['评审状态'],value: state }] });
        expect(updated.status,JSON.stringify(updated.body)).toBe(200);
      }
      const p = await read(pending.id), i = await read(issues.id), all = await view();
      expect(p.status,JSON.stringify(p.body)).toBe(200); expect(p.body.data.rows).toHaveLength(2);
      expect(p.body.data.rows.map((r: { id: string }) => r.id)).not.toContain(other);
      expect(i.status,JSON.stringify(i.body)).toBe(200); expect(i.body.data.rows.map((r: { id: string }) => r.id)).toEqual([other]);
      expect(all.body.data.rows).toHaveLength(3);
      expect((await read(issues.id,outsiderToken)).status).toBe(403);
      const audits = (await pool.query(`SELECT * FROM meta_config_revisions WHERE entity_type='view' AND entity_id=ANY($1::text[])`,[[pending.id,issues.id]])).rows;
      expect(audits).toHaveLength(2); expect(audits.every((a) => a.actor_id === 'native-owner')).toBe(true);
    });

    it("native views expose the owner group and preserve a manager's renamed and regrouped view on refresh", async () => {
      const listed = await request(app)
        .get("/api/multitable/views")
        .set(authorization(memberToken))
        .query({ sheetId: binding.sheetId });
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      const grouped = listed.body.data.views.find(
        (v: { name: string }) => v.name === "按负责人",
      );
      expect(grouped).toMatchObject({
        type: "grid",
        groupInfo: {
          fieldId: localFields["负责人"],
          fieldIds: [localFields["负责人"]],
        },
      });
      expect(listed.body.data.views[0].id).toBe(binding.viewId);
      const custom = {
        name: "Team custom view",
        sortInfo: { fieldId: localFields["备注"], direction: "desc" },
        groupInfo: {
          fieldId: localFields["问题类型"],
          fieldIds: [localFields["问题类型"]],
        },
      };
      const changed = await request(app)
        .patch(`/api/multitable/views/${grouped.id}`)
        .set(authorization(ownerToken))
        .send(custom);
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      const pending = listed.body.data.views.find((v: { name: string }) => v.name === '待评审');
      const pendingCustom = { name: 'My pending review',filterInfo: { conjunction: 'and',conditions: [
        { fieldId: localFields['评审状态'],operator: 'is',value: '评审中' },
      ] } };
      const editedPending = await request(app).patch(`/api/multitable/views/${pending.id}`).set(authorization(ownerToken)).send(pendingCustom);
      expect(editedPending.status,JSON.stringify(editedPending.body)).toBe(200);
      const pendingBefore = (await pool.query('SELECT * FROM meta_views WHERE id=$1',[pending.id])).rows[0];
      const before = (
        await pool.query("SELECT * FROM meta_views WHERE id=$1", [grouped.id])
      ).rows[0];
      const refreshed = await request(app)
        .post(`/api/plm-bom-reviews/${binding.id}/refresh`)
        .set(authorization(ownerToken))
        .send({ expectedVersion: binding.version });
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      binding = refreshed.body.data;
      expect(
        (await pool.query("SELECT * FROM meta_views WHERE id=$1", [grouped.id]))
          .rows[0],
      ).toEqual(before);
      const read = await request(app)
        .get("/api/multitable/views")
        .set(authorization(memberToken))
        .query({ sheetId: binding.sheetId });
      expect(read.status).toBe(200);
      expect((await pool.query('SELECT * FROM meta_views WHERE id=$1',[pending.id])).rows[0]).toEqual(pendingBefore);
      expect(read.body.data.views.find((v: { id: string }) => v.id === pending.id)).toMatchObject(pendingCustom);
      expect(
        read.body.data.views.find((v: { id: string }) => v.id === grouped.id),
      ).toMatchObject(custom);
    });

    it("native deletion of the initialized group remains deleted after repeated source refreshes", async () => {
      const listed = await request(app)
        .get("/api/multitable/views")
        .set(authorization(ownerToken))
        .query({ sheetId: binding.sheetId });
      const grouped = listed.body.data.views.find(
        (v: { name: string }) => v.name === "Team custom view",
      );
      expect(grouped).toBeDefined();
      const removed = await request(app)
        .delete(`/api/multitable/views/${grouped.id}`)
        .set(authorization(ownerToken));
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      const audit = (
        await pool.query(
          "SELECT * FROM meta_config_revisions WHERE entity_type='view' AND entity_id=$1 ORDER BY id",
          [grouped.id],
        )
      ).rows;
      expect(audit.some((r) => r.action === "delete")).toBe(true);
      for (let i = 0; i < 2; i++) {
        const refreshed = await request(app)
          .post(`/api/plm-bom-reviews/${binding.id}/refresh`)
          .set(authorization(ownerToken))
          .send({ expectedVersion: binding.version });
        expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
        binding = refreshed.body.data;
      }
      const read = await request(app)
        .get("/api/multitable/views")
        .set(authorization(memberToken))
        .query({ sheetId: binding.sheetId });
      expect(read.status).toBe(200);
      expect(read.body.data.views.map((v: { id: string }) => v.id)).toEqual(
        listed.body.data.views.filter((v: { id: string }) => v.id !== grouped.id).map((v: { id: string }) => v.id),
      );
      expect(
        (
          await pool.query(
            "SELECT owner_view_initialized FROM meta_plm_bom_review_bindings WHERE id=$1",
            [binding.id],
          )
        ).rows[0].owner_view_initialized,
      ).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT * FROM meta_config_revisions WHERE entity_type='view' AND entity_id=$1 ORDER BY id",
            [grouped.id],
          )
        ).rows,
      ).toEqual(audit);
    });

    it("sheet admins configure notification policy with current permissions, audit and version CAS", async () => {
      const url = `/api/plm-bom-reviews/${binding.id}/notifications`;
      const get = (token: string) => request(app).get(url).set(authorization(token));
      const save = (token: string, body: unknown) => request(app).post(url).set(authorization(token)).send(body);
      expect((await get(memberToken)).status).toBe(403);
      const initial = await get(ownerToken);
      expect(initial.status, JSON.stringify(initial.body)).toBe(200);
      expect(initial.body.data).toEqual({ version: 0, notifications: null });
      const directory = (token: string, q: string) => request(app)
        .get(`/api/plm-bom-reviews/${binding.id}/notification-recipients`).set(authorization(token)).query({ q });
      expect((await directory(memberToken, "Native Member")).status).toBe(403);
      expect((await directory(ownerToken, "native-member")).body.data.items).toEqual([{ id: "native-member", name: "Native Member" }]);
      expect((await directory(ownerToken, "native-outsider")).body.data.items).toEqual([]);
      expect((await directory(ownerToken, "%_")).body.data.items).toEqual([]);
      expect((await directory(ownerToken, "")).status).toBe(400);
      const body = { expectedVersion: 0, notifications: {
        issue: { enabled: true, recipientStrategy: "event_owner" },
        reminder: { enabled: true, recipientStrategy: "current_owner", leadMinutes: 15 },
        escalation: { enabled: true, slaMinutes: 60, recipientUserIds: ["native-member"] },
      } };
      expect((await save(memberToken, body)).status).toBe(403);
      const created = await save(ownerToken, body);
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(created.body.data).toEqual({ version: 1, notifications: body.notifications });
      const audits = () => pool.query("SELECT * FROM meta_config_revisions WHERE entity_id=$1 ORDER BY created_at,id",
        [`plm-bom-review:${binding.id}:notifications`]);
      expect((await audits()).rows).toHaveLength(1);
      expect((await save(ownerToken, body)).status).toBe(409);
      expect((await save(ownerToken, { ...body, expectedVersion: 1 })).body.data.version).toBe(1);
      expect((await audits()).rows).toHaveLength(1);
      const forbidden = { ...body, expectedVersion: 1, notifications: { ...body.notifications,
        escalation: { ...body.notifications.escalation, recipientUserIds: ["native-outsider"] } } };
      expect((await save(ownerToken, forbidden)).status).toBe(403);
      expect((await get(ownerToken)).body.data).toEqual(created.body.data);
      const changed = { ...body, expectedVersion: 1, notifications: { ...body.notifications,
        issue: { enabled: true, recipientStrategy: "current_owner" } } };
      const race = await Promise.all([save(ownerToken, changed), save(ownerToken, changed)]);
      expect(race.map((r) => r.status).sort()).toEqual([200,409]);
      expect((await audits()).rows).toHaveLength(2);
      expect((await audits()).rows.every((row) => row.actor_id === "native-owner")).toBe(true);
      await pool.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:read' WHERE sheet_id=$1 AND subject_id='native-owner'", [binding.sheetId]);
      try {
        expect((await get(ownerToken)).status).toBe(403);
        expect((await save(ownerToken, { ...changed, expectedVersion: 2 })).status).toBe(403);
        expect((await audits()).rows).toHaveLength(2);
      } finally {
        await pool.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:admin' WHERE sheet_id=$1 AND subject_id='native-owner'", [binding.sheetId]);
      }
      await pool.query("UPDATE users SET is_active=false WHERE id='native-member'");
      try {
        expect((await save(ownerToken, { ...changed, expectedVersion: 2 })).status).toBe(403);
        expect((await audits()).rows).toHaveLength(2);
        const disabled = await save(ownerToken, { ...changed, expectedVersion: 2, notifications: {
          ...changed.notifications, escalation: { ...changed.notifications.escalation, enabled: false, slaMinutes: null },
        } });
        expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
        expect(disabled.body.data.version).toBe(3);
        expect((await audits()).rows).toHaveLength(3);
      } finally {
        await pool.query("UPDATE users SET is_active=true WHERE id='native-member'");
      }
    });

    it("native login configures two distinct completion targets without revealing URLs or granting egress", async () => {
      const url = `/api/plm-bom-reviews/${binding.id}/completion-webhooks`;
      const get = (token: string) => request(app).get(url).set(authorization(token));
      const save = (token: string,body: unknown) => request(app).post(url).set(authorization(token)).send(body);
      expect((await request(app).get(url)).status).toBe(401);
      expect((await get(memberToken)).status).toBe(403);
      expect((await get(ownerToken)).body.data).toEqual({ version: 0,webhooks: null });
      expect((await save(ownerToken,null)).status).toBe(400);
      const a = randomUUID(), b = randomUUID(), foreign = randomUUID();
      await pool.query(`INSERT INTO multitable_webhooks(id,name,url,secret,created_by) VALUES
        ($1,'Review','https://example.com/secret-review','private-signing-key','native-owner'),
        ($2,'PLM','https://example.com/secret-plm','private-signing-key','native-owner'),
        ($3,'Foreign','https://example.com/foreign',NULL,'native-outsider')`,[a,b,foreign]);
      const body = { expectedVersion: 0,webhooks: {
        reviewCompleted: { enabled: true,webhookId: a,granularity: 'row' },plmChangeApplied: { enabled: true,webhookId: b,source: 'bom_line_writeback' },
      } };
      expect((await save(ownerToken,body)).status).toBe(403);
      await pool.query("INSERT INTO user_permissions VALUES('native-owner','multitable:send_webhook')");
      try {
        const targets = await request(app).get(`/api/plm-bom-reviews/${binding.id}/completion-webhook-destinations`).set(authorization(ownerToken));
        expect(targets.status).toBe(200);
        expect(targets.body.data).toEqual([{ id: b,name: 'PLM' },{ id: a,name: 'Review' }]);
        expect(JSON.stringify(targets.body)).not.toContain('https://');
        expect(JSON.stringify(targets.body)).not.toContain('private-signing-key');
        expect((await save(ownerToken,{ ...body,webhooks: { ...body.webhooks,reviewCompleted: { enabled: true,webhookId: foreign,granularity: 'row' } } })).status).toBe(403);
        const race = await Promise.all([save(ownerToken,body),save(ownerToken,body)]);
        expect(race.map(r => r.status).sort()).toEqual([200,409]);
        const created = race.find(r => r.status === 200)!;
        expect(created.status,JSON.stringify(created.body)).toBe(200);
        expect(created.body.data).toEqual({ version: 1,webhooks: body.webhooks });
        expect(created.headers['cache-control']).toBe('no-store');
        expect((await save(ownerToken,body)).status).toBe(409);
        expect((await save(ownerToken,{ ...body,expectedVersion: 1,event_type: 'bom.plm_change.applied' })).status).toBe(400);
        await pool.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:read' WHERE sheet_id=$1 AND subject_id='native-owner'",[binding.sheetId]);
        try { expect((await get(ownerToken)).status).toBe(403); }
        finally { await pool.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:admin' WHERE sheet_id=$1 AND subject_id='native-owner'",[binding.sheetId]); }
        const audit = (await pool.query('SELECT * FROM meta_config_revisions WHERE entity_id=$1',[`plm-bom-review:${binding.id}:completion-webhooks`])).rows;
        expect(audit).toHaveLength(1); expect(audit[0].actor_id).toBe('native-owner');
      } finally { await pool.query("DELETE FROM user_permissions WHERE user_id='native-owner' AND permission_code='multitable:send_webhook'"); }
    });

    it("native patch refuses skipped review steps without committing data or durable events", async () => {
      const field = localFields["评审状态"];
      expect((await record()).data[field]).toBe("待评审");
      const before = (await pool.query("SELECT count(*)::int n FROM meta_automation_outbox")).rows[0].n;
      const skipped = await patch(memberToken, field, "已完成");
      expect(skipped.status, JSON.stringify(skipped.body)).toBe(400);
      expect(skipped.body.error.code).toBe("BOM_REVIEW_STATE_TRANSITION_INVALID");
      expect((await record()).data[field]).toBe("待评审");
      expect((await pool.query("SELECT count(*)::int n FROM meta_automation_outbox")).rows[0].n).toBe(before);
      for (const state of ["评审中", "有问题", "已完成", "评审中"]) {
        const response = await patch(memberToken, field, state);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      }
      expect((await record()).data[field]).toBe("评审中");
    });

    it("native patch edits local text, person and dateTime cells while source fields stay readonly", async () => {
      // Existing native person eligibility requires an active platform-eligible assignee. The editor
      // retains only a sheet grant; assignment does not create any permissions for either user.
      const directory = await request(app)
        .get(
          `/api/multitable/sheets/${binding.sheetId}/person-fields/${localFields["负责人"]}/directory`,
        )
        .set(authorization(memberToken))
        .query({ q: "native-assignee", match: "exact" });
      expect(directory.status, JSON.stringify(directory.body)).toBe(200);
      expect(directory.body.data.items).toHaveLength(1);
      expect(directory.body.data.items[0].userId).toBe("native-assignee");
      const grantsBefore = (
        await pool.query(
          "SELECT * FROM spreadsheet_permissions WHERE sheet_id=$1 ORDER BY subject_id,perm_code",
          [binding.sheetId],
        )
      ).rows;
      const ineligible = await patch(memberToken, localFields["负责人"], [
        "native-member",
      ]);
      expect(ineligible.status).toBe(400);
      for (const [name, value] of [
        ["备注", "Native local note"],
        ["负责人", ["native-assignee"]],
        ["截止时间", "2026-10-02T08:00:00.000Z"],
      ] as const) {
        const response = await patch(memberToken, localFields[name], value);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      }
      const before = await record();
      expect(before.data[localFields["备注"]]).toBe("Native local note");
      expect(before.data[localFields["负责人"]]).toEqual(["native-assignee"]);
      expect(
        (
          await pool.query(
            "SELECT * FROM spreadsheet_permissions WHERE sheet_id=$1 ORDER BY subject_id,perm_code",
            [binding.sheetId],
          )
        ).rows,
      ).toEqual(grantsBefore);
      const denied = await patch(memberToken, sourceFields.quantity, "999");
      expect(denied.status).toBe(403);
      expect(await record()).toEqual(before);
    });

    it("native comments persist the real JWT author and roundtrip on the same sheet and record", async () => {
      const created = await request(app)
        .post("/api/comments")
        .set(authorization(memberToken))
        .send(commentInput());
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const row = (
        await pool.query(
          "SELECT author_id,spreadsheet_id,row_id,content FROM meta_comments WHERE id=$1",
          [created.body.data.comment.id],
        )
      ).rows[0];
      expect(row).toEqual({
        author_id: "native-member",
        spreadsheet_id: binding.sheetId,
        row_id: recordId,
        content: "Native BOM review comment",
      });
      const listed = await request(app)
        .get("/api/comments")
        .set(authorization(memberToken))
        .query({ spreadsheetId: binding.sheetId, rowId: recordId });
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(JSON.stringify(listed.body.data)).toContain(
        "Native BOM review comment",
      );
    });

    it("owner refresh updates source cells while native local edits and comments remain available", async () => {
      for (const line of current.context.lines)
        if (line.bom_line_id === "RC") line.quantity = "7";
      const refreshed = await request(app)
        .post(`/api/plm-bom-reviews/${binding.id}/refresh`)
        .set(authorization(ownerToken))
        .send({ expectedVersion: binding.version });
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      binding = refreshed.body.data;
      const response = await view();
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const row = response.body.data.rows.find(
        (r: { id: string }) => r.id === recordId,
      );
      expect(row.data[sourceFields.quantity]).toBe("7");
      expect(row.data[localFields["备注"]]).toBe("Native local note");
      expect(row.data[localFields["负责人"]]).toEqual(["native-assignee"]);
      expect(row.data[localFields["截止时间"]]).toBe(
        "2026-10-02T08:00:00.000Z",
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM meta_comments WHERE spreadsheet_id=$1 AND row_id=$2",
            [binding.sheetId, recordId],
          )
        ).rows[0].n,
      ).toBe(1);
      const comments = await request(app)
        .get("/api/comments")
        .set(authorization(memberToken))
        .query({ spreadsheetId: binding.sheetId, rowId: recordId });
      expect(comments.status, JSON.stringify(comments.body)).toBe(200);
      expect(JSON.stringify(comments.body.data)).toContain(
        "Native BOM review comment",
      );
    });

    it("removing comment permissions rejects new comments without removing native record editing", async () => {
      await pool.query(
        "DELETE FROM user_permissions WHERE user_id='native-member' AND permission_code LIKE 'comments:%'",
      );
      invalidateUserPerms("native-member");
      const denied = await request(app)
        .post("/api/comments")
        .set(authorization(memberToken))
        .send(commentInput());
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      const readDenied = await request(app)
        .get("/api/comments")
        .set(authorization(memberToken))
        .query({ spreadsheetId: binding.sheetId, rowId: recordId });
      expect(readDenied.status, JSON.stringify(readDenied.body)).toBe(403);
      const context = await request(app)
        .get("/api/multitable/context")
        .set(authorization(memberToken))
        .query(query());
      expect(context.status).toBe(200);
      expect(context.body.data.capabilities).toMatchObject({
        canRead: true,
        canEditRecord: true,
        canComment: false,
      });
      const updated = await patch(
        memberToken,
        localFields["问题类型"],
        "Native local classification",
      );
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    });

    it("a disabled binding keeps its safe owner navigation while only future source refresh is disabled", async () => {
      await ownerPermission("integration:write");
      const calls = providerCalls;
      try {
        const disabled = await request(app).post(`/api/plm-bom-reviews/${binding.id}/disable`).set(authorization(ownerToken)).send({ expectedVersion: binding.version });
        expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
        binding = disabled.body.data;
        const owner = await nativeContext();
        expect(owner.status).toBe(200);
        expect(owner.body.data.plmBomSource).toEqual({ dataSourceId: "native-ds", partId: "P" });
        const member = await nativeContext(memberToken);
        expect(member.status).toBe(200);
        expect(member.body.data).not.toHaveProperty("plmBomSource");
        expect(providerCalls).toBe(calls);
      } finally {
        await ownerPermission();
      }
    });

    it("outsider and a member whose sheet grant is revoked cannot read, edit or comment on the shared snapshot", async () => {
      const revoked = await request(app)
        .put(
          `/api/multitable/sheets/${binding.sheetId}/permissions/user/native-member`,
        )
        .set(authorization(ownerToken))
        .send({ accessLevel: "none" });
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      await pool.query(
        "INSERT INTO user_permissions(user_id,permission_code) VALUES('native-member','comments:read'),('native-member','comments:write'),('native-outsider','comments:read'),('native-outsider','comments:write')",
      );
      invalidateUserPerms("native-member");
      invalidateUserPerms("native-outsider");
      const before = await record();
      for (const token of [memberToken, outsiderToken]) {
        for (const route of ["/context", "/fields", "/view"]) {
          const response = await request(app)
            .get(`/api/multitable${route}`)
            .set(authorization(token))
            .query(query());
          expect(
            response.status,
            `${route}: ${JSON.stringify(response.body)}`,
          ).toBe(403);
          expect(JSON.stringify(response.body)).not.toContain(
            "Native local note",
          );
        }
        expect(
          (await patch(token, localFields["备注"], "Forbidden")).status,
        ).toBe(403);
        expect(
          (
            await request(app)
              .get("/api/comments")
              .set(authorization(token))
              .query({ spreadsheetId: binding.sheetId, rowId: recordId })
          ).status,
        ).toBe(403);
        expect(
          (
            await request(app)
              .post("/api/comments")
              .set(authorization(token))
              .send(commentInput())
          ).status,
        ).toBe(403);
      }
      expect(await record()).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM meta_comments WHERE spreadsheet_id=$1",
            [binding.sheetId],
          )
        ).rows[0].n,
      ).toBe(1);
    });
  });
}
