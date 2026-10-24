import { computed, onScopeDispose, reactive, watch } from 'vue'
import { clone, equal as equalValue, need, isObject, isHash, type PlanPayload } from '../../services/welding/planRecovery'
import { WELDING_CAD_PIN, type CadContext } from '../../services/welding/planClient'
import type { RequestScope } from '../../services/welding/planClient'
import { createCadBridge, type CadWire } from '../../services/welding/cadBridge'
import type { useWeldingPlanSession } from './useWeldingPlanSession'

// Bounded business validators ported from the actual Y parent. Explicit dynamic
// JSON parameters are validated before use; unknown business fields survive cloning.
const roleRecords = (binding: any): any => binding.representations || [binding];
const geometryIds = (binding: any): any => roleRecords(binding).flatMap((rep: any): any => rep.entity_ids);
const roleIds = (binding: any): any => binding.representations ? binding.representations.flatMap(roleIds) : [...binding.entity_ids, ...[binding.label_id, binding.leader_id].filter((id: any): any => id != null)];
const withAux = (binding: any): any => binding.representations ? clone(binding) : ({ ...binding, label_id: binding.label_id ?? null, leader_id: binding.leader_id ?? null });
function validDisplayNumber(value: any): any {
    const edge = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u, chars = typeof value === 'string' ? Array.from(value) : [];
    return chars.length > 0 && chars.length <= 64 && !edge.test(chars[0]) && !edge.test(chars.at(-1)!) && !/[\r\n\0]/u.test(value) && !chars.some((c: any): any => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff);
}
function weldSelection(payload: any, selection: any): any {
    const selected = new Set(selection.entity_ids), bindings = payload.overlay?.bindings || [];
    const matched = bindings.filter((binding: any): any => roleIds(binding).some((id: any): any => selected.has(id)));
    const weldIds = payload.welds.filter((weld: any): any => matched.some((binding: any): any => binding.weld_id === weld.weld_id)).map((weld: any): any => weld.weld_id);
    const primary = selection.primary_id === null ? null : matched.find((binding: any): any => roleIds(binding).includes(selection.primary_id));
    return { weldIds, primaryWeldId: primary?.weld_id || (weldIds.length === 1 ? weldIds[0] : '') };
}
function bindingsForWeld(payload: any, weldId: any, entityIds: any, remove: any = false): any {
    if (!payload.welds.some((weld: any): any => weld.weld_id === weldId))
        throw new Error('请明确选择绑定目标焊缝');
    if (payload.overlay?.schema === 'vemcad-weld-overlay/3')
        throw new Error('请使用明确的表示操作绑定或移除几何');
    const existing = payload.overlay?.bindings || [], v2 = payload.overlay?.schema === 'vemcad-weld-overlay/2', target = existing.find((row: any): any => row.weld_id === weldId);
    if (v2 && (remove && (target?.label_id != null || target?.leader_id != null) || entityIds.some((id: any): any => !['line', 'arc', 'polyline'].includes(payload.overlay.snapshot.entities.find((e: any): any => e.id === id)?.type) || existing.some((b: any): any => b.label_id === id || b.leader_id === id))))
        throw new Error('仅可绑定几何；已有标注请通过业务删除或移除引线');
    if (remove)
        return existing.filter((row: any): any => row.weld_id !== weldId);
    const others = existing.filter((row: any): any => row.weld_id !== weldId).map((row: any): any => ({ ...row, entity_ids: row.entity_ids.filter((id: any): any => !entityIds.includes(id)) }));
    if (others.some((b: any): any => !b.entity_ids.length && (b.label_id != null || b.leader_id != null)))
        throw new Error('不能转移已标注焊缝的全部几何');
    const next = { ...(target || { weld_id: weldId }), entity_ids: [...new Set([...(target?.entity_ids || []), ...entityIds])] };
    return [...others.filter((row: any): any => row.entity_ids.length), v2 ? withAux(next) : next];
}
function nextWeldNumber(payload: any): any {
    const used = new Set(payload.welds.map((weld: any): any => weld.display_no));
    let number = 1;
    while (used.has(`W${number}`))
        number += 1;
    return `W${number}`;
}
function copySource(payload: any, id: any): any {
    const weld = payload.welds.find((row: any): any => row.weld_id === id), binding = payload.overlay?.bindings.find((row: any): any => row.weld_id === id);
    if (!weld || !binding || !geometryIds(binding).length || roleIds(binding).some((entity: any): any => !payload.overlay.snapshot.entities.some((row: any): any => row.id === entity)))
        throw new Error('焊缝或完整图形绑定不可用');
    return { weld, binding };
}
function unusedWeldIdentity(payload: any, weld: any): any {
    for (const value of [weld.weld_id, weld.display_no])
        if (typeof value !== 'string' || !value || Array.from(value).length > 64 || value !== value.trim() || /[\r\n\0]/u.test(value))
            throw new Error('新焊缝 ID 和显示号必须为非空有效单行文本');
    if (payload.welds.some((row: any): any => row.weld_id === weld.weld_id || row.display_no === weld.display_no))
        throw new Error('新焊缝 ID 或显示号已被使用');
}
function copiedPayload(payload: any, candidate: any, overlay: any = payload.overlay): any {
    const next = clone(payload);
    next.welds.push(clone(candidate.weld));
    if (candidate.processRefs.length)
        next.process_refs = [...(next.process_refs || []), ...clone(candidate.processRefs)];
    if (candidate.resourceRefs.length)
        next.resource_refs = [...(next.resource_refs || []), ...clone(candidate.resourceRefs)];
    if (overlay != null)
        next.overlay = clone(overlay);
    validatePayload(next);
    if ((next.process_refs?.length || 0) > 500 || (next.resource_refs || []).length > 500 || new TextEncoder().encode(JSON.stringify(next)).byteLength > 5 * 1024 * 1024)
        throw new Error('复制后资料引用或工艺包正文超过上限');
    return next;
}
function prepareWeldCopy(session: any, { sourceWeldId, newWeldId, displayNo = nextWeldNumber(session.state.payload), copyParams, copyRefs }: any, uuid: any): any {
    const payload = session.state.payload;
    validatePayload(payload);
    if (typeof copyParams !== 'boolean' || typeof copyRefs !== 'boolean' || copyRefs && !copyParams)
        throw new Error('请明确选择复制草稿参数及固定资料引用');
    const source = copySource(payload, sourceWeldId), weld = newWeld(newWeldId, displayNo);
    unusedWeldIdentity(payload, weld);
    const added = roleIds(source.binding).length + (source.binding.representations ? 0 : source.binding.label_id == null ? 1 : 0);
    if (payload.overlay.snapshot.entities.length + added > 2000 || payload.overlay.snapshot.nextEntityId + added > 2147483647)
        throw new Error('复制后叠层图元或稳定 ID 超过上限');
    if (copyParams)
        for (const key of Object.keys(weld))
            if (!['weld_id', 'display_no', 'location', 'measured_length'].includes(key) && Object.hasOwn(source.weld, key))
                weld[key] = clone(source.weld[key]);
    if (copyParams)
        for (const key of ['group_name', 'classification', 'welding_steps'])
            if (Object.hasOwn(source.weld, key))
                weld[key] = clone(source.weld[key]);
    if (Object.hasOwn(source.weld, 'included'))
        weld.included = true;
    const processRefs = copyRefs ? (payload.process_refs || []).filter((ref: any): any => ref.weld_id === sourceWeldId).map((ref: any): any => ({ ...clone(ref), weld_id: newWeldId })) : [];
    const used = new Set((payload.resource_refs || []).map((ref: any): any => ref.reference_id));
    const resourceRefs = copyRefs ? (payload.resource_refs || []).filter((ref: any): any => ref.weld_id === sourceWeldId).map((ref: any): any => {
        const id = uuid();
        if (typeof id !== 'string' || !id || Array.from(id).length > 64 || id !== id.trim() || /[\r\n\0]/u.test(id) || used.has(id))
            throw new Error('复制资料必须使用新的有效引用 ID');
        used.add(id);
        return { ...clone(ref), reference_id: id, weld_id: newWeldId };
    }) : [];
    const candidate: CadWire = { ticket: session.ticket(), sourceWeldId, sourceEntityIds: geometryIds(source.binding), sourceRoleIds: roleIds(source.binding), weld, processRefs, resourceRefs };
    if (source.binding.representations) {
        const usedRepresentations = new Set(payload.overlay.bindings.flatMap((b: any): any => b.representations.map((rep: any): any => rep.representation_id)));
        candidate.representations = source.binding.representations.map((rep: any): any => { const id = uuid(); if (!validDisplayNumber(id) || usedRepresentations.has(id))
            throw new Error('复制表示必须使用新的有效身份'); usedRepresentations.add(id); return { source_representation_id: rep.representation_id, representation_id: id }; });
    }
    copiedPayload(payload, candidate);
    return candidate;
}
function verifyBusinessAfter(payload: any, weldId: any, after: any, expectedCount: any, expectedRoles: any): any {
    const before = payload.overlay, oldEntities = before?.snapshot.entities || [], oldBindings = before?.bindings || [];
    const target = after?.bindings?.find((binding: any): any => binding.weld_id === weldId), newIds = new Set(target ? roleIds(target) : []), oldIds = new Set(oldEntities.map((entity: any): any => entity.id));
    const beforeBasis = { ...before?.snapshot }, afterBasis = { ...after?.snapshot };
    for (const key of ['entities', 'nextEntityId']) {
        delete beforeBasis[key];
        delete afterBasis[key];
    }
    if (!target || after.schema !== (before?.schema === 'vemcad-weld-overlay/3' ? 'vemcad-weld-overlay/3' : 'vemcad-weld-overlay/2') || !target.representations && target.label_id == null || !Array.isArray(after.snapshot?.entities) || after.snapshot.entities.length > 2000 ||
        !Number.isInteger(after.snapshot.nextEntityId) || after.snapshot.nextEntityId > 2147483647 || after.snapshot.nextEntityId <= Math.max(-1, ...after.snapshot.entities.map((entity: any): any => entity.id)) ||
        !newIds.size || newIds.size !== roleIds(target).length || newIds.size !== expectedRoles || expectedCount != null && geometryIds(target).length !== expectedCount || after.bindings.length !== oldBindings.length + 1 ||
        before && (!equalValue(beforeBasis, afterBasis) || after.snapshot.nextEntityId < before.snapshot.nextEntityId + newIds.size || [...newIds].some((id: any): any => id < before.snapshot.nextEntityId)) ||
        oldEntities.some((entity: any): any => !equalValue(after.snapshot?.entities?.find((row: any): any => row.id === entity.id), entity)) ||
        !equalValue(after.bindings.filter((binding: any): any => binding.weld_id !== weldId), oldBindings.map(withAux)) ||
        [...newIds].some((id: any): any => oldIds.has(id) || !after.snapshot?.entities?.some((row: any): any => row.id === id)) ||
        after.snapshot?.entities?.length !== oldEntities.length + newIds.size)
        throw new Error('业务复制或新建图形回应不一致，原草稿保留');
}
function applyWeldCopy(session: any, candidate: any, after: any): any {
    if (!session.accepts(candidate.ticket))
        throw new Error('复制预览期间草稿已有变化，请重新预览');
    const payload = session.state.payload, source = copySource(payload, candidate.sourceWeldId);
    if (!equalValue(roleIds(source.binding), candidate.sourceRoleIds))
        throw new Error('复制来源绑定已变化');
    unusedWeldIdentity(payload, candidate.weld);
    verifyBusinessAfter(payload, candidate.weld.weld_id, after, candidate.sourceEntityIds.length, candidate.sourceRoleIds.length + (source.binding.representations ? 0 : source.binding.label_id == null ? 1 : 0));
    if (source.binding.representations) {
        const target = after.bindings.find((b: any): any => b.weld_id === candidate.weld.weld_id);
        const mapping = new Map(candidate.representations.map((row: any): any => [row.source_representation_id, row.representation_id]));
        const oldIds = new Set(payload.overlay.snapshot.entities.map((e: any): any => e.id)), copied = after.snapshot.entities.filter((e: any): any => !oldIds.has(e.id));
        const roles = new Map(candidate.sourceRoleIds.map((id: any, index: any): any => [id, copied[index].id]));
        if (target.representations.some((rep: any, index: any): any => !equalValue(rep.entity_ids, source.binding.representations[index].entity_ids.map((id: any): any => roles.get(id))) || rep.label_id !== (source.binding.representations[index].label_id === null ? null : roles.get(source.binding.representations[index].label_id)) || rep.leader_id !== (source.binding.representations[index].leader_id === null ? null : roles.get(source.binding.representations[index].leader_id))))
            throw new Error('复制表示的完整角色归属不一致');
        if (target.primary_representation_id !== mapping.get(source.binding.primary_representation_id) || target.representations.length !== source.binding.representations.length || target.representations.some((rep: any, i: any): any => rep.representation_id !== mapping.get(source.binding.representations[i].representation_id) || rep.view_name !== source.binding.representations[i].view_name || (rep.label_id !== null) !== (source.binding.representations[i].label_id !== null) || (rep.leader_id !== null) !== (source.binding.representations[i].leader_id !== null)))
            throw new Error('完整复制表示身份或角色不一致');
    }
    if ((source.binding.leader_id != null) !== (after.bindings.find((b: any): any => b.weld_id === candidate.weld.weld_id).leader_id != null))
        throw new Error('复制必须保留源引线角色');
    const used = new Set((payload.resource_refs || []).map((ref: any): any => ref.reference_id));
    for (const ref of candidate.resourceRefs) {
        if (used.has(ref.reference_id) || ref.weld_id !== candidate.weld.weld_id)
            throw new Error('复制资料引用身份失效');
        used.add(ref.reference_id);
    }
    const next = copiedPayload(payload, candidate, after);
    session.edit((state: any): any => { state.payload = next; });
}
function prepareWeldDraw(session: any, newWeldId: any, representation: any = null): any {
    const payload = session.state.payload;
    validatePayload(payload);
    unusedWeldIdentity(payload, newWeld(newWeldId, nextWeldNumber(payload)));
    if (payload.welds.length >= 500)
        throw new Error('最多支持 500 条焊缝');
    if (payload.overlay && (payload.overlay.snapshot.entities.length + 2 > 2000 || payload.overlay.snapshot.nextEntityId + 2 > 2147483647))
        throw new Error('叠层图元或稳定 ID 已达上限');
    if (payload.overlay?.schema === 'vemcad-weld-overlay/3' && (!representation || !validDisplayNumber(representation.representation_id) || !validViewName(representation.view_name)))
        throw new Error('请为新焊缝明确填写表示名称');
    return { ticket: session.ticket(), weldId: newWeldId, displayNo: nextWeldNumber(payload), ...(payload.overlay?.schema === 'vemcad-weld-overlay/3' ? clone(representation) : {}) };
}
function applyWeldDraw(session: any, candidate: any, after: any): any {
    if (candidate.ticket.epoch !== session.state.epoch)
        throw new Error('绘制意图属于旧工艺包');
    const payload = session.state.payload, weld = newWeld(candidate.weldId, candidate.displayNo);
    if (candidate.displayNo !== nextWeldNumber(payload))
        throw new Error('绘制期间默认号已变化，请重新开始');
    unusedWeldIdentity(payload, weld);
    verifyBusinessAfter(payload, candidate.weldId, after, 1, 2);
    const target = after.bindings.find((b: any): any => b.weld_id === candidate.weldId);
    if (target.representations && (target.representations.length !== 1 || target.primary_representation_id !== candidate.representation_id || target.representations[0].representation_id !== candidate.representation_id || target.representations[0].view_name !== candidate.view_name))
        throw new Error('新绘制表示身份不匹配');
    if (roleRecords(target)[0].leader_id !== null)
        throw new Error('新绘制默认不添加引线');
    const next = copiedPayload(payload, { weld, processRefs: [], resourceRefs: [] }, after);
    session.edit((state: any): any => { state.payload = next; });
    return weld;
}
function prepareWeldRenumber(session: any, changes: any): any {
    const payload = clone(session.state.payload), seen = new Set();
    if (!Array.isArray(changes) || changes.length > 500)
        throw new Error('编号变更列表不正确');
    for (const change of changes) {
        const weld = payload.welds.find((w: any): any => w.weld_id === change.weld_id);
        if (!weld || seen.has(change.weld_id) || weld.display_no !== change.old_no || !validDisplayNumber(change.new_no))
            throw new Error('旧编号或新编号不正确，请重新预览');
        seen.add(change.weld_id);
        weld.display_no = change.new_no;
        const binding = payload.overlay?.bindings.find((b: any): any => b.weld_id === weld.weld_id);
        if (binding)
            for (const rep of roleRecords(binding))
                if (rep.label_id != null)
                    payload.overlay.snapshot.entities.find((e: any): any => e.id === rep.label_id).value = change.new_no;
    }
    validatePayload(payload);
    return { ticket: session.ticket(), payload, changes: clone(changes) };
}
function prepareWeldAnnotation(session: any, weldId: any, mode: any, representationId: any = null): any {
    validatePayload(session.state.payload);
    const source = copySource(session.state.payload, weldId);
    if (!['label', 'leader', 'removeLeader'].includes(mode))
        throw new Error('请选择标注操作');
    if (source.binding.representations && !source.binding.representations.some((rep: any): any => rep.representation_id === representationId))
        throw new Error('请明确选择标注表示');
    return { ticket: session.ticket(), weldId, displayNo: source.weld.display_no, mode, ...(source.binding.representations ? { representationId } : {}) };
}
function applyWeldAnnotation(session: any, candidate: any, after: any): any {
    if (!session.accepts(candidate.ticket))
        throw new Error('标注期间草稿已有变化，请重试');
    const payload = session.state.payload, before = payload.overlay, oldOwner = copySource(payload, candidate.weldId).binding;
    const old = oldOwner.representations ? oldOwner.representations.find((rep: any): any => rep.representation_id === candidate.representationId) : oldOwner;
    if (equalValue(before, after))
        return false;
    if (candidate.mode === 'removeLeader' && old.leader_id == null)
        throw new Error('没有引线可移除，旧格式保持');
    const owner = after?.bindings?.find((b: any): any => b.weld_id === candidate.weldId), target = owner?.representations ? owner.representations.find((rep: any): any => rep.representation_id === candidate.representationId) : owner, next = clone(payload);
    next.overlay = clone(after);
    validatePayload(next);
    if (!target || oldOwner.representations && (!equalValue(owner.representations.filter((rep: any): any => rep.representation_id !== candidate.representationId), oldOwner.representations.filter((rep: any): any => rep.representation_id !== candidate.representationId)) || owner.primary_representation_id !== oldOwner.primary_representation_id || target.view_name !== old.view_name))
        throw new Error('标注不能改变其他表示或主次角色');
    const beforeBasis = { ...before.snapshot }, afterBasis = { ...after.snapshot };
    for (const key of ['entities', 'nextEntityId']) {
        delete beforeBasis[key];
        delete afterBasis[key];
    }
    const allowed = new Set([old.label_id, old.leader_id].filter((id: any): any => id != null)), ids = new Set(after.snapshot.entities.map((e: any): any => e.id)), oldIds = new Set(before.snapshot.entities.map((e: any): any => e.id));
    const added = after.snapshot.entities.filter((e: any): any => !oldIds.has(e.id));
    if (after.schema !== (oldOwner.representations ? 'vemcad-weld-overlay/3' : 'vemcad-weld-overlay/2') || !equalValue(beforeBasis, afterBasis) || !equalValue(target.entity_ids, old.entity_ids) ||
        !equalValue(after.bindings.filter((b: any): any => b.weld_id !== candidate.weldId), before.bindings.filter((b: any): any => b.weld_id !== candidate.weldId).map(withAux)) ||
        before.snapshot.entities.some((e: any): any => !allowed.has(e.id) && !equalValue(e, after.snapshot.entities.find((a: any): any => a.id === e.id))) ||
        added.some((e: any): any => !roleIds(target).includes(e.id) || e.id < before.snapshot.nextEntityId) || after.snapshot.nextEntityId < before.snapshot.nextEntityId + added.length ||
        after.snapshot.entities.length !== before.snapshot.entities.length + added.length - [...allowed].filter((id: any): any => !ids.has(id)).length ||
        old.label_id != null && target.label_id !== old.label_id ||
        candidate.mode === 'label' && target.leader_id !== (old.leader_id ?? null) ||
        candidate.mode === 'removeLeader' && (target.leader_id !== null || target.label_id !== (old.label_id ?? null)) ||
        candidate.mode !== 'removeLeader' && target.label_id == null || candidate.mode === 'leader' && target.leader_id == null ||
        old.leader_id != null && candidate.mode === 'leader' && target.leader_id !== old.leader_id)
        throw new Error('标注回应改变了其他内容，原草稿保留');
    if (old.label_id != null && !equalValue(before.snapshot.entities.find((e: any): any => e.id === old.label_id), after.snapshot.entities.find((e: any): any => e.id === target.label_id)))
        throw new Error('已有标签位置或样式不能由重复生成改变');
    if (old.leader_id != null && candidate.mode === 'label' && !equalValue(before.snapshot.entities.find((e: any): any => e.id === old.leader_id), after.snapshot.entities.find((e: any): any => e.id === target.leader_id)))
        throw new Error('生成标签不能改已有引线');
    if (old.leader_id != null && candidate.mode === 'leader') {
        const previous = before.snapshot.entities.find((e: any): any => e.id === old.leader_id), current = after.snapshot.entities.find((e: any): any => e.id === target.leader_id);
        const oldStyle = { ...previous }, newStyle = { ...current };
        for (const key of previous.type === 'line' ? ['start', 'end'] : ['points']) {
            delete oldStyle[key];
            delete newStyle[key];
        }
        if (!equalValue(oldStyle, newStyle))
            throw new Error('更新引线不能改类型、图层或样式');
    }
    session.edit((state: any): any => { state.payload = next; });
    return true;
}
const validViewName = (value: any): any => typeof value === 'string' && value.length > 0 && value === value.trim() && Array.from(value).length <= 256 && !value.includes('\0') && !Array.from(value).some((c: any): any => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff);
function prepareRepresentation(session: any, operation: any): any {
    const payload = session.state.payload;
    validatePayload(payload);
    const overlay = clone(payload.overlay), op = clone(operation);
    const fields = ({ upgrade: ['names'], add: ['weld_id', 'representation_id', 'view_name', 'entity_ids'], copy: ['weld_id', 'source_representation_id', 'representation_id', 'view_name', 'delta'], rename: ['weld_id', 'representation_id', 'view_name'], primary: ['weld_id', 'representation_id'], remove: ['weld_id', 'representation_id', 'replacement_primary_id'] } as Record<string, string[]>)[op.mode];
    if (!overlay || !fields || Object.keys(op).length !== fields.length + 1 || !fields.every((k: any): any => Object.hasOwn(op, k)))
        throw new Error('请选择明确的表示操作');
    if (op.mode === 'upgrade') {
        if (overlay.schema === 'vemcad-weld-overlay/3' || !Array.isArray(op.names) || op.names.length !== overlay.bindings.length)
            throw new Error('请为每条已绑定焊缝填写名称后明确升级');
        const names = new Map();
        for (const row of op.names) {
            if (!row || Object.keys(row).length !== 3 || !validDisplayNumber(row.weld_id) || !validDisplayNumber(row.representation_id) || !validViewName(row.view_name) || names.has(row.weld_id))
                throw new Error('升级名称或表示身份不正确');
            names.set(row.weld_id, row);
        }
        overlay.bindings = overlay.bindings.map((b: any): any => { const row = names.get(b.weld_id); if (!row)
            throw new Error('有焊缝缺少人工表示名称'); return { weld_id: b.weld_id, primary_representation_id: row.representation_id, representations: [{ representation_id: row.representation_id, view_name: row.view_name, entity_ids: [...b.entity_ids], label_id: b.label_id ?? null, leader_id: b.leader_id ?? null }] }; });
        overlay.schema = 'vemcad-weld-overlay/3';
    }
    else {
        if (overlay.schema !== 'vemcad-weld-overlay/3' || !payload.welds.some((w: any): any => w.weld_id === op.weld_id) || !validDisplayNumber(op.representation_id))
            throw new Error('请先明确升级并选择当前焊缝和表示');
        const owner = overlay.bindings.find((b: any): any => b.weld_id === op.weld_id), rep = owner?.representations.find((r: any): any => r.representation_id === op.representation_id);
        if (['add', 'copy'].includes(op.mode)) {
            if (!validViewName(op.view_name) || overlay.bindings.some((b: any): any => b.representations.some((r: any): any => r.representation_id === op.representation_id)))
                throw new Error('新表示需要新的身份和人工名称');
            let added;
            if (op.mode === 'copy') {
                const source = owner?.representations.find((r: any): any => r.representation_id === op.source_representation_id);
                if (!source || !op.delta || Object.keys(op.delta).length !== 2 || !Number.isFinite(op.delta.x) || !Number.isFinite(op.delta.y))
                    throw new Error('复制来源或世界坐标偏移不正确');
                const mapping = new Map();
                for (const id of roleIds(source)) {
                    const entity = clone(overlay.snapshot.entities.find((e: any): any => e.id === id));
                    entity.id = overlay.snapshot.nextEntityId++;
                    const move = (point: any): any => ({ ...point, x: point.x + op.delta.x, y: point.y + op.delta.y });
                    if (entity.type === 'line') {
                        entity.start = move(entity.start);
                        entity.end = move(entity.end);
                    }
                    else if (entity.type === 'polyline')
                        entity.points = entity.points.map(move);
                    else if (entity.type === 'arc')
                        entity.center = move(entity.center);
                    else if (entity.type === 'text')
                        entity.position = move(entity.position);
                    overlay.snapshot.entities.push(entity);
                    mapping.set(id, entity.id);
                }
                added = { representation_id: op.representation_id, view_name: op.view_name, entity_ids: source.entity_ids.map((id: any): any => mapping.get(id)), label_id: source.label_id === null ? null : mapping.get(source.label_id), leader_id: source.leader_id === null ? null : mapping.get(source.leader_id) };
            }
            else {
                if (!Array.isArray(op.entity_ids) || !op.entity_ids.length || op.entity_ids.some((id: any): any => overlay.bindings.some((b: any): any => roleIds(b).includes(id))))
                    throw new Error('新增表示只能使用尚未归属的几何');
                added = { representation_id: op.representation_id, view_name: op.view_name, entity_ids: [...op.entity_ids], label_id: null, leader_id: null };
            }
            if (owner)
                owner.representations.push(added);
            else
                overlay.bindings.push({ weld_id: op.weld_id, primary_representation_id: added.representation_id, representations: [added] });
        }
        else {
            if (!rep)
                throw new Error('表示已不可用');
            if (op.mode === 'rename') {
                if (!validViewName(op.view_name))
                    throw new Error('请填写有效人工表示名称');
                rep.view_name = op.view_name;
            }
            if (op.mode === 'primary')
                owner.primary_representation_id = rep.representation_id;
            if (op.mode === 'remove') {
                const remaining = owner.representations.filter((r: any): any => r !== rep);
                if (remaining.length && owner.primary_representation_id === rep.representation_id) {
                    if (!remaining.some((r: any): any => r.representation_id === op.replacement_primary_id))
                        throw new Error('删除主表示须明确选择保留的主表示');
                    owner.primary_representation_id = op.replacement_primary_id;
                }
                else if (op.replacement_primary_id !== null)
                    throw new Error('本次操作不需要替换主表示');
                const removed = new Set(roleIds(rep));
                overlay.snapshot.entities = overlay.snapshot.entities.filter((e: any): any => !removed.has(e.id));
                if (remaining.length)
                    owner.representations = remaining;
                else
                    overlay.bindings = overlay.bindings.filter((b: any): any => b !== owner);
            }
        }
    }
    const next = { ...payload, overlay };
    validatePayload(next);
    return { ticket: session.ticket(), weldId: op.weld_id || '', operation: op, overlay, affectedWeldIds: op.mode === 'upgrade' ? overlay.bindings.map((b: any): any => b.weld_id) : [op.weld_id] };
}
function applyRepresentation(session: any, candidate: any, after: any): any {
    if (!session.accepts(candidate.ticket) || !equalValue(prepareRepresentation(session, candidate.operation).overlay, candidate.overlay) || !equalValue(candidate.overlay, after))
        throw new Error('表示预览或完整回应不匹配，原草稿保留');
    if (equalValue(session.state.payload.overlay, after))
        return false;
    session.edit((s: any): any => { s.payload.overlay = clone(after); });
    return true;
}
function newWeld(id: any, displayNo: any): any {
    return { weld_id: id, display_no: displayNo, location: '', joint_type: '', method: '', material_a: '', material_b: '', filler: '',
        thickness_a: null, thickness_b: null, manufacturing_length: null, measured_length: null, passes: [], welding_requirements: '', inspection_requirements: '' };
}
function validateManualText(value: any, nonempty: any = false): any {
    if (typeof value !== 'string' || Array.from(value).length > 4000 || nonempty && !value.trim() || value.includes('\0') || Array.from(value).some((c: any): any => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff))
        throw new Error('编制说明与每项施焊步骤最多 4000 字符，步骤不能为空');
}
function validateWeldingSteps(value: any): any { if (!Array.isArray(value) || value.length > 100)
    throw new Error('每条焊缝最多 100 项有序施焊步骤'); value.forEach((step: any): any => validateManualText(step, true)); }
