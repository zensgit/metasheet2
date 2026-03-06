import { defineComponent as U, ref as R, reactive as G, onMounted as J, resolveComponent as y, createElementBlock as k, openBlock as P, createElementVNode as l, createVNode as n, withCtx as c, createTextVNode as h, toDisplayString as S, createCommentVNode as W } from "vue";
const Y = { class: "intelligent-restore-view" }, q = { class: "restore-header" }, j = { class: "restore-actions" }, K = { class: "restore-content" }, Z = { class: "history-list" }, Q = { class: "snapshot-list" }, X = { class: "storage-analytics" }, ee = { class: "analytics-cards" }, te = { class: "card-content" }, se = { class: "card-value" }, oe = { class: "card-content" }, ae = { class: "card-value" }, re = { class: "card-content" }, ne = { class: "card-value" }, ie = { class: "card-content" }, le = { class: "card-value" }, ce = {
  key: 0,
  class: "preview-content"
}, de = /* @__PURE__ */ U({
  __name: "IntelligentRestoreView",
  setup(m) {
    const e = R("history"), t = R(!1), s = R(null), a = R([]), o = R([]), i = G({
      totalSize: 0,
      savedSpace: 0,
      recordCount: 0,
      avgCompressionRatio: 0
    });
    J(() => {
      p(), v(), _();
    });
    function p() {
      a.value = [
        {
          id: "1",
          spreadsheetId: "sheet1",
          operationType: "数据编辑",
          operatorName: "张三",
          description: "修改A1:C10区域数据",
          timestamp: /* @__PURE__ */ new Date(),
          storageStrategy: "增量"
        },
        {
          id: "2",
          spreadsheetId: "sheet1",
          operationType: "格式调整",
          operatorName: "李四",
          description: "调整列宽和字体",
          timestamp: new Date(Date.now() - 36e5),
          storageStrategy: "快照"
        }
      ];
    }
    function v() {
      o.value = [
        {
          id: "1",
          name: "每日快照-2024-10-31",
          timestamp: /* @__PURE__ */ new Date(),
          size: 1024e3,
          compressionRatio: 0.65
        },
        {
          id: "2",
          name: "版本发布快照",
          timestamp: new Date(Date.now() - 864e5),
          size: 2048e3,
          compressionRatio: 0.58
        }
      ];
    }
    function _() {
      i.totalSize = 512e4, i.savedSpace = 2048e3, i.recordCount = 156, i.avgCompressionRatio = 0.62;
    }
    function w() {
      console.log("执行智能恢复");
    }
    function b() {
      console.log("执行列恢复");
    }
    function C() {
      console.log("执行快照恢复");
    }
    function D(f) {
      console.log("恢复记录:", f);
    }
    function H(f) {
      s.value = f, t.value = !0;
    }
    function B(f) {
      console.log("恢复快照:", f);
    }
    function $(f) {
      console.log("删除快照:", f);
    }
    function A(f) {
      return new Date(f).toLocaleString("zh-CN");
    }
    function O(f) {
      const r = ["B", "KB", "MB", "GB"];
      let g = f, u = 0;
      for (; g >= 1024 && u < r.length - 1; )
        g /= 1024, u++;
      return `${g.toFixed(1)} ${r[u]}`;
    }
    return (f, r) => {
      const g = y("el-button"), u = y("el-table-column"), L = y("el-table"), T = y("el-tab-pane"), M = y("el-card"), F = y("el-tabs"), V = y("el-dialog");
      return P(), k("div", Y, [
        l("div", q, [
          r[5] || (r[5] = l("h3", null, "智能恢复系统", -1)),
          l("div", j, [
            n(g, {
              type: "primary",
              onClick: w
            }, {
              default: c(() => [...r[2] || (r[2] = [
                h("智能恢复", -1)
              ])]),
              _: 1
            }),
            n(g, { onClick: b }, {
              default: c(() => [...r[3] || (r[3] = [
                h("列恢复", -1)
              ])]),
              _: 1
            }),
            n(g, { onClick: C }, {
              default: c(() => [...r[4] || (r[4] = [
                h("快照恢复", -1)
              ])]),
              _: 1
            })
          ])
        ]),
        l("div", K, [
          n(F, {
            modelValue: e.value,
            "onUpdate:modelValue": r[0] || (r[0] = (d) => e.value = d),
            class: "restore-tabs"
          }, {
            default: c(() => [
              n(T, {
                label: "历史记录",
                name: "history"
              }, {
                default: c(() => [
                  l("div", Z, [
                    n(L, {
                      data: a.value,
                      style: { width: "100%" }
                    }, {
                      default: c(() => [
                        n(u, {
                          prop: "timestamp",
                          label: "时间",
                          width: "200"
                        }, {
                          default: c((d) => [
                            h(S(A(d.row.timestamp)), 1)
                          ]),
                          _: 1
                        }),
                        n(u, {
                          prop: "operationType",
                          label: "操作类型",
                          width: "120"
                        }),
                        n(u, {
                          prop: "operatorName",
                          label: "操作者",
                          width: "100"
                        }),
                        n(u, {
                          prop: "description",
                          label: "描述"
                        }),
                        n(u, {
                          prop: "storageStrategy",
                          label: "存储策略",
                          width: "100"
                        }),
                        n(u, {
                          label: "操作",
                          width: "200"
                        }, {
                          default: c((d) => [
                            n(g, {
                              size: "small",
                              onClick: (N) => D(d.row)
                            }, {
                              default: c(() => [...r[6] || (r[6] = [
                                h("恢复", -1)
                              ])]),
                              _: 1
                            }, 8, ["onClick"]),
                            n(g, {
                              size: "small",
                              type: "info",
                              onClick: (N) => H(d.row)
                            }, {
                              default: c(() => [...r[7] || (r[7] = [
                                h("预览", -1)
                              ])]),
                              _: 1
                            }, 8, ["onClick"])
                          ]),
                          _: 1
                        })
                      ]),
                      _: 1
                    }, 8, ["data"])
                  ])
                ]),
                _: 1
              }),
              n(T, {
                label: "快照管理",
                name: "snapshots"
              }, {
                default: c(() => [
                  l("div", Q, [
                    n(L, {
                      data: o.value,
                      style: { width: "100%" }
                    }, {
                      default: c(() => [
                        n(u, {
                          prop: "timestamp",
                          label: "创建时间",
                          width: "200"
                        }, {
                          default: c((d) => [
                            h(S(A(d.row.timestamp)), 1)
                          ]),
                          _: 1
                        }),
                        n(u, {
                          prop: "name",
                          label: "快照名称"
                        }),
                        n(u, {
                          prop: "size",
                          label: "大小",
                          width: "100"
                        }, {
                          default: c((d) => [
                            h(S(O(d.row.size)), 1)
                          ]),
                          _: 1
                        }),
                        n(u, {
                          prop: "compressionRatio",
                          label: "压缩比",
                          width: "100"
                        }, {
                          default: c((d) => [
                            h(S((d.row.compressionRatio * 100).toFixed(1)) + "% ", 1)
                          ]),
                          _: 1
                        }),
                        n(u, {
                          label: "操作",
                          width: "200"
                        }, {
                          default: c((d) => [
                            n(g, {
                              size: "small",
                              type: "primary",
                              onClick: (N) => B(d.row)
                            }, {
                              default: c(() => [...r[8] || (r[8] = [
                                h("恢复", -1)
                              ])]),
                              _: 1
                            }, 8, ["onClick"]),
                            n(g, {
                              size: "small",
                              type: "danger",
                              onClick: (N) => $(d.row)
                            }, {
                              default: c(() => [...r[9] || (r[9] = [
                                h("删除", -1)
                              ])]),
                              _: 1
                            }, 8, ["onClick"])
                          ]),
                          _: 1
                        })
                      ]),
                      _: 1
                    }, 8, ["data"])
                  ])
                ]),
                _: 1
              }),
              n(T, {
                label: "存储分析",
                name: "analytics"
              }, {
                default: c(() => [
                  l("div", X, [
                    l("div", ee, [
                      n(M, { class: "analytics-card" }, {
                        default: c(() => [
                          l("div", te, [
                            r[10] || (r[10] = l("div", { class: "card-title" }, "总存储空间", -1)),
                            l("div", se, S(O(i.totalSize)), 1)
                          ])
                        ]),
                        _: 1
                      }),
                      n(M, { class: "analytics-card" }, {
                        default: c(() => [
                          l("div", oe, [
                            r[11] || (r[11] = l("div", { class: "card-title" }, "压缩节省", -1)),
                            l("div", ae, S(O(i.savedSpace)), 1)
                          ])
                        ]),
                        _: 1
                      }),
                      n(M, { class: "analytics-card" }, {
                        default: c(() => [
                          l("div", re, [
                            r[12] || (r[12] = l("div", { class: "card-title" }, "记录数量", -1)),
                            l("div", ne, S(i.recordCount), 1)
                          ])
                        ]),
                        _: 1
                      }),
                      n(M, { class: "analytics-card" }, {
                        default: c(() => [
                          l("div", ie, [
                            r[13] || (r[13] = l("div", { class: "card-title" }, "平均压缩比", -1)),
                            l("div", le, S((i.avgCompressionRatio * 100).toFixed(1)) + "%", 1)
                          ])
                        ]),
                        _: 1
                      })
                    ]),
                    r[14] || (r[14] = l("div", { class: "analytics-chart" }, [
                      l("h4", null, "存储趋势"),
                      l("div", { class: "chart-placeholder" }, [
                        l("p", null, "存储趋势图表将在此处显示")
                      ])
                    ], -1))
                  ])
                ]),
                _: 1
              })
            ]),
            _: 1
          }, 8, ["modelValue"])
        ]),
        n(V, {
          modelValue: t.value,
          "onUpdate:modelValue": r[1] || (r[1] = (d) => t.value = d),
          title: "历史记录预览",
          width: "80%"
        }, {
          default: c(() => [
            s.value ? (P(), k("div", ce, [
              l("pre", null, S(JSON.stringify(s.value, null, 2)), 1)
            ])) : W("", !0)
          ]),
          _: 1
        }, 8, ["modelValue"])
      ]);
    };
  }
}), pe = (m, e) => {
  const t = m.__vccOpts || m;
  for (const [s, a] of e)
    t[s] = a;
  return t;
}, ue = /* @__PURE__ */ pe(de, [["__scopeId", "data-v-aaaef4de"]]), me = new TextEncoder(), fe = new TextDecoder();
class x {
  async compress(e) {
    const t = JSON.stringify(e), s = t.length, a = this.simpleCompress(t), o = a.length;
    return {
      data: a,
      algorithm: "simple-lz",
      originalSize: s,
      compressedSize: o,
      ratio: s === 0 ? 0 : Math.round(o / s * 100)
    };
  }
  async decompress(e) {
    const t = this.simpleDecompress(e);
    return JSON.parse(t);
  }
  calculateEfficiency(e, t) {
    const s = e === 0 ? 0 : Math.round(t / e * 100), a = Math.max(0, e - t);
    let o = "低";
    return s < 50 ? o = "高" : s < 75 && (o = "中"), {
      ratio: s,
      saved: a,
      efficiency: o
    };
  }
  async batchCompress(e) {
    const t = [];
    for (const s of e)
      t.push(await this.compress(s));
    return t;
  }
  shouldCompress(e) {
    const t = JSON.stringify(e);
    return t.length < 1024 ? !1 : new Set(t).size / t.length < 0.5;
  }
  simpleCompress(e) {
    if (!e)
      return "";
    const t = /* @__PURE__ */ new Map();
    for (let i = 0; i < 256; i += 1)
      t.set(String.fromCharCode(i), i);
    const s = [];
    let a = 256, o = "";
    for (const i of e) {
      const p = o + i;
      if (t.has(p)) {
        o = p;
        continue;
      }
      o && s.push(t.get(o) ?? o.charCodeAt(0)), t.set(p, a), a += 1, o = i;
    }
    return o && s.push(t.get(o) ?? o.charCodeAt(0)), this.encodeBase64(JSON.stringify(s));
  }
  simpleDecompress(e) {
    if (!e)
      return "";
    const t = JSON.parse(this.decodeBase64(e));
    if (t.length === 0)
      return "";
    const s = /* @__PURE__ */ new Map();
    for (let p = 0; p < 256; p += 1)
      s.set(p, String.fromCharCode(p));
    let a = 256, o = s.get(t[0]) ?? "", i = o;
    for (let p = 1; p < t.length; p += 1) {
      const v = t[p], _ = s.get(v) ?? (v === a ? o + o.charAt(0) : "");
      if (!_)
        throw new Error(`Invalid compressed payload at code ${v}`);
      i += _, s.set(a, o + _.charAt(0)), a += 1, o = _;
    }
    return i;
  }
  encodeBase64(e) {
    if (typeof Buffer < "u")
      return Buffer.from(e, "utf8").toString("base64");
    const t = Array.from(me.encode(e), (s) => String.fromCharCode(s)).join("");
    return globalThis.btoa(t);
  }
  decodeBase64(e) {
    if (typeof Buffer < "u")
      return Buffer.from(e, "base64").toString("utf8");
    const t = globalThis.atob(e), s = Uint8Array.from(t, (a) => a.charCodeAt(0));
    return fe.decode(s);
  }
}
const ge = {
  cell_edit: 1,
  cell_format: 1,
  row_add: 2,
  row_delete: 2,
  column_add: 2,
  column_delete: 2,
  cell_comment: 1,
  bulk_edit: 5,
  bulk_delete: 5,
  column_rename: 4,
  formula_update: 4,
  filter_apply: 3,
  sort_apply: 3,
  import_data: 10,
  bulk_import: 10,
  table_restructure: 9,
  mass_delete: 8,
  snapshot_create: 7,
  version_restore: 8
}, E = {
  SMALL: 1024,
  MEDIUM: 10 * 1024,
  LARGE: 100 * 1024
}, z = {
  FEW: 10,
  MODERATE: 100,
  MANY: 1e3
};
class I {
  static classify(e, t, s, a) {
    const o = e.toLowerCase(), i = ge[o] ?? 5, p = this.calculateSizeScore(s), v = this.calculateRowScore(t), _ = i + p + v;
    let w, b, C = !1, D = !1;
    return _ <= 5 ? (w = "LIGHTWEIGHT", b = "FULL") : _ <= 10 ? (w = "MEDIUM", b = "COMPRESSED", C = !0) : (w = "HEAVYWEIGHT", b = "SNAPSHOT_ONLY", D = !0), (o.includes("import") || o.includes("bulk")) && (D = !0), s > E.MEDIUM && (C = !0), {
      class: w,
      storageStrategy: b,
      compressionNeeded: C,
      snapshotNeeded: D,
      estimatedSize: s
    };
  }
  static estimateStorageSize(e) {
    try {
      return JSON.stringify(e).length;
    } catch {
      return 0;
    }
  }
  static analyzePattern(e) {
    if (!e.length)
      return {
        pattern: "random",
        recommendation: "无操作记录"
      };
    if (e.filter((o) => {
      var i;
      return ((i = o.type) == null ? void 0 : i.includes("bulk")) || (o.affectedRows ?? 0) > 100;
    }).length > e.length / 2)
      return {
        pattern: "bulk",
        recommendation: "建议使用快照存储策略"
      };
    const s = e.map((o) => new Date(o.timestamp).getTime());
    let a = !0;
    for (let o = 1; o < s.length; o += 1)
      if (s[o] - s[o - 1] > 60 * 1e3) {
        a = !1;
        break;
      }
    return a ? {
      pattern: "sequential",
      recommendation: "建议合并连续操作"
    } : {
      pattern: "random",
      recommendation: "标准存储策略"
    };
  }
  static calculateSizeScore(e) {
    return e < E.SMALL ? 0 : e < E.MEDIUM ? 2 : e < E.LARGE ? 4 : 6;
  }
  static calculateRowScore(e) {
    return e < z.FEW ? 0 : e < z.MODERATE ? 2 : e < z.MANY ? 3 : 5;
  }
}
class he {
  constructor() {
    this.compressionService = new x(), this.storageMap = /* @__PURE__ */ new Map();
  }
  async storeHistoryRecord(e) {
    var t;
    try {
      const s = I.estimateStorageSize(e), a = I.classify(
        e.operationType,
        ((t = e.changes) == null ? void 0 : t.length) ?? 0,
        s,
        e.metadata
      );
      switch (console.log(`智能存储: ${e.operationType}
        分类: ${a.class}
        策略: ${a.storageStrategy}
        大小: ${s} bytes`), a.storageStrategy) {
        case "FULL":
          return await this.storeFull(e, s);
        case "COMPRESSED":
          return await this.storeCompressed(e);
        case "SNAPSHOT_ONLY":
          return await this.storeSnapshotOnly(e, s);
        default:
          return await this.storeFull(e, s);
      }
    } catch (s) {
      return console.error("智能存储失败:", s), await this.storeFull(e, I.estimateStorageSize(e));
    }
  }
  async retrieveHistoryRecord(e) {
    const t = this.storageMap.get(e);
    if (!t)
      return null;
    if (t._compressed && t._compressedData) {
      const s = await this.compressionService.decompress(t._compressedData);
      return {
        ...this.toPublicRecord(t),
        changes: s.changes,
        snapshot: s.snapshot
      };
    }
    return t._snapshotData ? {
      ...this.toPublicRecord(t),
      snapshot: t._snapshotData
    } : this.toPublicRecord(t);
  }
  getStorageStats() {
    let e = 0;
    const t = {
      full: 0,
      compressed: 0,
      snapshot: 0
    };
    for (const s of this.storageMap.values())
      e += I.estimateStorageSize(s), s._compressed ? t.compressed += 1 : s._snapshotData ? t.snapshot += 1 : t.full += 1;
    return {
      totalRecords: this.storageMap.size,
      totalSize: e,
      strategies: t
    };
  }
  async cleanupOldRecords(e = 30) {
    const t = /* @__PURE__ */ new Date();
    t.setDate(t.getDate() - e);
    let s = 0;
    const a = [];
    for (const [o, i] of this.storageMap.entries())
      i.timestamp < t && a.push(o);
    for (const o of a)
      this.storageMap.delete(o), s += 1;
    return s;
  }
  async storeFull(e, t) {
    const s = this.generateId();
    return this.storageMap.set(s, {
      ...e,
      id: s,
      timestamp: /* @__PURE__ */ new Date(),
      storageStrategy: "FULL"
    }), {
      success: !0,
      historyId: s,
      storageStrategy: "FULL_DETAIL",
      originalSize: t,
      storedSize: t,
      compressionRatio: 100
    };
  }
  async storeCompressed(e) {
    const t = this.generateId(), s = await this.compressionService.compress({
      changes: e.changes ?? [],
      snapshot: e.snapshot
    });
    return this.storageMap.set(t, {
      ...e,
      id: t,
      timestamp: /* @__PURE__ */ new Date(),
      storageStrategy: "COMPRESSED",
      _compressed: !0,
      _compressedData: s.data
    }), {
      success: !0,
      historyId: t,
      storageStrategy: "COMPRESSED_DETAIL",
      originalSize: s.originalSize,
      storedSize: s.compressedSize,
      compressionRatio: s.ratio
    };
  }
  async storeSnapshotOnly(e, t) {
    const s = this.generateId(), a = `snapshot_${this.generateId()}`, o = {
      id: a,
      spreadsheetId: e.spreadsheetId,
      data: e.snapshot ?? e.changes,
      createdAt: /* @__PURE__ */ new Date(),
      type: "operation"
    };
    return this.storageMap.set(s, {
      id: s,
      spreadsheetId: e.spreadsheetId,
      operationType: e.operationType,
      operatorId: e.operatorId,
      operatorName: e.operatorName,
      description: e.description,
      snapshotId: a,
      timestamp: /* @__PURE__ */ new Date(),
      storageStrategy: "SNAPSHOT_ONLY",
      _snapshotData: o
    }), {
      success: !0,
      historyId: s,
      storageStrategy: "SNAPSHOT_ONLY",
      originalSize: t,
      storedSize: 1024,
      compressionRatio: t > 0 ? Math.round(1024 / t * 100) : 100,
      snapshotId: a
    };
  }
  toPublicRecord(e) {
    const { _compressed: t, _compressedData: s, _snapshotData: a, ...o } = e;
    return o;
  }
  generateId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
}
const Se = {
  activate(m) {
    console.log("Intelligent Restore Plugin activated"), m.core.events.emit("plugin:component:register", {
      name: "intelligent-restore-view",
      component: ue,
      category: "tools",
      title: "智能恢复系统",
      description: "智能版本控制和恢复系统，支持智能存储、压缩、列级恢复等高级功能"
    }), m.core.events.emit("plugin:service:register", {
      name: "intelligent-storage",
      service: he,
      version: "1.0.0"
    }), m.core.events.emit("plugin:service:register", {
      name: "compression-service",
      service: x,
      version: "1.0.0"
    }), m.core.events.emit("plugin:service:register", {
      name: "operation-classifier",
      service: I,
      version: "1.0.0"
    }), m.core.events.emit("plugin:command:register", {
      id: "restore.smart",
      title: "智能恢复",
      handler: (e) => {
        console.log("智能恢复命令执行", e);
      }
    }), m.core.events.emit("plugin:command:register", {
      id: "restore.column",
      title: "列恢复",
      handler: (e) => {
        console.log("列恢复命令执行", e);
      }
    }), m.core.events.emit("plugin:command:register", {
      id: "restore.snapshot",
      title: "快照恢复",
      handler: (e) => {
        console.log("快照恢复命令执行", e);
      }
    }), console.log("Intelligent Restore Plugin registration complete");
  },
  deactivate() {
    console.log("Intelligent Restore Plugin deactivated");
  }
};
export {
  x as CompressionService,
  ue as IntelligentRestoreView,
  he as IntelligentStorageService,
  I as OperationClassifier,
  Se as default
};
