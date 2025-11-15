import { defineComponent as U, ref as I, reactive as G, onMounted as B, resolveComponent as S, createElementBlock as N, openBlock as L, createElementVNode as i, createVNode as r, withCtx as l, createTextVNode as h, toDisplayString as f, createCommentVNode as J } from "vue";
const Y = { class: "intelligent-restore-view" }, Z = { class: "restore-header" }, q = { class: "restore-actions" }, x = { class: "restore-content" }, j = { class: "history-list" }, K = { class: "snapshot-list" }, Q = { class: "storage-analytics" }, X = { class: "analytics-cards" }, ee = { class: "card-content" }, te = { class: "card-value" }, se = { class: "card-content" }, oe = { class: "card-value" }, ae = { class: "card-content" }, ne = { class: "card-value" }, re = { class: "card-content" }, ie = { class: "card-value" }, le = {
  key: 0,
  class: "preview-content"
}, ce = /* @__PURE__ */ U({
  __name: "IntelligentRestoreView",
  setup(u) {
    const e = I("history"), t = I(!1), s = I(null), a = I([]), o = I([]), c = G({
      totalSize: 0,
      savedSpace: 0,
      recordCount: 0,
      avgCompressionRatio: 0
    });
    B(() => {
      v(), _(), w();
    });
    function v() {
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
    function _() {
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
    function w() {
      c.totalSize = 512e4, c.savedSpace = 2048e3, c.recordCount = 156, c.avgCompressionRatio = 0.62;
    }
    function y() {
      console.log("执行智能恢复");
    }
    function E() {
      console.log("执行列恢复");
    }
    function b() {
      console.log("执行快照恢复");
    }
    function A(m) {
      console.log("恢复记录:", m);
    }
    function P(m) {
      s.value = m, t.value = !0;
    }
    function V(m) {
      console.log("恢复快照:", m);
    }
    function $(m) {
      console.log("删除快照:", m);
    }
    function T(m) {
      return new Date(m).toLocaleString("zh-CN");
    }
    function M(m) {
      const n = ["B", "KB", "MB", "GB"];
      let g = m, p = 0;
      for (; g >= 1024 && p < n.length - 1; )
        g /= 1024, p++;
      return `${g.toFixed(1)} ${n[p]}`;
    }
    return (m, n) => {
      const g = S("el-button"), p = S("el-table-column"), H = S("el-table"), D = S("el-tab-pane"), O = S("el-card"), F = S("el-tabs"), W = S("el-dialog");
      return L(), N("div", Y, [
        i("div", Z, [
          n[5] || (n[5] = i("h3", null, "智能恢复系统", -1)),
          i("div", q, [
            r(g, {
              type: "primary",
              onClick: y
            }, {
              default: l(() => [...n[2] || (n[2] = [
                h("智能恢复", -1)
              ])]),
              _: 1
            }),
            r(g, { onClick: E }, {
              default: l(() => [...n[3] || (n[3] = [
                h("列恢复", -1)
              ])]),
              _: 1
            }),
            r(g, { onClick: b }, {
              default: l(() => [...n[4] || (n[4] = [
                h("快照恢复", -1)
              ])]),
              _: 1
            })
          ])
        ]),
        i("div", x, [
          r(F, {
            modelValue: e.value,
            "onUpdate:modelValue": n[0] || (n[0] = (d) => e.value = d),
            class: "restore-tabs"
          }, {
            default: l(() => [
              r(D, {
                label: "历史记录",
                name: "history"
              }, {
                default: l(() => [
                  i("div", j, [
                    r(H, {
                      data: a.value,
                      style: { width: "100%" }
                    }, {
                      default: l(() => [
                        r(p, {
                          prop: "timestamp",
                          label: "时间",
                          width: "200"
                        }, {
                          default: l((d) => [
                            h(f(T(d.row.timestamp)), 1)
                          ]),
                          _: 1
                        }),
                        r(p, {
                          prop: "operationType",
                          label: "操作类型",
                          width: "120"
                        }),
                        r(p, {
                          prop: "operatorName",
                          label: "操作者",
                          width: "100"
                        }),
                        r(p, {
                          prop: "description",
                          label: "描述"
                        }),
                        r(p, {
                          prop: "storageStrategy",
                          label: "存储策略",
                          width: "100"
                        }),
                        r(p, {
                          label: "操作",
                          width: "200"
                        }, {
                          default: l((d) => [
                            r(g, {
                              size: "small",
                              onClick: (z) => A(d.row)
                            }, {
                              default: l(() => [...n[6] || (n[6] = [
                                h("恢复", -1)
                              ])]),
                              _: 1
                            }, 8, ["onClick"]),
                            r(g, {
                              size: "small",
                              type: "info",
                              onClick: (z) => P(d.row)
                            }, {
                              default: l(() => [...n[7] || (n[7] = [
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
              r(D, {
                label: "快照管理",
                name: "snapshots"
              }, {
                default: l(() => [
                  i("div", K, [
                    r(H, {
                      data: o.value,
                      style: { width: "100%" }
                    }, {
                      default: l(() => [
                        r(p, {
                          prop: "timestamp",
                          label: "创建时间",
                          width: "200"
                        }, {
                          default: l((d) => [
                            h(f(T(d.row.timestamp)), 1)
                          ]),
                          _: 1
                        }),
                        r(p, {
                          prop: "name",
                          label: "快照名称"
                        }),
                        r(p, {
                          prop: "size",
                          label: "大小",
                          width: "100"
                        }, {
                          default: l((d) => [
                            h(f(M(d.row.size)), 1)
                          ]),
                          _: 1
                        }),
                        r(p, {
                          prop: "compressionRatio",
                          label: "压缩比",
                          width: "100"
                        }, {
                          default: l((d) => [
                            h(f((d.row.compressionRatio * 100).toFixed(1)) + "% ", 1)
                          ]),
                          _: 1
                        }),
                        r(p, {
                          label: "操作",
                          width: "200"
                        }, {
                          default: l((d) => [
                            r(g, {
                              size: "small",
                              type: "primary",
                              onClick: (z) => V(d.row)
                            }, {
                              default: l(() => [...n[8] || (n[8] = [
                                h("恢复", -1)
                              ])]),
                              _: 1
                            }, 8, ["onClick"]),
                            r(g, {
                              size: "small",
                              type: "danger",
                              onClick: (z) => $(d.row)
                            }, {
                              default: l(() => [...n[9] || (n[9] = [
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
              r(D, {
                label: "存储分析",
                name: "analytics"
              }, {
                default: l(() => [
                  i("div", Q, [
                    i("div", X, [
                      r(O, { class: "analytics-card" }, {
                        default: l(() => [
                          i("div", ee, [
                            n[10] || (n[10] = i("div", { class: "card-title" }, "总存储空间", -1)),
                            i("div", te, f(M(c.totalSize)), 1)
                          ])
                        ]),
                        _: 1
                      }),
                      r(O, { class: "analytics-card" }, {
                        default: l(() => [
                          i("div", se, [
                            n[11] || (n[11] = i("div", { class: "card-title" }, "压缩节省", -1)),
                            i("div", oe, f(M(c.savedSpace)), 1)
                          ])
                        ]),
                        _: 1
                      }),
                      r(O, { class: "analytics-card" }, {
                        default: l(() => [
                          i("div", ae, [
                            n[12] || (n[12] = i("div", { class: "card-title" }, "记录数量", -1)),
                            i("div", ne, f(c.recordCount), 1)
                          ])
                        ]),
                        _: 1
                      }),
                      r(O, { class: "analytics-card" }, {
                        default: l(() => [
                          i("div", re, [
                            n[13] || (n[13] = i("div", { class: "card-title" }, "平均压缩比", -1)),
                            i("div", ie, f((c.avgCompressionRatio * 100).toFixed(1)) + "%", 1)
                          ])
                        ]),
                        _: 1
                      })
                    ]),
                    n[14] || (n[14] = i("div", { class: "analytics-chart" }, [
                      i("h4", null, "存储趋势"),
                      i("div", { class: "chart-placeholder" }, [
                        i("p", null, "存储趋势图表将在此处显示")
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
        r(W, {
          modelValue: t.value,
          "onUpdate:modelValue": n[1] || (n[1] = (d) => t.value = d),
          title: "历史记录预览",
          width: "80%"
        }, {
          default: l(() => [
            s.value ? (L(), N("div", le, [
              i("pre", null, f(JSON.stringify(s.value, null, 2)), 1)
            ])) : J("", !0)
          ]),
          _: 1
        }, 8, ["modelValue"])
      ]);
    };
  }
}), de = (u, e) => {
  const t = u.__vccOpts || u;
  for (const [s, a] of e)
    t[s] = a;
  return t;
}, pe = /* @__PURE__ */ de(ce, [["__scopeId", "data-v-5a7fb568"]]), C = class C {
  /**
   * 分类操作
   */
  static classify(e, t, s, a) {
    const o = this.OPERATION_WEIGHTS[e] || 5, c = this.calculateSizeScore(s), v = this.calculateRowScore(t), _ = o + c + v;
    let w, y, E = !1, b = !1;
    return _ <= 5 ? (w = "LIGHTWEIGHT", y = "FULL") : _ <= 10 ? (w = "MEDIUM", y = "COMPRESSED", E = !0) : (w = "HEAVYWEIGHT", y = "SNAPSHOT_ONLY", b = !0), (e.includes("import") || e.includes("bulk")) && (b = !0), s > this.SIZE_THRESHOLDS.MEDIUM && (E = !0), {
      class: w,
      storageStrategy: y,
      compressionNeeded: E,
      snapshotNeeded: b,
      estimatedSize: s
    };
  }
  /**
   * 计算数据大小得分
   */
  static calculateSizeScore(e) {
    return e < this.SIZE_THRESHOLDS.SMALL ? 0 : e < this.SIZE_THRESHOLDS.MEDIUM ? 2 : e < this.SIZE_THRESHOLDS.LARGE ? 4 : 6;
  }
  /**
   * 计算行数得分
   */
  static calculateRowScore(e) {
    return e < this.ROW_THRESHOLDS.FEW ? 0 : e < this.ROW_THRESHOLDS.MODERATE ? 2 : e < this.ROW_THRESHOLDS.MANY ? 3 : 5;
  }
  /**
   * 估算存储大小
   */
  static estimateStorageSize(e) {
    try {
      return JSON.stringify(e).length;
    } catch {
      return 0;
    }
  }
  /**
   * 分析操作模式
   */
  static analyzePattern(e) {
    if (!e || e.length === 0)
      return {
        pattern: "random",
        recommendation: "无操作记录"
      };
    if (e.filter(
      (o) => o.type?.includes("bulk") || o.affectedRows > 100
    ).length > e.length / 2)
      return {
        pattern: "bulk",
        recommendation: "建议使用快照存储策略"
      };
    const s = e.map((o) => new Date(o.timestamp).getTime());
    let a = !0;
    for (let o = 1; o < s.length; o++)
      if (s[o] - s[o - 1] > 6e4) {
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
};
C.OPERATION_WEIGHTS = {
  // 轻量级操作 (权重 1-3)
  cell_edit: 1,
  cell_format: 1,
  row_add: 2,
  row_delete: 2,
  column_add: 2,
  column_delete: 2,
  cell_comment: 1,
  // 中等操作 (权重 4-6)
  bulk_edit: 5,
  bulk_delete: 5,
  column_rename: 4,
  formula_update: 4,
  filter_apply: 3,
  sort_apply: 3,
  // 重量级操作 (权重 7-10)
  import_data: 10,
  bulk_import: 10,
  table_restructure: 9,
  mass_delete: 8,
  snapshot_create: 7,
  version_restore: 8
}, C.SIZE_THRESHOLDS = {
  SMALL: 1024,
  // 1KB
  MEDIUM: 10240,
  // 10KB
  LARGE: 102400
  // 100KB
}, C.ROW_THRESHOLDS = {
  FEW: 10,
  MODERATE: 100,
  MANY: 1e3
};
let R = C;
class k {
  /**
   * 压缩数据
   */
  async compress(e) {
    const t = JSON.stringify(e), s = t.length, a = this.simpleCompress(t), o = a.length;
    return {
      data: a,
      algorithm: "simple-lz",
      originalSize: s,
      compressedSize: o,
      ratio: Math.round(o / s * 100)
    };
  }
  /**
   * 解压数据
   */
  async decompress(e) {
    const t = this.simpleDecompress(e);
    return JSON.parse(t);
  }
  /**
   * 简单的压缩算法（LZ风格）
   */
  simpleCompress(e) {
    if (!e) return "";
    const t = /* @__PURE__ */ new Map(), s = [];
    let a = 256, o = "";
    for (let c = 0; c < e.length; c++) {
      const v = e.charAt(c), _ = o + v;
      t.has(_) ? o = _ : (o && s.push(t.get(o) || o.charCodeAt(0)), t.set(_, a++), o = v);
    }
    return o && s.push(t.get(o) || o.charCodeAt(0)), btoa(s.join(","));
  }
  /**
   * 简单的解压算法
   */
  simpleDecompress(e) {
    if (!e) return "";
    try {
      return atob(e).split(",").map((s) => {
        const a = parseInt(s);
        return isNaN(a) ? s : String.fromCharCode(a);
      }).join("");
    } catch {
      return e;
    }
  }
  /**
   * 计算压缩效率
   */
  calculateEfficiency(e, t) {
    const s = Math.round(t / e * 100), a = e - t;
    let o = "低";
    return s < 50 ? o = "高" : s < 75 && (o = "中"), {
      ratio: s,
      saved: a,
      efficiency: o
    };
  }
  /**
   * 批量压缩
   */
  async batchCompress(e) {
    const t = [];
    for (const s of e) {
      const a = await this.compress(s);
      t.push(a);
    }
    return t;
  }
  /**
   * 智能压缩决策
   */
  shouldCompress(e) {
    if (JSON.stringify(e).length < 1024)
      return !1;
    const s = JSON.stringify(e);
    return new Set(s).size / s.length < 0.5;
  }
}
class ue {
  constructor() {
    this.compressionService = new k(), this.storageMap = /* @__PURE__ */ new Map();
  }
  /**
   * 智能存储历史记录
   */
  async storeHistoryRecord(e) {
    try {
      const t = R.estimateStorageSize(e), s = R.classify(
        e.operationType,
        e.changes?.length || 0,
        t,
        e.metadata
      );
      console.log(`智能存储: ${e.operationType}
        分类: ${s.class}
        策略: ${s.storageStrategy}
        大小: ${t} bytes`);
      let a;
      switch (s.storageStrategy) {
        case "FULL":
          a = await this.storeFull(e, t);
          break;
        case "COMPRESSED":
          a = await this.storeCompressed(e, t, s);
          break;
        case "SNAPSHOT_ONLY":
          a = await this.storeSnapshotOnly(e, t, s);
          break;
        default:
          a = await this.storeFull(e, t);
      }
      return a;
    } catch (t) {
      return console.error("智能存储失败:", t), await this.storeFull(e, 0);
    }
  }
  /**
   * 完整存储（轻量级操作）
   */
  async storeFull(e, t) {
    const s = this.generateId();
    return this.storageMap.set(s, {
      ...e,
      id: s,
      timestamp: /* @__PURE__ */ new Date()
    }), {
      success: !0,
      historyId: s,
      storageStrategy: "FULL_DETAIL",
      originalSize: t,
      storedSize: t,
      compressionRatio: 100
    };
  }
  /**
   * 压缩存储（中等操作）
   */
  async storeCompressed(e, t, s) {
    const a = this.generateId(), o = await this.compressionService.compress({
      changes: e.changes || [],
      snapshot: e.snapshot
    });
    return this.storageMap.set(a, {
      ...e,
      id: a,
      timestamp: /* @__PURE__ */ new Date(),
      _compressed: !0,
      _compressedData: o.data
    }), {
      success: !0,
      historyId: a,
      storageStrategy: "COMPRESSED_DETAIL",
      originalSize: o.originalSize,
      storedSize: o.compressedSize,
      compressionRatio: o.ratio
    };
  }
  /**
   * 仅快照存储（重量级操作）
   */
  async storeSnapshotOnly(e, t, s) {
    const a = this.generateId(), o = `snapshot_${this.generateId()}`, c = {
      id: o,
      spreadsheetId: e.spreadsheetId,
      data: e.snapshot || e.changes,
      createdAt: /* @__PURE__ */ new Date(),
      type: "operation"
    };
    return this.storageMap.set(a, {
      id: a,
      spreadsheetId: e.spreadsheetId,
      operationType: e.operationType,
      operatorId: e.operatorId,
      operatorName: e.operatorName,
      description: e.description,
      snapshotId: o,
      timestamp: /* @__PURE__ */ new Date(),
      _snapshotData: c
    }), {
      success: !0,
      historyId: a,
      storageStrategy: "SNAPSHOT_ONLY",
      originalSize: t,
      storedSize: 1024,
      // 快照引用的固定开销
      compressionRatio: t > 0 ? Math.round(1024 / t * 100) : 100,
      snapshotId: o
    };
  }
  /**
   * 检索历史记录
   */
  async retrieveHistoryRecord(e) {
    const t = this.storageMap.get(e);
    if (!t) return null;
    if (t._compressed) {
      const s = await this.compressionService.decompress(
        t._compressedData
      );
      return {
        ...t,
        changes: s.changes,
        snapshot: s.snapshot
      };
    }
    return t._snapshotData ? {
      ...t,
      snapshot: t._snapshotData
    } : t;
  }
  /**
   * 获取存储统计
   */
  getStorageStats() {
    let e = 0;
    const t = {
      full: 0,
      compressed: 0,
      snapshot: 0
    };
    return this.storageMap.forEach((s) => {
      e += R.estimateStorageSize(s), s._compressed ? t.compressed++ : s._snapshotData ? t.snapshot++ : t.full++;
    }), {
      totalRecords: this.storageMap.size,
      totalSize: e,
      strategies: t
    };
  }
  /**
   * 清理过期记录
   */
  async cleanupOldRecords(e = 30) {
    const t = /* @__PURE__ */ new Date();
    t.setDate(t.getDate() - e);
    let s = 0;
    const a = [];
    return this.storageMap.forEach((o, c) => {
      o.timestamp && o.timestamp < t && a.push(c);
    }), a.forEach((o) => {
      this.storageMap.delete(o), s++;
    }), s;
  }
  /**
   * 生成唯一ID
   */
  generateId() {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
const ge = {
  activate(u) {
    console.log("Intelligent Restore Plugin activated"), u.core.events.emit("plugin:component:register", {
      name: "intelligent-restore-view",
      component: pe,
      category: "tools",
      title: "智能恢复系统",
      description: "智能版本控制和恢复系统，支持智能存储、压缩、列级恢复等高级功能"
    }), u.core.events.emit("plugin:service:register", {
      name: "intelligent-storage",
      service: ue,
      version: "1.0.0"
    }), u.core.events.emit("plugin:service:register", {
      name: "compression-service",
      service: k,
      version: "1.0.0"
    }), u.core.events.emit("plugin:service:register", {
      name: "operation-classifier",
      service: R,
      version: "1.0.0"
    }), u.core.events.emit("plugin:command:register", {
      id: "restore.smart",
      title: "智能恢复",
      handler: (e) => {
        console.log("智能恢复命令执行", e);
      }
    }), u.core.events.emit("plugin:command:register", {
      id: "restore.column",
      title: "列恢复",
      handler: (e) => {
        console.log("列恢复命令执行", e);
      }
    }), u.core.events.emit("plugin:command:register", {
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
  k as CompressionService,
  pe as IntelligentRestoreView,
  ue as IntelligentStorageService,
  R as OperationClassifier,
  ge as default
};
