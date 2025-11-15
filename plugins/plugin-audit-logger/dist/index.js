class g {
  constructor(t, s) {
    this.context = t, this.config = s;
  }
  async logAction(t) {
    const s = {
      id: this.generateId(),
      timestamp: /* @__PURE__ */ new Date(),
      ...t
    };
    try {
      await this.storeLogEntry(s), this.config.enableRealTimeLogging && this.context.core.events.emit("audit.log.created", s), console.log(`[audit-logger] Action logged: ${t.action} on ${t.resource}`);
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
    const s = await this.getLogs();
    if (t === "csv") {
      const o = ["ID", "Timestamp", "User ID", "Action", "Resource", "Details"], a = s.map((e) => [
        e.id,
        e.timestamp.toISOString(),
        e.userId,
        e.action,
        e.resource,
        JSON.stringify(e.details)
      ]);
      return [o, ...a].map((e) => e.join(",")).join(`
`);
    }
    return JSON.stringify(s, null, 2);
  }
  async clearOldLogs() {
    const t = /* @__PURE__ */ new Date();
    t.setDate(t.getDate() - this.config.logRetentionDays), console.log(`[audit-logger] Clearing logs older than ${t.toISOString()}`);
  }
}
const c = {
  activate(i) {
    console.log("Audit Logger Plugin activated");
    const t = {
      logRetentionDays: 365,
      enableRealTimeLogging: !0,
      logLevel: "info"
    }, s = new g(i, t);
    i.core.http && i.core.http.addRoute && (i.core.http.addRoute("GET", "/api/v2/audit/logs", async (o, a) => {
      try {
        const e = await s.getLogs({
          userId: o.query.userId,
          action: o.query.action,
          resource: o.query.resource,
          limit: o.query.limit ? parseInt(o.query.limit) : void 0
        });
        a.json({ success: !0, data: e });
      } catch (e) {
        a.status(500).json({ success: !1, error: e.message });
      }
    }), i.core.http.addRoute("GET", "/api/v2/audit/logs/:logId", async (o, a) => {
      try {
        const r = (await s.getLogs()).find((n) => n.id === o.params.logId);
        r ? a.json({ success: !0, data: r }) : a.status(404).json({ success: !1, error: "Log not found" });
      } catch (e) {
        a.status(500).json({ success: !1, error: e.message });
      }
    }), i.core.http.addRoute("POST", "/api/v2/audit/export", async (o, a) => {
      try {
        const e = o.body.format || "json", r = await s.exportLogs(e);
        a.setHeader("Content-Type", e === "csv" ? "text/csv" : "application/json"), a.setHeader("Content-Disposition", `attachment; filename="audit-logs.${e}"`), a.send(r), i.core.events.emit("audit.log.exported", { format: e, timestamp: /* @__PURE__ */ new Date() });
      } catch (e) {
        a.status(500).json({ success: !1, error: e.message });
      }
    }), console.log("Audit Logger API routes registered")), i.core.events && (i.core.events.emit("plugin:command:register", {
      id: "audit.viewLogs",
      title: "查看审计日志",
      handler: async (o) => (console.log("Viewing audit logs", o), { success: !0, data: await s.getLogs() })
    }), i.core.events.emit("plugin:command:register", {
      id: "audit.exportLogs",
      title: "导出日志",
      handler: async (o) => {
        console.log("Exporting audit logs", o);
        const a = o.format || "json";
        return { success: !0, data: await s.exportLogs(a) };
      }
    }), i.core.events.emit("plugin:command:register", {
      id: "audit.clearOldLogs",
      title: "清理旧日志",
      handler: async (o) => (console.log("Clearing old audit logs", o), await s.clearOldLogs(), { success: !0, message: "Old logs cleared successfully" })
    }), console.log("Audit Logger commands registered")), i.core.events.emit("plugin:service:register", {
      name: "audit-logger",
      service: s,
      version: "1.0.0"
    }), s.logAction({
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
  g as AuditLoggerService,
  c as default
};