function validatePayload(payload: any): any {
    if (Object.hasOwn(payload, 'preparation_notes'))
        validateManualText(payload.preparation_notes);
    if (!payload.product || !payload.drawing)
        throw new Error('请明确选择产品与图纸固定版本');
    const ids = new Set(), numbers = new Set();
    if (payload.welds.length > 500)
        throw new Error('最多支持 500 条焊缝');
    for (const weld of payload.welds) {
        if (Object.hasOwn(weld, 'welding_steps'))
            validateWeldingSteps(weld.welding_steps);
        if (!validDisplayNumber(weld.display_no) || ids.has(weld.weld_id) || numbers.has(weld.display_no))
            throw new Error('焊缝 ID 和显示号必须非空且唯一');
        for (const key of ['group_name', 'classification'])
            if (Object.hasOwn(weld, key) && !(weld[key] === '' || validDisplayNumber(weld[key])))
                throw new Error('统计分组和企业分类须为有效单行文本，最多 64 字符');
        if (Object.hasOwn(weld, 'included') && typeof weld.included !== 'boolean')
            throw new Error('参与统计必须为明确的勾选值');
        ids.add(weld.weld_id);
        numbers.add(weld.display_no);
        const sequences = new Set(), passes = weld.passes || [];
        if (passes.length > 100)
            throw new Error('每条焊缝最多支持 100 个层道');
        for (const pass of passes) {
            if (!Number.isInteger(pass.sequence) || pass.sequence < 1 || sequences.has(pass.sequence))
                throw new Error('层道序号必须是唯一正整数');
            sequences.add(pass.sequence);
        }
        for (const row of [weld, ...passes]) {
            for (const key of ['thickness_a', 'thickness_b', 'manufacturing_length', 'measured_length', 'current', 'voltage', 'speed']) {
                if (row[key] != null && (!Number.isFinite(row[key].value) || row[key].value < 0))
                    throw new Error('数值必须有限且非负；空值不会转换为零');
            }
        }
    }
    const overlay = payload.overlay;
    if (overlay) {
        const v3 = overlay.schema === 'vemcad-weld-overlay/3', v2 = v3 || overlay.schema === 'vemcad-weld-overlay/2', bound = new Set(), labels = new Set(), owners = new Set(), reps = new Set();
        const nativeIds = overlay.snapshot.entities.map((e: any): any => e.id), counter = overlay.snapshot.nextEntityId;
        if (overlay.snapshot.entities.length > 2000 || overlay.bindings.length > 500 || new Set(nativeIds).size !== nativeIds.length || nativeIds.some((id: any): any => !Number.isInteger(id) || id < 0 || id > 2147483647) || !Number.isInteger(counter) || counter < 1 || counter > 2147483647 || counter <= Math.max(-1, ...nativeIds))
            throw new Error('叠层容量或稳定 ID 不正确');
        if (!v2 && overlay.schema !== 'vemcad-weld-overlay/1')
            throw new Error('未知叠层格式');
        for (const binding of overlay.bindings) {
            const owner = payload.welds.find((w: any): any => w.weld_id === binding.weld_id);
            if (!owner || owners.has(binding.weld_id))
                throw new Error('焊缝角色或目标不正确');
            owners.add(binding.weld_id);
            if (v3) {
                if (!Array.isArray(binding.representations) || !binding.representations.length || Object.keys(binding).length !== 3 || !validDisplayNumber(binding.primary_representation_id) || !binding.representations.some((rep: any): any => rep.representation_id === binding.primary_representation_id))
                    throw new Error('表示与本焊缝主表示不正确');
                for (const rep of binding.representations) {
                    if (Object.keys(rep).length !== 5 || !['representation_id', 'view_name', 'entity_ids', 'label_id', 'leader_id'].every((key: any): any => Object.hasOwn(rep, key)) || !validDisplayNumber(rep.representation_id) || reps.has(rep.representation_id) || typeof rep.view_name !== 'string' || !rep.view_name || rep.view_name !== rep.view_name.trim() || Array.from(rep.view_name).length > 256 || /\0/u.test(rep.view_name) || Array.from(rep.view_name).some((c: any): any => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff))
                        throw new Error('表示身份或人工视图名称不正确');
                    reps.add(rep.representation_id);
                }
            }
            for (const role of roleRecords(binding)) {
                if (!Array.isArray(role.entity_ids) || !role.entity_ids.length || v2 && (!Object.hasOwn(role, 'label_id') || !Object.hasOwn(role, 'leader_id')) || !v2 && (Object.hasOwn(role, 'label_id') || Object.hasOwn(role, 'leader_id')))
                    throw new Error('焊缝角色或目标不正确');
                for (const id of roleIds(role)) {
                    if (!Number.isInteger(id) || bound.has(id) || !overlay.snapshot.entities.some((e: any): any => e.id === id))
                        throw new Error('图形角色重复或缺失');
                    bound.add(id);
                }
                if (role.entity_ids.some((id: any): any => !['line', 'arc', 'polyline'].includes(overlay.snapshot.entities.find((e: any): any => e.id === id)?.type)))
                    throw new Error('焊缝仅可绑定几何');
                if (role.label_id != null) {
                    const label = overlay.snapshot.entities.find((e: any): any => e.id === role.label_id);
                    labels.add(label.id);
                    if (label.type !== 'text' || label.value !== owner.display_no || !Number.isFinite(label.height) || label.height < 0.1 || label.rotation !== 0 || !Number.isFinite(label.position?.x) || !Number.isFinite(label.position?.y))
                        throw new Error('编号文字或布局不正确');
                }
                if (role.leader_id != null) {
                    const leader = overlay.snapshot.entities.find((e: any): any => e.id === role.leader_id);
                    if (role.label_id == null || !['line', 'polyline'].includes(leader.type) || leader.type === 'polyline' && leader.closed)
                        throw new Error('引线角色不正确');
                }
            }
        }
        if (overlay.snapshot.entities.some((e: any): any => e.type === 'text' && (!v2 || !labels.has(e.id))))
            throw new Error('文字必须属于业务编号');
    }
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 5 * 1024 * 1024)
        throw new Error('工艺包正文超过上限');
}

