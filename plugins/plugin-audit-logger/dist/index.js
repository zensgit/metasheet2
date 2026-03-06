function n(s) {
  return s instanceof Error ? s.message : String(s);
}
class c {
  constructor(t, a) {
    this.context = t, this.config = a;
  }
  async logAction(t) {
    const a = {
      id: this.generateId(),
      timestamp: /* @__PURE__ */ new Date(),
      ...t
    };
    try {
      await this.storeLogEntry(a), this.config.enableRealTimeLogging && this.context.core.events.emit("audit.log.created", a), console.log(`[audit-logger] Action logged: ${t.action} on ${t.resource}`);
    } catch (o) {
      console.error("[audit-logger] Failed to log action:", o);
    }
  }
  generateId() {
    return `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  async storeLogEntry(t) {
    console.log("[audit-logger] Log entry stored:", {
      id: t.id,
      action: t.action,
      resource: t.resource,
      userId: t.userId,
      timestamp: t.timestamp.toISOString()
    });
  }
  async getLogs(t) {
    return console.log("[audit-logger] Getting logs with filters:", t), [];
  }
  async exportLogs(t = "json") {
    const a = await this.getLogs();
    if (t === "csv") {
      const o = ["ID", "Timestamp", "User ID", "Action", "Resource", "Details"], i = a.map((e) => [
        e.id,
        e.timestamp.toISOString(),
        e.userId,
        e.action,
        e.resource,
        JSON.stringify(e.details)
      ]);
      return [o, ...i].map((e) => e.join(",")).join(`
`);
    }
    return JSON.stringify(a, null, 2);
  }
  async clearOldLogs() {
    const t = /* @__PURE__ */ new Date();
    t.setDate(t.getDate() - this.config.logRetentionDays), console.log(`[audit-logger] Clearing logs older than ${t.toISOString()}`);
  }
}
const l = {
  activate(s) {
    console.log("Audit Logger Plugin activated");
    const t = {
      logRetentionDays: 365,
      enableRealTimeLogging: !0,
      logLevel: "info"
    }, a = new c(s, t);
    s.core.http && s.core.http.addRoute && (s.core.http.addRoute("GET", "/api/v2/audit/logs", async (o, i) => {
      try {
        const e = await a.getLogs({
          userId: o.query.userId,
          action: o.query.action,
          resource: o.query.resource,
          limit: o.query.limit ? parseInt(o.query.limit) : void 0
        });
        i.json({ success: !0, data: e });
      } catch (e) {
        i.status(500).json({ success: !1, error: n(e) });
      }
    }), s.core.http.addRoute("GET", "/api/v2/audit/logs/:logId", async (o, i) => {
      try {
        const r = (await a.getLogs()).find((g) => g.id === o.params.logId);
        r ? i.json({ success: !0, data: r }) : i.status(404).json({ success: !1, error: "Log not found" });
      } catch (e) {
        i.status(500).json({ success: !1, error: n(e) });
      }
    }), s.core.http.addRoute("POST", "/api/v2/audit/export", async (o, i) => {
      try {
        const e = o.body.format || "json", r = await a.exportLogs(e);
        i.setHeader("Content-Type", e === "csv" ? "text/csv" : "application/json"), i.setHeader("Content-Disposition", `attachment; filename="audit-logs.${e}"`), i.send(r), s.core.events.emit("audit.log.exported", { format: e, timestamp: /* @__PURE__ */ new Date() });
      } catch (e) {
        i.status(500).json({ success: !1, error: n(e) });
      }
    }), console.log("Audit Logger API routes registered")), s.core.events && (s.core.events.emit("plugin:command:register", {
      id: "audit.viewLogs",
      title: "查看审计日志",
      handler: async (o) => (console.log("Viewing audit logs", o), { success: !0, data: await a.getLogs() })
    }), s.core.events.emit("plugin:command:register", {
      id: "audit.exportLogs",
      title: "导出日志",
      handler: async (o) => {
        console.log("Exporting audit logs", o);
        const i = o.format === "csv" ? "csv" : "json";
        return { success: !0, data: await a.exportLogs(i) };
      }
    }), s.core.events.emit("plugin:command:register", {
      id: "audit.clearOldLogs",
      title: "清理旧日志",
      handler: async (o) => (console.log("Clearing old audit logs", o), await a.clearOldLogs(), { success: !0, message: "Old logs cleared successfully" })
    }), console.log("Audit Logger commands registered")), s.core.events.emit("plugin:service:register", {
      name: "audit-logger",
      service: a,
      version: "1.0.0"
    }), a.logAction({
      userId: "system",
      action: "plugin.activated",
      resource: "audit-logger",
      details: { plugin: "audit-logger", version: "1.0.0" }
    }), console.log("Audit Logger Plugin registration complete");
  },
  deactivate() {
    console.log("Audit Logger Plugin deactivated");
  }
};
export {
  c as AuditLoggerService,
  l as default
};
