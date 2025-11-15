import { Registry as a, Counter as n, Histogram as o } from "prom-client";
function l() {
  return {
    enabled: process.env.FEATURE_OTEL === "true",
    serviceName: process.env.OTEL_SERVICE_NAME || "metasheet-v2",
    metricsPort: parseInt(process.env.OTEL_METRICS_PORT || "9464"),
    tracingSampleRate: parseFloat(process.env.OTEL_TRACE_SAMPLE_RATE || "0.1")
  };
}
function c() {
  const r = new a(), e = new n({
    name: "http_requests_total",
    help: "Total HTTP requests",
    labelNames: ["method", "path", "status"],
    registers: [r]
  }), s = new o({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "path"],
    buckets: [1e-3, 5e-3, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
    registers: [r]
  }), t = new n({
    name: "http_request_errors_total",
    help: "Total HTTP request errors",
    labelNames: ["method", "path", "errorType"],
    registers: [r]
  });
  return {
    httpRequestsTotal: e,
    httpRequestDuration: s,
    httpRequestErrors: t,
    registry: r
  };
}
class m {
  constructor() {
    this.config = l(), this.enabled = !1;
  }
  async onLoad(e) {
    if (!this.config.enabled) {
      e.logger.info("OpenTelemetry plugin is DISABLED (FEATURE_OTEL=false)");
      return;
    }
    e.logger.info("Initializing OpenTelemetry plugin...");
    try {
      this.metrics = c(), e.logger.info("✅ Metrics initialized"), e.app && (e.app.get("/metrics", async (s, t) => {
        if (!this.metrics) {
          t.status(503).send("Metrics not initialized");
          return;
        }
        try {
          t.set("Content-Type", this.metrics.registry.contentType);
          const i = await this.metrics.registry.metrics();
          t.end(i);
        } catch {
          t.status(500).send("Failed to collect metrics");
        }
      }), e.app.get("/metrics/otel", async (s, t) => {
        if (!this.metrics) {
          t.status(503).send("Metrics not initialized");
          return;
        }
        try {
          t.set("Content-Type", this.metrics.registry.contentType);
          const i = await this.metrics.registry.metrics();
          t.end(i);
        } catch {
          t.status(500).send("Failed to collect metrics");
        }
      }), e.logger.info(`✅ Metrics endpoints registered: /metrics and /metrics/otel (port ${this.config.metricsPort})`)), this.enabled = !0, e.logger.info("🎉 OpenTelemetry plugin initialized successfully");
    } catch (s) {
      throw e.logger.error(`Failed to initialize OpenTelemetry: ${s}`), s;
    }
  }
  async onUnload() {
    this.enabled = !1;
  }
  getMetrics() {
    return this.metrics;
  }
  isEnabled() {
    return this.enabled;
  }
}
export {
  m as default
};