export function useWeldingCadSession(session: ReturnType<typeof useWeldingPlanSession>) {
  const state = reactive({ ready: false, busy: false, arming: false, intent: '', message: '', selectedWeld: '', representationId: '', selectedEntities: [] as number[], measurement: null as CadWire | null, context: null as CadContext | null })
  let bridge: ReturnType<typeof createCadBridge> | null = null, cadEpoch = 0, mirror: CadWire | null = null
  let intent: { id: string; kind: 'draw' | 'copy' | 'annotation' | 'representation'; candidate: CadWire } | null = null
  let measure: ((value: CadWire) => CadWire) | null = null
  const canAct = computed(() => state.ready && !state.busy && !state.intent && session.canEdit.value)
  function close(message = '图纸已关闭；工艺编辑仍保留') { cadEpoch++; state.arming = false; bridge?.destroy(); bridge = null; state.ready = false; state.busy = false; state.intent = ''; intent = null; state.context = null; mirror = null; measure = null; state.measurement = null; state.message = message; session.state.cadBusy = false }
  function adapter() {
    let result: PlanPayload | null = null
    return { state: { payload: session.state.payload, epoch: cadEpoch }, ticket: () => ({ epoch: cadEpoch, scope: session.capture() }), accepts: (v: CadWire) => v.epoch === cadEpoch && v.scope.accepts(),
      edit: (change: (state: { payload: PlanPayload }) => void) => { const next = { payload: clone(session.state.payload) }; change(next); validatePayload(next.payload); result = next.payload }, result: () => { need(result); return result } }
  }
  function refreshMeasurement() {
    state.measurement = null; const overlay = session.state.payload.overlay as CadWire | undefined
    if (!measure || !overlay) return
    const result = measure(clone(overlay))
    need(result.schema === 'vemcad-weld-measurement/1' && result.algorithm === 'vemcad-weld-length/1' && result.source_unit === overlay.snapshot.meta.unit && Array.isArray(result.rows) && result.rows.length === overlay.bindings.length)
    need(result.rows.every((r: CadWire) => overlay.bindings.some((b: CadWire) => b.weld_id === r.weld_id) && (r.status === 'measured' && Number.isFinite(r.length_mm) && r.length_mm >= 0 && r.reason === null || r.status === 'unmeasurable' && r.length_mm === null && r.reason === 'length_overflow')))
    state.measurement = { ...clone(result), overlay: clone(overlay) }
  }
  let mutationScope: RequestScope | null = null
  function guarded<T>(action: (scope: RequestScope) => Promise<T>) {
    return session.withTargetMutation(async scope => {
      const previous = mutationScope; mutationScope = scope
      try { return await action(scope) } finally { if (mutationScope === scope) mutationScope = previous }
    }, session.capture())
  }
  async function open(frame: HTMLIFrameElement) { return guarded(async scope => {
    need(session.canEdit.value && session.state.versionId && !session.state.pending, '请先保存 Draft 再打开 CAD')
    close('正在核验固定图纸'); const epoch = cadEpoch, s = session.state; state.busy = true
    try {
      const owner = await session.fresh(scope); session.check(scope)
      const raw = await session.client.createCadContext(s.planId, s.versionId!, crypto.randomUUID(), s.draftSeq, scope); session.check(scope)
      need(equalValue(await session.fresh(scope), owner)); session.check(scope)
      need(isObject(raw) && raw.plan_id === s.planId && raw.item_version_id === s.versionId && raw.draft_seq === s.draftSeq && typeof raw.context_id === 'string' && ['mm', 'in'].includes(String(raw.unit)) && typeof raw.expires_at === 'string' && Date.parse(raw.expires_at) > Date.now() && isObject(raw.cadgf_document) && isObject(raw.origin))
      const origin = raw.origin
      need(origin.schema === 'yuantus.welding_plan_cad_origin/1' && origin.owner_auth_user_id === owner.auth_user_id && origin.rbac_user_id === owner.rbac_user_id && origin.context_id === raw.context_id && origin.bundle_sha256 === WELDING_CAD_PIN && origin.unit === raw.unit && isObject(origin.basis)
        && equalValue(origin.basis, { product: s.payload.product, drawing: s.payload.drawing }) && isObject(origin.input) && isObject(origin.document) && isHash(raw.input_sha256) && raw.input_sha256 === origin.input.sha256 && raw.input_sha256 === s.payload.drawing?.expected_checksum.toLowerCase()
        && isHash(raw.document_sha256) && raw.document_sha256 === origin.document.sha256 && equalValue(raw.source, origin.source) && raw.editor_url === `/welding-cad/${WELDING_CAD_PIN}/welding-frame.html`, 'CAD 来源、身份或安装包不匹配')
      const context = raw as CadContext
      const ticket = await session.client.cadTicket({ purpose: 'editor', plan_id: s.planId, version_id: s.versionId!, context_id: context.context_id }, scope); session.check(scope)
      need(equalValue(await session.fresh(scope), owner)); session.check(scope); need(epoch === cadEpoch)
      const lifetime = session.capture(false), accepts = () => lifetime.accepts() && epoch === cadEpoch && Date.parse(context.expires_at) > Date.now()
      const active = createCadBridge({ window, frame, getLocalSeq: () => s.editSeq, accepts,
        async onAction(action) {
          need(accepts() && !s.pending && !s.uncertain && !s.blocked, '旧 CAD 动作已拒绝')
          const scope = mutationScope ?? session.capture(), handler = adapter(), after = action.after; need(after.snapshot.meta.unit === context.unit)
          if (action.business_intent_id !== null) {
            need(intent && intent.id === action.business_intent_id)
            if (intent.kind === 'draw') applyWeldDraw(handler, intent.candidate, after)
            else if (intent.kind === 'copy') applyWeldCopy(handler, intent.candidate, after)
            else if (intent.kind === 'annotation') applyWeldAnnotation(handler, intent.candidate, after)
            else applyRepresentation(handler, intent.candidate, after)
          } else { need(!intent); handler.edit(next => { next.payload.overlay = clone(after) }) }
          const seq = await session.commitPayload(handler.result(), scope); need(accepts()); mirror = clone(after); intent = null; state.intent = ''; refreshMeasurement(); return seq
        },
        onSelection(selection) { if (!accepts()) return; state.selectedEntities = selection.entity_ids; state.selectedWeld = weldSelection(s.payload, selection).primaryWeldId },
        onIntentCancelled(id) { if (intent?.id === id) { intent = null; state.intent = ''; s.cadBusy = false } },
        onHistoryRequest(direction) { void history(direction).catch(error => { state.message = error.message }) }, onError(error) { if (epoch === cadEpoch) close(error.message) },
      })
      bridge = active; frame.src = ticket.asset_url
      const loaded = await active.load(context, (s.payload.overlay as CadWire) ?? null); session.check(scope); need(accepts())
      mirror = clone(loaded.snapshot); s.overlayContextId = context.context_id; state.context = context
      const module = await import(/* @vite-ignore */ `/welding-cad/${WELDING_CAD_PIN}/helpers/welding_measurement.js`); session.check(scope); need(accepts() && typeof module.measureWeldingOverlay === 'function')
      measure = module.measureWeldingOverlay; refreshMeasurement(); state.ready = true; state.message = '固定图纸已打开，底图只读；原生几何量采用主表示'
    } catch (error) { if (epoch === cadEpoch) close(error instanceof Error ? error.message : 'CAD 未打开'); throw error }
    finally { if (epoch === cadEpoch) state.busy = false }
  }) }
  async function barrier(pendingHistory = false) {
    need(!state.busy && ((!session.state.pending && !session.state.uncertain) || pendingHistory && session.canHistory.value) && !session.state.storageBlocked, '请先确认原保存或恢复存储'); need(!intent, '请明确完成或取消当前 CAD 意图')
    if (!bridge) { need(!session.state.cadBusy); return }
    const active = bridge, epoch = cadEpoch, scope = session.capture(), result = await active.snapshot()
    session.check(scope); need(active === bridge && epoch === cadEpoch && result.local_seq === session.state.editSeq && equalValue(result.snapshot, mirror), 'CAD 快照未与业务正文一致'); await session.fresh(scope); session.check(scope)
  }
  async function cancel() { need(bridge && intent?.kind === 'draw' && !state.busy); const active = bridge, epoch = cadEpoch; state.busy = true; try { await active.snapshot(); need(active === bridge && epoch === cadEpoch && !intent, '取消尚未确认') } finally { if (epoch === cadEpoch) state.busy = false } }
  async function execute(kind: NonNullable<typeof intent>['kind'], candidate: CadWire, operation: (active: NonNullable<typeof bridge>, id: string) => Promise<CadWire>) {
    return guarded(async () => {
    need(candidate.ticket.epoch === cadEpoch, 'CAD 动作属于旧图纸会话')
    need(canAct.value && bridge); const active = bridge, epoch = cadEpoch, id = crypto.randomUUID(); intent = { id, kind, candidate }; state.intent = kind; session.state.cadBusy = true
    try { const result = await operation(active, id); need(active === bridge && epoch === cadEpoch); if (kind !== 'draw' && result.changed === false) { intent = null; state.intent = ''; session.state.cadBusy = false } }
    catch (error) { if (epoch === cadEpoch) close(error instanceof Error ? error.message : 'CAD 动作未确认'); throw error }
    })
  }
  async function draw(tool: 'line' | 'arc' | 'polyline', viewName: string) {
    need(!state.arming, '绘制准入尚未确认')
    const epoch = cadEpoch; state.arming = true
    try { const c = prepareWeldDraw(adapter(), crypto.randomUUID(), { representation_id: crypto.randomUUID(), view_name: viewName }); await execute('draw', c, (b, id) => b.armDraw({ intent_id: id, weld_id: c.weldId, display_no: c.displayNo, tool, ...(c.representation_id ? { representation_id: c.representation_id, view_name: c.view_name } : {}) })) }
    finally { if (epoch === cadEpoch) state.arming = false }
  }
  async function copy(displayNo: string, copyParams: boolean, copyRefs: boolean, delta: { x: number; y: number }) { const c = prepareWeldCopy(adapter(), { sourceWeldId: state.selectedWeld, newWeldId: crypto.randomUUID(), displayNo, copyParams, copyRefs }, () => crypto.randomUUID()); await execute('copy', c, (b, id) => b.copyWeld({ intent_id: id, source_weld_id: c.sourceWeldId, weld_id: c.weld.weld_id, display_no: c.weld.display_no, delta, ...(c.representations ? { representations: c.representations } : {}) })) }
  async function annotate(mode: 'label' | 'leader' | 'removeLeader') { const c = prepareWeldAnnotation(adapter(), state.selectedWeld, mode, state.representationId); await execute('annotation', c, (b, id) => b.annotateWeld({ intent_id: id, weld_id: c.weldId, display_no: c.displayNo, mode, ...(c.representationId ? { representation_id: c.representationId } : {}) })) }
  async function representation(operation: CadWire) { const c = prepareRepresentation(adapter(), operation); await execute('representation', c, (b, id) => b.representation({ ...operation, intent_id: id })) }
  async function bind(remove = false) { return guarded(async () => { need(canAct.value && bridge); const bindings = bindingsForWeld(session.state.payload, state.selectedWeld, state.selectedEntities, remove); state.busy = true; const epoch = cadEpoch; try { await bridge.bind(bindings) } finally { if (epoch === cadEpoch) state.busy = false } }) }
  async function history(direction: 'undo' | 'redo') { return guarded(async scope => {
    need(!state.intent && session.canHistory.value); await barrier(Boolean(session.state.pending))
    const c = session.historyCandidate(direction), epoch = cadEpoch, active = bridge; state.busy = true
    try { if (active) { const result = await active.restore((c.payload.overlay as CadWire) ?? null, session.state.editSeq + 1); session.check(scope); need(active === bridge && epoch === cadEpoch); mirror = clone(result.snapshot) } await session.commitPayload(c.payload, scope, c.cursor); refreshMeasurement() }
    catch (error) { if (epoch === cadEpoch && active) close('撤销尚未确认，请重新打开 CAD'); throw error }
    finally { if (epoch === cadEpoch) state.busy = false }
  }) }
  async function renumber(changes: Array<{ weld_id: string; old_no: string; new_no: string }>) { return guarded(async scope => {
    need(session.canEdit.value); await barrier(); const c = prepareWeldRenumber(adapter(), changes), active = bridge, epoch = cadEpoch; state.busy = true
    try { if (active) { const result = await active.restore(c.payload.overlay ?? null, session.state.editSeq + 1); session.check(scope); need(epoch === cadEpoch); mirror = clone(result.snapshot) } await session.commitPayload(c.payload, scope); refreshMeasurement() }
    catch (error) { if (active && epoch === cadEpoch) close('编号回应未确认，请重新打开 CAD'); throw error }
    finally { if (epoch === cadEpoch) state.busy = false }
  }) }
  async function removeWeld(weldId: string) { return guarded(async scope => {
    need(session.canEdit.value); await barrier()
    const next = clone(session.state.payload), overlay = next.overlay as CadWire | undefined
    need(next.welds.some(weld => weld.weld_id === weldId), '焊缝已变化，请重新选择')
    next.welds = next.welds.filter(weld => weld.weld_id !== weldId)
    for (const key of ['process_refs', 'resource_refs']) if (Array.isArray(next[key])) next[key] = (next[key] as CadWire[]).filter(ref => ref.weld_id !== weldId)
    if (overlay) {
      const removed = new Set(overlay.bindings.filter((binding: CadWire) => binding.weld_id === weldId).flatMap(roleIds))
      overlay.bindings = overlay.bindings.filter((binding: CadWire) => binding.weld_id !== weldId)
      overlay.snapshot.entities = overlay.snapshot.entities.filter((entity: CadWire) => !removed.has(entity.id))
    }
    validatePayload(next)
    const active = bridge, epoch = cadEpoch; state.busy = true
    try { if (active) { const result = await active.restore(next.overlay ?? null, session.state.editSeq + 1); session.check(scope); need(active === bridge && epoch === cadEpoch); mirror = clone(result.snapshot) } await session.commitPayload(next, scope); if (state.selectedWeld === weldId) { state.selectedWeld = ''; state.representationId = ''; state.selectedEntities = [] } refreshMeasurement() }
    catch (error) { if (active && epoch === cadEpoch) close('删除尚未确认，请重新打开 CAD'); throw error }
    finally { if (epoch === cadEpoch) state.busy = false }
  }) }
  async function select(weldId: string) { state.selectedWeld = weldId; if (!bridge || !state.ready) return; const binding = (session.state.payload.overlay as CadWire)?.bindings.find((b: CadWire) => b.weld_id === weldId); await bridge.select(binding ? roleIds(binding) : []) }
  async function revoke() { return guarded(async scope => { const context = state.context; need(context); await session.fresh(scope); await session.client.revokeCadContext(context.plan_id, context.item_version_id, context.context_id, scope); session.check(scope); await session.fresh(scope); session.check(scope); close('服务器 CAD 上下文已撤销；工艺正文保留') }) }
  session.setCadBarrier(() => barrier())
  watch(() => clone([session.state.payload.product, session.state.payload.drawing]), (basis, previous) => {
    if (equalValue(basis, previous)) return
    close('底图依据已变化，请重新打开 CAD'); session.state.overlayContextId = ''
  }, { flush: 'sync' })
  watch(() => JSON.stringify([session.state.owner, session.state.planId, session.state.versionId, session.state.recoveryId]), () => { if (bridge) close('身份或目标已变化，请重新打开 CAD') })
  onScopeDispose(() => { session.setCadBarrier(null); close() })
  return { state, canAct, open, close, barrier: () => barrier(), cancel, draw, copy, annotate, representation, bind, history, renumber, removeWeld, select, revoke }
}
