"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeViews = sanitizeViews;
function sanitizeViews(input) {
    if (!Array.isArray(input))
        return [];
    const out = [];
    for (const v of input) {
        if (!v || typeof v.id !== 'string' || typeof v.name !== 'string')
            continue;
        const item = {
            id: v.id,
            name: v.name
        };
        if (typeof v.component === 'string')
            item.component = v.component;
        out.push(item);
    }
    return out;
}
//# sourceMappingURL=views.js.map