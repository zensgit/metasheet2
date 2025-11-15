"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.jsonError = jsonError;
exports.jsonOk = jsonOk;
function jsonError(res, status, code, message, details) {
    res.status(status).json({ ok: false, error: { code, message, details } });
}
function jsonOk(res, data, meta) {
    res.json({ ok: true, data, meta });
}
//# sourceMappingURL=response.js.map