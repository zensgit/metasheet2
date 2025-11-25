export function jsonError(res, status, code, message, details) {
    res.status(status).json({ ok: false, error: { code, message, details } });
}
export function jsonOk(res, data, meta) {
    res.json({ ok: true, data, meta });
}
//# sourceMappingURL=response.js.map