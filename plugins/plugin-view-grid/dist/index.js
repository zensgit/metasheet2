import { defineComponent as Je, ref as et, onMounted as Qe, onUnmounted as ts, createElementBlock as ee, openBlock as se, createElementVNode as z, withDirectives as es, withKeys as ss, vModelText as is, createCommentVNode as ls, toDisplayString as pt } from "vue";
class Q {
  constructor(t, e = "") {
    typeof t == "string" ? (this.el = document.createElement(t), this.el.className = e) : this.el = t, this.data = {};
  }
  data(t, e) {
    return e !== void 0 ? (this.data[t] = e, this) : this.data[t];
  }
  on(t, e) {
    const [s, ...i] = t.split(".");
    let n = s;
    return n === "mousewheel" && /Firefox/i.test(window.navigator.userAgent) && (n = "DOMMouseScroll"), this.el.addEventListener(n, (r) => {
      e(r);
      for (let o = 0; o < i.length; o += 1) {
        const c = i[o];
        if (c === "left" && r.button !== 0 || c === "right" && r.button !== 2)
          return;
        c === "stop" && r.stopPropagation();
      }
    }), this;
  }
  offset(t) {
    if (t !== void 0)
      return Object.keys(t).forEach((r) => {
        this.css(r, `${t[r]}px`);
      }), this;
    const {
      offsetTop: e,
      offsetLeft: s,
      offsetHeight: i,
      offsetWidth: n
    } = this.el;
    return {
      top: e,
      left: s,
      height: i,
      width: n
    };
  }
  scroll(t) {
    const { el: e } = this;
    return t !== void 0 && (t.left !== void 0 && (e.scrollLeft = t.left), t.top !== void 0 && (e.scrollTop = t.top)), { left: e.scrollLeft, top: e.scrollTop };
  }
  box() {
    return this.el.getBoundingClientRect();
  }
  parent() {
    return new Q(this.el.parentNode);
  }
  children(...t) {
    return arguments.length === 0 ? this.el.childNodes : (t.forEach((e) => this.child(e)), this);
  }
  removeChild(t) {
    this.el.removeChild(t);
  }
  /*
    first() {
      return this.el.firstChild;
    }
  
    last() {
      return this.el.lastChild;
    }
  
    remove(ele) {
      return this.el.removeChild(ele);
    }
  
    prepend(ele) {
      const { el } = this;
      if (el.children.length > 0) {
        el.insertBefore(ele, el.firstChild);
      } else {
        el.appendChild(ele);
      }
      return this;
    }
  
    prev() {
      return this.el.previousSibling;
    }
  
    next() {
      return this.el.nextSibling;
    }
    */
  child(t) {
    let e = t;
    return typeof t == "string" ? e = document.createTextNode(t) : t instanceof Q && (e = t.el), this.el.appendChild(e), this;
  }
  contains(t) {
    return this.el.contains(t);
  }
  className(t) {
    return t !== void 0 ? (this.el.className = t, this) : this.el.className;
  }
  addClass(t) {
    return this.el.classList.add(t), this;
  }
  hasClass(t) {
    return this.el.classList.contains(t);
  }
  removeClass(t) {
    return this.el.classList.remove(t), this;
  }
  toggle(t = "active") {
    return this.toggleClass(t);
  }
  toggleClass(t) {
    return this.el.classList.toggle(t);
  }
  active(t = !0, e = "active") {
    return t ? this.addClass(e) : this.removeClass(e), this;
  }
  checked(t = !0) {
    return this.active(t, "checked"), this;
  }
  disabled(t = !0) {
    return t ? this.addClass("disabled") : this.removeClass("disabled"), this;
  }
  // key, value
  // key
  // {k, v}...
  attr(t, e) {
    if (e !== void 0)
      this.el.setAttribute(t, e);
    else {
      if (typeof t == "string")
        return this.el.getAttribute(t);
      Object.keys(t).forEach((s) => {
        this.el.setAttribute(s, t[s]);
      });
    }
    return this;
  }
  removeAttr(t) {
    return this.el.removeAttribute(t), this;
  }
  html(t) {
    return t !== void 0 ? (this.el.innerHTML = t, this) : this.el.innerHTML;
  }
  val(t) {
    return t !== void 0 ? (this.el.value = t, this) : this.el.value;
  }
  focus() {
    this.el.focus();
  }
  cssRemoveKeys(...t) {
    return t.forEach((e) => this.el.style.removeProperty(e)), this;
  }
  // css( propertyName )
  // css( propertyName, value )
  // css( properties )
  css(t, e) {
    return e === void 0 && typeof t != "string" ? (Object.keys(t).forEach((s) => {
      this.el.style[s] = t[s];
    }), this) : e !== void 0 ? (this.el.style[t] = e, this) : this.el.style[t];
  }
  computedStyle() {
    return window.getComputedStyle(this.el, null);
  }
  show() {
    return this.css("display", "block"), this;
  }
  hide() {
    return this.css("display", "none"), this;
  }
}
const u = (l, t = "") => new Q(l, t), Y = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"];
function Ie(l) {
  let t = "", e = l;
  for (; e >= Y.length; )
    e /= Y.length, e -= 1, t += Y[parseInt(e, 10) % Y.length];
  const s = l % Y.length;
  return t += Y[s], t;
}
function ns(l) {
  let t = 0;
  for (let e = 0; e < l.length - 1; e += 1) {
    const s = l.charCodeAt(e) - 65, i = l.length - 1 - e;
    t += Y.length ** i + Y.length * s;
  }
  return t += l.charCodeAt(l.length - 1) - 65, t;
}
function X(l) {
  let t = "", e = "";
  for (let s = 0; s < l.length; s += 1)
    l.charAt(s) >= "0" && l.charAt(s) <= "9" ? e += l.charAt(s) : t += l.charAt(s);
  return [ns(t), parseInt(e, 10) - 1];
}
function L(l, t) {
  return `${Ie(l)}${t + 1}`;
}
function ct(l, t, e, s = () => !0) {
  if (t === 0 && e === 0) return l;
  const [i, n] = X(l);
  return s(i, n) ? L(i + t, n + e) : l;
}
class O {
  constructor(t, e, s, i, n = 0, r = 0) {
    this.sri = t, this.sci = e, this.eri = s, this.eci = i, this.w = n, this.h = r;
  }
  set(t, e, s, i) {
    this.sri = t, this.sci = e, this.eri = s, this.eci = i;
  }
  multiple() {
    return this.eri - this.sri > 0 || this.eci - this.sci > 0;
  }
  // cell-index: ri, ci
  // cell-ref: A10
  includes(...t) {
    let [e, s] = [0, 0];
    t.length === 1 ? [s, e] = X(t[0]) : t.length === 2 && ([e, s] = t);
    const {
      sri: i,
      sci: n,
      eri: r,
      eci: o
    } = this;
    return i <= e && e <= r && n <= s && s <= o;
  }
  each(t, e = () => !0) {
    const {
      sri: s,
      sci: i,
      eri: n,
      eci: r
    } = this;
    for (let o = s; o <= n; o += 1)
      if (e(o))
        for (let c = i; c <= r; c += 1)
          t(o, c);
  }
  contains(t) {
    return this.sri <= t.sri && this.sci <= t.sci && this.eri >= t.eri && this.eci >= t.eci;
  }
  // within
  within(t) {
    return this.sri >= t.sri && this.sci >= t.sci && this.eri <= t.eri && this.eci <= t.eci;
  }
  // disjoint
  disjoint(t) {
    return this.sri > t.eri || this.sci > t.eci || t.sri > this.eri || t.sci > this.eci;
  }
  // intersects
  intersects(t) {
    return this.sri <= t.eri && this.sci <= t.eci && t.sri <= this.eri && t.sci <= this.eci;
  }
  // union
  union(t) {
    const {
      sri: e,
      sci: s,
      eri: i,
      eci: n
    } = this;
    return new O(
      t.sri < e ? t.sri : e,
      t.sci < s ? t.sci : s,
      t.eri > i ? t.eri : i,
      t.eci > n ? t.eci : n
    );
  }
  // intersection
  // intersection(other) {}
  // Returns Array<CellRange> that represents that part of this that does not intersect with other
  // difference
  difference(t) {
    const e = [], s = (f, g, p, w) => {
      e.push(new O(f, g, p, w));
    }, {
      sri: i,
      sci: n,
      eri: r,
      eci: o
    } = this, c = t.sri - i, a = t.sci - n, d = r - t.eri, h = o - t.eci;
    return c > 0 ? (s(i, n, t.sri - 1, o), d > 0 ? (s(t.eri + 1, n, r, o), a > 0 && s(t.sri, n, t.eri, t.sci - 1), h > 0 && s(t.sri, t.eci + 1, t.eri, o)) : (a > 0 && s(t.sri, n, r, t.sci - 1), h > 0 && s(t.sri, t.eci + 1, r, o))) : d > 0 && (s(t.eri + 1, n, r, o), a > 0 && s(i, n, t.eri, t.sci - 1), h > 0 && s(i, t.eci + 1, t.eri, o)), a > 0 ? (s(i, n, r, t.sci - 1), h > 0 ? (s(i, t.eri + 1, r, o), c > 0 && s(i, t.sci, t.sri - 1, t.eci), d > 0 && s(t.sri + 1, t.sci, r, t.eci)) : (c > 0 && s(i, t.sci, t.sri - 1, o), d > 0 && s(t.sri + 1, t.sci, r, o))) : h > 0 && (s(r, t.eci + 1, r, o), c > 0 && s(i, n, t.sri - 1, t.eci), d > 0 && s(t.eri + 1, n, r, t.eci)), e;
  }
  size() {
    return [
      this.eri - this.sri + 1,
      this.eci - this.sci + 1
    ];
  }
  toString() {
    const {
      sri: t,
      sci: e,
      eri: s,
      eci: i
    } = this;
    let n = L(e, t);
    return this.multiple() && (n = `${n}:${L(i, s)}`), n;
  }
  clone() {
    const {
      sri: t,
      sci: e,
      eri: s,
      eci: i,
      w: n,
      h: r
    } = this;
    return new O(t, e, s, i, n, r);
  }
  /*
  toJSON() {
    return this.toString();
  }
  */
  equals(t) {
    return this.eri === t.eri && this.eci === t.eci && this.sri === t.sri && this.sci === t.sci;
  }
  static valueOf(t) {
    const e = t.split(":"), [s, i] = X(e[0]);
    let [n, r] = [i, s];
    return e.length > 1 && ([r, n] = X(e[1])), new O(i, s, n, r);
  }
}
let rs = class {
  constructor() {
    this.range = new O(0, 0, 0, 0), this.ri = 0, this.ci = 0;
  }
  multiple() {
    return this.range.multiple();
  }
  setIndexes(t, e) {
    this.ri = t, this.ci = e;
  }
  size() {
    return this.range.size();
  }
};
class os {
  constructor() {
    this.x = 0, this.y = 0, this.ri = 0, this.ci = 0;
  }
}
class cs {
  constructor() {
    this.undoItems = [], this.redoItems = [];
  }
  add(t) {
    this.undoItems.push(JSON.stringify(t)), this.redoItems = [];
  }
  canUndo() {
    return this.undoItems.length > 0;
  }
  canRedo() {
    return this.redoItems.length > 0;
  }
  undo(t, e) {
    const { undoItems: s, redoItems: i } = this;
    this.canUndo() && (i.push(JSON.stringify(t)), e(JSON.parse(s.pop())));
  }
  redo(t, e) {
    const { undoItems: s, redoItems: i } = this;
    this.canRedo() && (s.push(JSON.stringify(t)), e(JSON.parse(i.pop())));
  }
}
class as {
  constructor() {
    this.range = null, this.state = "clear";
  }
  copy(t) {
    return this.range = t, this.state = "copy", this;
  }
  cut(t) {
    return this.range = t, this.state = "cut", this;
  }
  isCopy() {
    return this.state === "copy";
  }
  isCut() {
    return this.state === "cut";
  }
  isClear() {
    return this.state === "clear";
  }
  clear() {
    this.range = null, this.state = "clear";
  }
}
class ie {
  constructor(t, e, s) {
    this.ci = t, this.operator = e, this.value = s;
  }
  set(t, e) {
    this.operator = t, this.value = e;
  }
  includes(t) {
    const { operator: e, value: s } = this;
    return e === "all" ? !0 : e === "in" ? s.includes(t) : !1;
  }
  vlength() {
    const { operator: t, value: e } = this;
    return t === "in" ? e.length : 0;
  }
  getData() {
    const { ci: t, operator: e, value: s } = this;
    return { ci: t, operator: e, value: s };
  }
}
class le {
  constructor(t, e) {
    this.ci = t, this.order = e;
  }
  asc() {
    return this.order === "asc";
  }
  desc() {
    return this.order === "desc";
  }
}
class hs {
  constructor() {
    this.ref = null, this.filters = [], this.sort = null;
  }
  setData({ ref: t, filters: e, sort: s }) {
    t != null && (this.ref = t, this.filters = e.map((i) => new ie(i.ci, i.operator, i.value)), s && (this.sort = new le(s.ci, s.order)));
  }
  getData() {
    if (this.active()) {
      const { ref: t, filters: e, sort: s } = this;
      return { ref: t, filters: e.map((i) => i.getData()), sort: s };
    }
    return {};
  }
  addFilter(t, e, s) {
    const i = this.getFilter(t);
    i == null ? this.filters.push(new ie(t, e, s)) : i.set(e, s);
  }
  setSort(t, e) {
    this.sort = e ? new le(t, e) : null;
  }
  includes(t, e) {
    return this.active() ? this.hrange().includes(t, e) : !1;
  }
  getSort(t) {
    const { sort: e } = this;
    return e && e.ci === t ? e : null;
  }
  getFilter(t) {
    const { filters: e } = this;
    for (let s = 0; s < e.length; s += 1)
      if (e[s].ci === t)
        return e[s];
    return null;
  }
  filteredRows(t) {
    const e = /* @__PURE__ */ new Set(), s = /* @__PURE__ */ new Set();
    if (this.active()) {
      const { sri: i, eri: n } = this.range(), { filters: r } = this;
      for (let o = i + 1; o <= n; o += 1)
        for (let c = 0; c < r.length; c += 1) {
          const a = r[c], d = t(o, a.ci), h = d ? d.text : "";
          if (a.includes(h))
            s.add(o);
          else {
            e.add(o);
            break;
          }
        }
    }
    return { rset: e, fset: s };
  }
  items(t, e) {
    const s = {};
    if (this.active()) {
      const { sri: i, eri: n } = this.range();
      for (let r = i + 1; r <= n; r += 1) {
        const o = e(r, t);
        if (o !== null && !/^\s*$/.test(o.text)) {
          const c = o.text, a = (s[c] || 0) + 1;
          s[c] = a;
        } else
          s[""] = (s[""] || 0) + 1;
      }
    }
    return s;
  }
  range() {
    return O.valueOf(this.ref);
  }
  hrange() {
    const t = this.range();
    return t.eri = t.sri, t;
  }
  clear() {
    this.ref = null, this.filters = [], this.sort = null;
  }
  active() {
    return this.ref !== null;
  }
}
class qt {
  constructor(t = []) {
    this._ = t;
  }
  forEach(t) {
    this._.forEach(t);
  }
  deleteWithin(t) {
    this._ = this._.filter((e) => !e.within(t));
  }
  getFirstIncludes(t, e) {
    for (let s = 0; s < this._.length; s += 1) {
      const i = this._[s];
      if (i.includes(t, e))
        return i;
    }
    return null;
  }
  filterIntersects(t) {
    return new qt(this._.filter((e) => e.intersects(t)));
  }
  intersects(t) {
    for (let e = 0; e < this._.length; e += 1)
      if (this._[e].intersects(t))
        return !0;
    return !1;
  }
  union(t) {
    let e = t;
    return this._.forEach((s) => {
      s.intersects(e) && (e = s.union(e));
    }), e;
  }
  add(t) {
    this.deleteWithin(t), this._.push(t);
  }
  // type: row | column
  shift(t, e, s, i) {
    this._.forEach((n) => {
      const {
        sri: r,
        sci: o,
        eri: c,
        eci: a
      } = n, d = n;
      t === "row" ? r >= e ? (d.sri += s, d.eri += s) : r < e && e <= c && (d.eri += s, i(r, o, s, 0)) : t === "column" && (o >= e ? (d.sci += s, d.eci += s) : o < e && e <= a && (d.eci += s, i(r, o, 0, s)));
    });
  }
  move(t, e, s) {
    this._.forEach((i) => {
      const n = i;
      n.within(t) && (n.eri += e, n.sri += e, n.sci += s, n.eci += s);
    });
  }
  setData(t) {
    return this._ = t.map((e) => O.valueOf(e)), this;
  }
  getData() {
    return this._.map((t) => t.toString());
  }
}
function ds(l) {
  return JSON.parse(JSON.stringify(l));
}
const Ae = (l = {}, ...t) => (t.forEach((e) => {
  Object.keys(e).forEach((s) => {
    const i = e[s];
    typeof i == "string" || typeof i == "number" || typeof i == "boolean" ? l[s] = i : typeof i != "function" && !Array.isArray(i) && i instanceof Object ? (l[s] = l[s] || {}, Ae(l[s], i)) : l[s] = i;
  });
}), l);
function Ht(l, t) {
  const e = Object.keys(l);
  if (e.length !== Object.keys(t).length) return !1;
  for (let s = 0; s < e.length; s += 1) {
    const i = e[s], n = l[i], r = t[i];
    if (r === void 0) return !1;
    if (typeof n == "string" || typeof n == "number" || typeof n == "boolean") {
      if (n !== r) return !1;
    } else if (Array.isArray(n)) {
      if (n.length !== r.length) return !1;
      for (let o = 0; o < n.length; o += 1)
        if (!Ht(n[o], r[o])) return !1;
    } else if (typeof n != "function" && !Array.isArray(n) && n instanceof Object && !Ht(n, r))
      return !1;
  }
  return !0;
}
const fs = (l, t = (e) => e) => {
  let e = 0, s = 0;
  return Object.keys(l).forEach((i) => {
    e += t(l[i], i), s += 1;
  }), [e, s];
};
function us(l, t) {
  const e = l[`${t}`];
  return delete l[`${t}`], e;
}
function gs(l, t, e, s, i, n) {
  let r = e, o = s, c = l;
  for (; c < t && !(r > i); c += 1)
    o = n(c), r += o;
  return [c, r - o, o];
}
function ps(l, t, e) {
  let s = 0;
  for (let i = l; i < t; i += 1)
    s += e(i);
  return s;
}
function ms(l, t, e) {
  for (let s = l; s < t; s += 1)
    e(s);
}
function ws(l, t) {
  if (l.length === t.length) {
    for (let e = 0; e < l.length; e += 1)
      if (l[e] !== t[e]) return !1;
  } else return !1;
  return !0;
}
function At(l) {
  const t = `${l}`;
  let e = 0, s = !1;
  for (let i = 0; i < t.length; i += 1)
    s === !0 && (e += 1), t.charAt(i) === "." && (s = !0);
  return e;
}
function K(l, t, e) {
  if (Number.isNaN(t) || Number.isNaN(e))
    return t + l + e;
  const s = At(t), i = At(e), n = Number(t), r = Number(e);
  let o = 0;
  if (l === "-")
    o = n - r;
  else if (l === "+")
    o = n + r;
  else if (l === "*")
    o = n * r;
  else if (l === "/")
    return o = n / r, At(o) > 5 ? o.toFixed(2) : o;
  return o.toFixed(Math.max(s, i));
}
const F = {
  cloneDeep: ds,
  merge: (...l) => Ae({}, ...l),
  equals: Ht,
  arrayEquals: ws,
  sum: fs,
  rangeEach: ms,
  rangeSum: ps,
  rangeReduceIf: gs,
  deleteProperty: us,
  numberCalc: K
};
class bs {
  constructor({ len: t, height: e }) {
    this._ = {}, this.len = t, this.height = e;
  }
  getHeight(t) {
    if (this.isHide(t)) return 0;
    const e = this.get(t);
    return e && e.height ? e.height : this.height;
  }
  setHeight(t, e) {
    const s = this.getOrNew(t);
    s.height = e;
  }
  unhide(t) {
    let e = t;
    for (; e > 0 && (e -= 1, this.isHide(e)); )
      this.setHide(e, !1);
  }
  isHide(t) {
    const e = this.get(t);
    return e && e.hide;
  }
  setHide(t, e) {
    const s = this.getOrNew(t);
    e === !0 ? s.hide = !0 : delete s.hide;
  }
  setStyle(t, e) {
    const s = this.getOrNew(t);
    s.style = e;
  }
  sumHeight(t, e, s) {
    return F.rangeSum(t, e, (i) => s && s.has(i) ? 0 : this.getHeight(i));
  }
  totalHeight() {
    return this.sumHeight(0, this.len);
  }
  get(t) {
    return this._[t];
  }
  getOrNew(t) {
    return this._[t] = this._[t] || { cells: {} }, this._[t];
  }
  getCell(t, e) {
    const s = this.get(t);
    return s !== void 0 && s.cells !== void 0 && s.cells[e] !== void 0 ? s.cells[e] : null;
  }
  getCellMerge(t, e) {
    const s = this.getCell(t, e);
    return s && s.merge ? s.merge : [0, 0];
  }
  getCellOrNew(t, e) {
    const s = this.getOrNew(t);
    return s.cells[e] = s.cells[e] || {}, s.cells[e];
  }
  // what: all | text | format
  setCell(t, e, s, i = "all") {
    const n = this.getOrNew(t);
    i === "all" ? n.cells[e] = s : i === "text" ? (n.cells[e] = n.cells[e] || {}, n.cells[e].text = s.text) : i === "format" && (n.cells[e] = n.cells[e] || {}, n.cells[e].style = s.style, s.merge && (n.cells[e].merge = s.merge));
  }
  setCellText(t, e, s) {
    const i = this.getCellOrNew(t, e);
    i.editable !== !1 && (i.text = s);
  }
  // what: all | format | text
  copyPaste(t, e, s, i = !1, n = () => {
  }) {
    const {
      sri: r,
      sci: o,
      eri: c,
      eci: a
    } = t, d = e.sri, h = e.sci, f = e.eri, g = e.eci, [p, w] = t.size(), [v, y] = e.size();
    let C = !0, k = 0;
    (f < r || g < o) && (C = !1, f < r ? k = v : k = y);
    for (let b = r; b <= c; b += 1)
      if (this._[b]) {
        for (let x = o; x <= a; x += 1)
          if (this._[b].cells && this._[b].cells[x])
            for (let $ = d; $ <= f; $ += p)
              for (let T = h; T <= g; T += w) {
                const D = $ + (b - r), R = T + (x - o), N = F.cloneDeep(this._[b].cells[x]);
                if (i && N && N.text && N.text.length > 0) {
                  const { text: U } = N;
                  let Z = T - h + ($ - d) + 2;
                  if (C || (Z -= k + 1), U[0] === "=")
                    N.text = U.replace(/[a-zA-Z]{1,3}\d+/g, (W) => {
                      let [tt, te] = [0, 0];
                      return r === d ? tt = Z - 1 : te = Z - 1, /^\d+$/.test(W) ? W : ct(W, tt, te);
                    });
                  else if (p <= 1 && w > 1 && (d > c || f < r) || w <= 1 && p > 1 && (h > a || g < o) || p <= 1 && w <= 1) {
                    const W = /[\\.\d]+$/.exec(U);
                    if (W !== null) {
                      const tt = Number(W[0]) + Z - 1;
                      N.text = U.substring(0, W.index) + tt;
                    }
                  }
                }
                this.setCell(D, R, N, s), n(D, R, N);
              }
      }
  }
  cutPaste(t, e) {
    const s = {};
    this.each((i) => {
      this.eachCells(i, (n) => {
        let r = parseInt(i, 10), o = parseInt(n, 10);
        t.includes(i, n) && (r = e.sri + (r - t.sri), o = e.sci + (o - t.sci)), s[r] = s[r] || { cells: {} }, s[r].cells[o] = this._[i].cells[n];
      });
    }), this._ = s;
  }
  // src: Array<Array<String>>
  paste(t, e) {
    if (t.length <= 0) return;
    const { sri: s, sci: i } = e;
    t.forEach((n, r) => {
      const o = s + r;
      n.forEach((c, a) => {
        const d = i + a;
        this.setCellText(o, d, c);
      });
    });
  }
  insert(t, e = 1) {
    const s = {};
    this.each((i, n) => {
      let r = parseInt(i, 10);
      r >= t && (r += e, this.eachCells(i, (o, c) => {
        c.text && c.text[0] === "=" && (c.text = c.text.replace(/[a-zA-Z]{1,3}\d+/g, (a) => ct(a, 0, e, (d, h) => h >= t)));
      })), s[r] = n;
    }), this._ = s, this.len += e;
  }
  delete(t, e) {
    const s = e - t + 1, i = {};
    this.each((n, r) => {
      const o = parseInt(n, 10);
      o < t ? i[o] = r : n > e && (i[o - s] = r, this.eachCells(n, (c, a) => {
        a.text && a.text[0] === "=" && (a.text = a.text.replace(/[a-zA-Z]{1,3}\d+/g, (d) => ct(d, 0, -s, (h, f) => f > e)));
      }));
    }), this._ = i, this.len -= s;
  }
  insertColumn(t, e = 1) {
    this.each((s, i) => {
      const n = {};
      this.eachCells(s, (r, o) => {
        let c = parseInt(r, 10);
        c >= t && (c += e, o.text && o.text[0] === "=" && (o.text = o.text.replace(/[a-zA-Z]{1,3}\d+/g, (a) => ct(a, e, 0, (d) => d >= t)))), n[c] = o;
      }), i.cells = n;
    });
  }
  deleteColumn(t, e) {
    const s = e - t + 1;
    this.each((i, n) => {
      const r = {};
      this.eachCells(i, (o, c) => {
        const a = parseInt(o, 10);
        a < t ? r[a] = c : a > e && (r[a - s] = c, c.text && c.text[0] === "=" && (c.text = c.text.replace(/[a-zA-Z]{1,3}\d+/g, (d) => ct(d, -s, 0, (h) => h > e))));
      }), n.cells = r;
    });
  }
  // what: all | text | format | merge
  deleteCells(t, e = "all") {
    t.each((s, i) => {
      this.deleteCell(s, i, e);
    });
  }
  // what: all | text | format | merge
  deleteCell(t, e, s = "all") {
    const i = this.get(t);
    if (i !== null) {
      const n = this.getCell(t, e);
      n !== null && n.editable !== !1 && (s === "all" ? delete i.cells[e] : s === "text" ? (n.text && delete n.text, n.value && delete n.value) : s === "format" ? (n.style !== void 0 && delete n.style, n.merge && delete n.merge) : s === "merge" && n.merge && delete n.merge);
    }
  }
  maxCell() {
    const t = Object.keys(this._), e = t[t.length - 1], s = this._[e];
    if (s) {
      const { cells: i } = s, n = Object.keys(i), r = n[n.length - 1];
      return [parseInt(e, 10), parseInt(r, 10)];
    }
    return [0, 0];
  }
  each(t) {
    Object.entries(this._).forEach(([e, s]) => {
      t(e, s);
    });
  }
  eachCells(t, e) {
    this._[t] && this._[t].cells && Object.entries(this._[t].cells).forEach(([s, i]) => {
      e(s, i);
    });
  }
  setData(t) {
    t.len && (this.len = t.len, delete t.len), this._ = t;
  }
  getData() {
    const { len: t } = this;
    return Object.assign({ len: t }, this._);
  }
}
class xs {
  constructor({
    len: t,
    width: e,
    indexWidth: s,
    minWidth: i
  }) {
    this._ = {}, this.len = t, this.width = e, this.indexWidth = s, this.minWidth = i;
  }
  setData(t) {
    t.len && (this.len = t.len, delete t.len), this._ = t;
  }
  getData() {
    const { len: t } = this;
    return Object.assign({ len: t }, this._);
  }
  getWidth(t) {
    if (this.isHide(t)) return 0;
    const e = this._[t];
    return e && e.width ? e.width : this.width;
  }
  getOrNew(t) {
    return this._[t] = this._[t] || {}, this._[t];
  }
  setWidth(t, e) {
    const s = this.getOrNew(t);
    s.width = e;
  }
  unhide(t) {
    let e = t;
    for (; e > 0 && (e -= 1, this.isHide(e)); )
      this.setHide(e, !1);
  }
  isHide(t) {
    const e = this._[t];
    return e && e.hide;
  }
  setHide(t, e) {
    const s = this.getOrNew(t);
    e === !0 ? s.hide = !0 : delete s.hide;
  }
  setStyle(t, e) {
    const s = this.getOrNew(t);
    s.style = e;
  }
  sumWidth(t, e) {
    return F.rangeSum(t, e, (s) => this.getWidth(s));
  }
  totalWidth() {
    return this.sumWidth(0, this.len);
  }
}
const vs = {
  toolbar: {
    undo: "Undo",
    redo: "Redo",
    print: "Print",
    paintformat: "Paint format",
    clearformat: "Clear format",
    format: "Format",
    fontName: "Font",
    fontSize: "Font size",
    fontBold: "Font bold",
    fontItalic: "Font italic",
    underline: "Underline",
    strike: "Strike",
    color: "Text color",
    bgcolor: "Fill color",
    border: "Borders",
    merge: "Merge cells",
    align: "Horizontal align",
    valign: "Vertical align",
    textwrap: "Text wrapping",
    freeze: "Freeze cell",
    autofilter: "Filter",
    formula: "Functions",
    more: "More"
  },
  contextmenu: {
    copy: "Copy",
    cut: "Cut",
    paste: "Paste",
    pasteValue: "Paste values only",
    pasteFormat: "Paste format only",
    hide: "Hide",
    insertRow: "Insert row",
    insertColumn: "Insert column",
    deleteSheet: "Delete",
    deleteRow: "Delete row",
    deleteColumn: "Delete column",
    deleteCell: "Delete cell",
    deleteCellText: "Delete cell text",
    validation: "Data validations",
    cellprintable: "Enable export",
    cellnonprintable: "Disable export",
    celleditable: "Enable editing",
    cellnoneditable: "Disable editing"
  },
  print: {
    size: "Paper size",
    orientation: "Page orientation",
    orientations: ["Landscape", "Portrait"]
  },
  format: {
    normal: "Normal",
    text: "Plain Text",
    number: "Number",
    percent: "Percent",
    rmb: "RMB",
    usd: "USD",
    eur: "EUR",
    date: "Date",
    time: "Time",
    datetime: "Date time",
    duration: "Duration"
  },
  formula: {
    sum: "Sum",
    average: "Average",
    max: "Max",
    min: "Min",
    _if: "IF",
    and: "AND",
    or: "OR",
    concat: "Concat"
  },
  validation: {
    required: "it must be required",
    notMatch: "it not match its validation rule",
    between: "it is between {} and {}",
    notBetween: "it is not between {} and {}",
    notIn: "it is not in list",
    equal: "it equal to {}",
    notEqual: "it not equal to {}",
    lessThan: "it less than {}",
    lessThanEqual: "it less than or equal to {}",
    greaterThan: "it greater than {}",
    greaterThanEqual: "it greater than or equal to {}"
  },
  error: {
    pasteForMergedCell: "Unable to do this for merged cells"
  },
  calendar: {
    weeks: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  },
  button: {
    next: "Next",
    cancel: "Cancel",
    remove: "Remove",
    save: "Save",
    ok: "OK"
  },
  sort: {
    desc: "Sort Z -> A",
    asc: "Sort A -> Z"
  },
  filter: {
    empty: "empty"
  },
  dataValidation: {
    mode: "Mode",
    range: "Cell Range",
    criteria: "Criteria",
    modeType: {
      cell: "Cell",
      column: "Colun",
      row: "Row"
    },
    type: {
      list: "List",
      number: "Number",
      date: "Date",
      phone: "Phone",
      email: "Email"
    },
    operator: {
      be: "between",
      nbe: "not betwwen",
      lt: "less than",
      lte: "less than or equal to",
      gt: "greater than",
      gte: "greater than or equal to",
      eq: "equal to",
      neq: "not equal to"
    }
  }
};
let Nt = ["en"];
const Re = {
  en: vs
};
function ne(l, t) {
  if (t)
    for (const e of Nt) {
      if (!t[e]) break;
      let s = t[e];
      const i = l.match(/(?:\\.|[^.])+/g);
      for (let n = 0; n < i.length; n += 1) {
        const r = i[n], o = s[r];
        if (!o) break;
        if (n === i.length - 1) return o;
        s = o;
      }
    }
}
function I(l) {
  let t = ne(l, Re);
  return !t && window && window.x_spreadsheet && window.x_spreadsheet.$messages && (t = ne(l, window.x_spreadsheet.$messages)), t || "";
}
function S(l) {
  return () => I(l);
}
function ze(l, t, e = !1) {
  e ? Nt = [l] : Nt.unshift(l), t && (Re[l] = t);
}
const re = {
  phone: /^[1-9]\d{10}$/,
  email: /w+([-+.]w+)*@w+([-.]w+)*.w+([-.]w+)*/
};
function V(l, t, ...e) {
  let s = "";
  return l || (s = I(`validation.${t}`, ...e)), [l, s];
}
class Fe {
  // operator: b|nb|eq|neq|lt|lte|gt|gte
  // type: date|number|list|phone|email
  constructor(t, e, s, i) {
    this.required = e, this.value = s, this.type = t, this.operator = i, this.message = "";
  }
  parseValue(t) {
    const { type: e } = this;
    return e === "date" ? new Date(t) : e === "number" ? Number(t) : t;
  }
  equals(t) {
    let e = this.type === t.type && this.required === t.required && this.operator === t.operator;
    return e && (Array.isArray(this.value) ? e = F.arrayEquals(this.value, t.value) : e = this.value === t.value), e;
  }
  values() {
    return this.value.split(",");
  }
  validate(t) {
    const {
      required: e,
      operator: s,
      value: i,
      type: n
    } = this;
    if (e && /^\s*$/.test(t))
      return V(!1, "required");
    if (/^\s*$/.test(t)) return [!0];
    if (re[n] && !re[n].test(t))
      return V(!1, "notMatch");
    if (n === "list")
      return V(this.values().includes(t), "notIn");
    if (s) {
      const r = this.parseValue(t);
      if (s === "be") {
        const [o, c] = i;
        return V(
          r >= this.parseValue(o) && r <= this.parseValue(c),
          "between",
          o,
          c
        );
      }
      if (s === "nbe") {
        const [o, c] = i;
        return V(
          r < this.parseValue(o) || r > this.parseValue(c),
          "notBetween",
          o,
          c
        );
      }
      if (s === "eq")
        return V(
          r === this.parseValue(i),
          "equal",
          i
        );
      if (s === "neq")
        return V(
          r !== this.parseValue(i),
          "notEqual",
          i
        );
      if (s === "lt")
        return V(
          r < this.parseValue(i),
          "lessThan",
          i
        );
      if (s === "lte")
        return V(
          r <= this.parseValue(i),
          "lessThanEqual",
          i
        );
      if (s === "gt")
        return V(
          r > this.parseValue(i),
          "greaterThan",
          i
        );
      if (s === "gte")
        return V(
          r >= this.parseValue(i),
          "greaterThanEqual",
          i
        );
    }
    return [!0];
  }
}
class Et {
  constructor(t, e, s) {
    this.refs = e, this.mode = t, this.validator = s;
  }
  includes(t, e) {
    const { refs: s } = this;
    for (let i = 0; i < s.length; i += 1)
      if (O.valueOf(s[i]).includes(t, e)) return !0;
    return !1;
  }
  addRef(t) {
    this.remove(O.valueOf(t)), this.refs.push(t);
  }
  remove(t) {
    const e = [];
    this.refs.forEach((s) => {
      const i = O.valueOf(s);
      i.intersects(t) ? i.difference(t).forEach((r) => e.push(r.toString())) : e.push(s);
    }), this.refs = e;
  }
  getData() {
    const { refs: t, mode: e, validator: s } = this, {
      type: i,
      required: n,
      operator: r,
      value: o
    } = s;
    return {
      refs: t,
      mode: e,
      type: i,
      required: n,
      operator: r,
      value: o
    };
  }
  static valueOf({
    refs: t,
    mode: e,
    type: s,
    required: i,
    operator: n,
    value: r
  }) {
    return new Et(e, t, new Fe(s, i, r, n));
  }
}
class ys {
  constructor() {
    this._ = [], this.errors = /* @__PURE__ */ new Map();
  }
  getError(t, e) {
    return this.errors.get(`${t}_${e}`);
  }
  validate(t, e, s) {
    const i = this.get(t, e), n = `${t}_${e}`, { errors: r } = this;
    if (i !== null) {
      const [o, c] = i.validator.validate(s);
      o ? r.delete(n) : r.set(n, c);
    } else
      r.delete(n);
    return !0;
  }
  // type: date|number|phone|email|list
  // validator: { required, value, operator }
  add(t, e, {
    type: s,
    required: i,
    value: n,
    operator: r
  }) {
    const o = new Fe(
      s,
      i,
      n,
      r
    ), c = this.getByValidator(o);
    c !== null ? c.addRef(e) : this._.push(new Et(t, [e], o));
  }
  getByValidator(t) {
    for (let e = 0; e < this._.length; e += 1) {
      const s = this._[e];
      if (s.validator.equals(t))
        return s;
    }
    return null;
  }
  get(t, e) {
    for (let s = 0; s < this._.length; s += 1) {
      const i = this._[s];
      if (i.includes(t, e)) return i;
    }
    return null;
  }
  remove(t) {
    this.each((e) => {
      e.remove(t);
    });
  }
  each(t) {
    this._.forEach((e) => t(e));
  }
  getData() {
    return this._.filter((t) => t.refs.length > 0).map((t) => t.getData());
  }
  setData(t) {
    this._ = t.map((e) => Et.valueOf(e));
  }
}
const ks = {
  mode: "edit",
  // edit | read
  view: {
    height: () => document.documentElement.clientHeight,
    width: () => document.documentElement.clientWidth
  },
  showGrid: !0,
  showToolbar: !0,
  showContextmenu: !0,
  showBottomBar: !0,
  row: {
    len: 100,
    height: 25
  },
  col: {
    len: 26,
    width: 100,
    indexWidth: 60,
    minWidth: 60
  },
  style: {
    bgcolor: "#ffffff",
    align: "left",
    valign: "middle",
    textwrap: !1,
    strike: !1,
    underline: !1,
    color: "#0a0a0a",
    font: {
      name: "Arial",
      size: 10,
      bold: !1,
      italic: !1
    },
    format: "normal"
  }
}, Cs = 41, Es = 41, oe = (l, t) => Object.prototype.hasOwnProperty.call(l, t);
function ce(l, t, e = () => {
}) {
  const { merges: s } = this, i = t.clone(), [n, r] = l.size(), [o, c] = t.size();
  return n > o && (i.eri = t.sri + n - 1), r > c && (i.eci = t.sci + r - 1), s.intersects(i) ? (e(I("error.pasteForMergedCell")), !1) : !0;
}
function ae(l, t, e, s = !1) {
  const { rows: i, merges: n } = this;
  (e === "all" || e === "format") && (i.deleteCells(t, e), n.deleteWithin(t)), i.copyPaste(l, t, e, s, (r, o, c) => {
    if (c && c.merge) {
      const [a, d] = c.merge;
      if (a <= 0 && d <= 0) return;
      n.add(new O(r, o, r + a, o + d));
    }
  });
}
function Ss(l, t) {
  const { clipboard: e, rows: s, merges: i } = this;
  s.cutPaste(l, t), i.move(
    l,
    t.sri - l.sri,
    t.sci - l.sci
  ), e.clear();
}
function st(l, t, e) {
  const { styles: s, rows: i } = this, n = i.getCellOrNew(l, t);
  let r = {};
  n.style !== void 0 && (r = F.cloneDeep(s[n.style])), r = F.merge(r, { border: e }), n.style = this.addStyle(r);
}
function $s({ mode: l, style: t, color: e }) {
  const { styles: s, selector: i, rows: n } = this, {
    sri: r,
    sci: o,
    eri: c,
    eci: a
  } = i.range, d = !this.isSignleSelected();
  if (!(!d && (l === "inside" || l === "horizontal" || l === "vertical"))) {
    if (l === "outside" && !d)
      st.call(this, r, o, {
        top: [t, e],
        bottom: [t, e],
        left: [t, e],
        right: [t, e]
      });
    else if (l === "none")
      i.range.each((h, f) => {
        const g = n.getCell(h, f);
        if (g && g.style !== void 0) {
          const p = F.cloneDeep(s[g.style]);
          delete p.border, g.style = this.addStyle(p);
        }
      });
    else if (l === "all" || l === "inside" || l === "outside" || l === "horizontal" || l === "vertical") {
      const h = [];
      for (let f = r; f <= c; f += 1)
        for (let g = o; g <= a; g += 1) {
          const p = [];
          for (let x = 0; x < h.length; x += 1) {
            const [$, T, D, R] = h[x];
            if (f === $ + D + 1 && p.push(x), $ <= f && f <= $ + D && g === T) {
              g += R + 1;
              break;
            }
          }
          if (p.forEach((x) => h.splice(x, 1)), g > a) break;
          const w = n.getCell(f, g);
          let [v, y] = [0, 0];
          w && w.merge && ([v, y] = w.merge, h.push([f, g, v, y]));
          const C = v > 0 && f + v === c, k = y > 0 && g + y === a;
          let b = {};
          l === "all" ? b = {
            bottom: [t, e],
            top: [t, e],
            left: [t, e],
            right: [t, e]
          } : l === "inside" ? (!k && g < a && (b.right = [t, e]), !C && f < c && (b.bottom = [t, e])) : l === "horizontal" ? !C && f < c && (b.bottom = [t, e]) : l === "vertical" ? !k && g < a && (b.right = [t, e]) : l === "outside" && d && (r === f && (b.top = [t, e]), (C || c === f) && (b.bottom = [t, e]), o === g && (b.left = [t, e]), (k || a === g) && (b.right = [t, e])), Object.keys(b).length > 0 && st.call(this, f, g, b), g += y;
        }
    } else if (l === "top" || l === "bottom")
      for (let h = o; h <= a; h += 1)
        l === "top" && (st.call(this, r, h, { top: [t, e] }), h += n.getCellMerge(r, h)[1]), l === "bottom" && (st.call(this, c, h, { bottom: [t, e] }), h += n.getCellMerge(c, h)[1]);
    else if (l === "left" || l === "right")
      for (let h = r; h <= c; h += 1)
        l === "left" && (st.call(this, h, o, { left: [t, e] }), h += n.getCellMerge(h, o)[0]), l === "right" && (st.call(this, h, a, { right: [t, e] }), h += n.getCellMerge(h, a)[0]);
  }
}
function Ds(l, t) {
  const { rows: e } = this, s = this.freezeTotalHeight();
  let i = e.height;
  s + e.height < l && (i -= t);
  const n = this.exceptRowSet;
  let r = 0, o = i, { height: c } = e;
  for (; r < e.len && !(o > l); r += 1)
    n.has(r) || (c = e.getHeight(r), o += c);
  return o -= c, o <= 0 ? { ri: -1, top: 0, height: c } : { ri: r - 1, top: o, height: c };
}
function Ts(l, t) {
  const { cols: e } = this, s = this.freezeTotalWidth();
  let i = e.indexWidth;
  s + e.indexWidth < l && (i -= t);
  const [n, r, o] = F.rangeReduceIf(
    0,
    e.len,
    i,
    e.indexWidth,
    l,
    (c) => e.getWidth(c)
  );
  return r <= 0 ? { ci: -1, left: 0, width: e.indexWidth } : { ci: n - 1, left: r, width: o };
}
class Os {
  constructor(t, e) {
    this.settings = F.merge(ks, e || {}), this.name = t || "sheet", this.freeze = [0, 0], this.styles = [], this.merges = new qt(), this.rows = new bs(this.settings.row), this.cols = new xs(this.settings.col), this.validations = new ys(), this.hyperlinks = {}, this.comments = {}, this.selector = new rs(), this.scroll = new os(), this.history = new cs(), this.clipboard = new as(), this.autoFilter = new hs(), this.change = () => {
    }, this.exceptRowSet = /* @__PURE__ */ new Set(), this.sortedRowMap = /* @__PURE__ */ new Map(), this.unsortedRowMap = /* @__PURE__ */ new Map();
  }
  addValidation(t, e, s) {
    this.changeData(() => {
      this.validations.add(t, e, s);
    });
  }
  removeValidation() {
    const { range: t } = this.selector;
    this.changeData(() => {
      this.validations.remove(t);
    });
  }
  getSelectedValidator() {
    const { ri: t, ci: e } = this.selector, s = this.validations.get(t, e);
    return s ? s.validator : null;
  }
  getSelectedValidation() {
    const { ri: t, ci: e, range: s } = this.selector, i = this.validations.get(t, e), n = { ref: s.toString() };
    return i !== null && (n.mode = i.mode, n.validator = i.validator), n;
  }
  canUndo() {
    return this.history.canUndo();
  }
  canRedo() {
    return this.history.canRedo();
  }
  undo() {
    this.history.undo(this.getData(), (t) => {
      this.setData(t);
    });
  }
  redo() {
    this.history.redo(this.getData(), (t) => {
      this.setData(t);
    });
  }
  copy() {
    this.clipboard.copy(this.selector.range);
  }
  copyToSystemClipboard() {
    if (navigator.clipboard === void 0)
      return;
    let t = "";
    const e = this.rows.getData();
    for (let s = this.selector.range.sri; s <= this.selector.range.eri; s += 1) {
      if (oe(e, s)) {
        for (let i = this.selector.range.sci; i <= this.selector.range.eci; i += 1)
          if (i > this.selector.range.sci && (t += "	"), oe(e[s].cells, i)) {
            const n = String(e[s].cells[i].text);
            n.indexOf(`
`) === -1 && n.indexOf("	") === -1 && n.indexOf('"') === -1 ? t += n : t += `"${n}"`;
          }
      } else
        for (let i = this.selector.range.sci; i <= this.selector.range.eci; i += 1)
          t += "	";
      t += `
`;
    }
    navigator.clipboard.writeText(t).then(() => {
    }, (s) => {
      console.log("text copy to the system clipboard error  ", t, s);
    });
  }
  cut() {
    this.clipboard.cut(this.selector.range);
  }
  // what: all | text | format
  paste(t = "all", e = () => {
  }) {
    const { clipboard: s, selector: i } = this;
    return s.isClear() || !ce.call(this, s.range, i.range, e) ? !1 : (this.changeData(() => {
      s.isCopy() ? ae.call(this, s.range, i.range, t) : s.isCut() && Ss.call(this, s.range, i.range);
    }), !0);
  }
  pasteFromText(t) {
    const e = t.split(`\r
`).map((n) => n.replace(/"/g, "").split("	"));
    e.length > 0 && (e.length -= 1);
    const { rows: s, selector: i } = this;
    this.changeData(() => {
      s.paste(e, i.range);
    });
  }
  autofill(t, e, s = () => {
  }) {
    const i = this.selector.range;
    return ce.call(this, i, t, s) ? (this.changeData(() => {
      ae.call(this, i, t, e, !0);
    }), !0) : !1;
  }
  clearClipboard() {
    this.clipboard.clear();
  }
  calSelectedRangeByEnd(t, e) {
    const {
      selector: s,
      rows: i,
      cols: n,
      merges: r
    } = this;
    let {
      sri: o,
      sci: c,
      eri: a,
      eci: d
    } = s.range;
    const h = s.ri, f = s.ci;
    let [g, p] = [t, e];
    return t < 0 && (g = i.len - 1), e < 0 && (p = n.len - 1), g > h ? [o, a] = [h, g] : [o, a] = [g, h], p > f ? [c, d] = [f, p] : [c, d] = [p, f], s.range = r.union(new O(
      o,
      c,
      a,
      d
    )), s.range = r.union(s.range), s.range;
  }
  calSelectedRangeByStart(t, e) {
    const {
      selector: s,
      rows: i,
      cols: n,
      merges: r
    } = this;
    let o = r.getFirstIncludes(t, e);
    return o === null && (o = new O(t, e, t, e), t === -1 && (o.sri = 0, o.eri = i.len - 1), e === -1 && (o.sci = 0, o.eci = n.len - 1)), s.range = o, o;
  }
  setSelectedCellAttr(t, e) {
    this.changeData(() => {
      const { selector: s, styles: i, rows: n } = this;
      if (t === "merge")
        e ? this.merge() : this.unmerge();
      else if (t === "border")
        $s.call(this, e);
      else if (t === "formula") {
        const { ri: r, ci: o, range: c } = s;
        if (s.multiple()) {
          const [a, d] = s.size(), {
            sri: h,
            sci: f,
            eri: g,
            eci: p
          } = c;
          if (a > 1)
            for (let w = f; w <= p; w += 1) {
              const v = n.getCellOrNew(g + 1, w);
              v.text = `=${e}(${L(w, h)}:${L(w, g)})`;
            }
          else if (d > 1) {
            const w = n.getCellOrNew(r, p + 1);
            w.text = `=${e}(${L(f, r)}:${L(p, r)})`;
          }
        } else {
          const a = n.getCellOrNew(r, o);
          a.text = `=${e}()`;
        }
      } else
        s.range.each((r, o) => {
          const c = n.getCellOrNew(r, o);
          let a = {};
          if (c.style !== void 0 && (a = F.cloneDeep(i[c.style])), t === "format")
            a.format = e, c.style = this.addStyle(a);
          else if (t === "font-bold" || t === "font-italic" || t === "font-name" || t === "font-size") {
            const d = {};
            d[t.split("-")[1]] = e, a.font = Object.assign(a.font || {}, d), c.style = this.addStyle(a);
          } else t === "strike" || t === "textwrap" || t === "underline" || t === "align" || t === "valign" || t === "color" || t === "bgcolor" ? (a[t] = e, c.style = this.addStyle(a)) : c[t] = e;
        });
    });
  }
  // state: input | finished
  setSelectedCellText(t, e = "input") {
    const { autoFilter: s, selector: i, rows: n } = this, { ri: r, ci: o } = i;
    let c = r;
    this.unsortedRowMap.has(r) && (c = this.unsortedRowMap.get(r));
    const a = n.getCell(c, o), d = a ? a.text : "";
    if (this.setCellText(c, o, t, e), s.active()) {
      const h = s.getFilter(o);
      if (h) {
        const f = h.value.findIndex((g) => g === d);
        f >= 0 && h.value.splice(f, 1, t);
      }
    }
  }
  getSelectedCell() {
    const { ri: t, ci: e } = this.selector;
    let s = t;
    return this.unsortedRowMap.has(t) && (s = this.unsortedRowMap.get(t)), this.rows.getCell(s, e);
  }
  xyInSelectedRect(t, e) {
    const {
      left: s,
      top: i,
      width: n,
      height: r
    } = this.getSelectedRect(), o = t - this.cols.indexWidth, c = e - this.rows.height;
    return o > s && o < s + n && c > i && c < i + r;
  }
  getSelectedRect() {
    return this.getRect(this.selector.range);
  }
  getClipboardRect() {
    const { clipboard: t } = this;
    return t.isClear() ? { left: -100, top: -100 } : this.getRect(t.range);
  }
  getRect(t) {
    const {
      scroll: e,
      rows: s,
      cols: i,
      exceptRowSet: n
    } = this, {
      sri: r,
      sci: o,
      eri: c,
      eci: a
    } = t;
    if (r < 0 && o < 0)
      return {
        left: 0,
        l: 0,
        top: 0,
        t: 0,
        scroll: e
      };
    const d = i.sumWidth(0, o), h = s.sumHeight(0, r, n), f = s.sumHeight(r, c + 1, n), g = i.sumWidth(o, a + 1);
    let p = d - e.x, w = h - e.y;
    const v = this.freezeTotalHeight(), y = this.freezeTotalWidth();
    return y > 0 && y > d && (p = d), v > 0 && v > h && (w = h), {
      l: d,
      t: h,
      left: p,
      top: w,
      height: f,
      width: g,
      scroll: e
    };
  }
  getCellRectByXY(t, e) {
    const {
      scroll: s,
      merges: i,
      rows: n,
      cols: r
    } = this;
    let { ri: o, top: c, height: a } = Ds.call(this, e, s.y), { ci: d, left: h, width: f } = Ts.call(this, t, s.x);
    if (d === -1 && (f = r.totalWidth()), o === -1 && (a = n.totalHeight()), o >= 0 || d >= 0) {
      const g = i.getFirstIncludes(o, d);
      g && (o = g.sri, d = g.sci, {
        left: h,
        top: c,
        width: f,
        height: a
      } = this.cellRect(o, d));
    }
    return {
      ri: o,
      ci: d,
      left: h,
      top: c,
      width: f,
      height: a
    };
  }
  isSignleSelected() {
    const {
      sri: t,
      sci: e,
      eri: s,
      eci: i
    } = this.selector.range, n = this.getCell(t, e);
    if (n && n.merge) {
      const [r, o] = n.merge;
      if (t + r === s && e + o === i) return !0;
    }
    return !this.selector.multiple();
  }
  canUnmerge() {
    const {
      sri: t,
      sci: e,
      eri: s,
      eci: i
    } = this.selector.range, n = this.getCell(t, e);
    if (n && n.merge) {
      const [r, o] = n.merge;
      if (t + r === s && e + o === i) return !0;
    }
    return !1;
  }
  merge() {
    const { selector: t, rows: e } = this;
    if (this.isSignleSelected()) return;
    const [s, i] = t.size();
    if (s > 1 || i > 1) {
      const { sri: n, sci: r } = t.range;
      this.changeData(() => {
        const o = e.getCellOrNew(n, r);
        o.merge = [s - 1, i - 1], this.merges.add(t.range), this.rows.deleteCells(t.range), this.rows.setCell(n, r, o);
      });
    }
  }
  unmerge() {
    const { selector: t } = this;
    if (!this.isSignleSelected()) return;
    const { sri: e, sci: s } = t.range;
    this.changeData(() => {
      this.rows.deleteCell(e, s, "merge"), this.merges.deleteWithin(t.range);
    });
  }
  canAutofilter() {
    return !this.autoFilter.active();
  }
  autofilter() {
    const { autoFilter: t, selector: e } = this;
    this.changeData(() => {
      t.active() ? (t.clear(), this.exceptRowSet = /* @__PURE__ */ new Set(), this.sortedRowMap = /* @__PURE__ */ new Map(), this.unsortedRowMap = /* @__PURE__ */ new Map()) : t.ref = e.range.toString();
    });
  }
  setAutoFilter(t, e, s, i) {
    const { autoFilter: n } = this;
    n.addFilter(t, s, i), n.setSort(t, e), this.resetAutoFilter();
  }
  resetAutoFilter() {
    const { autoFilter: t, rows: e } = this;
    if (!t.active()) return;
    const { sort: s } = t, { rset: i, fset: n } = t.filteredRows((c, a) => e.getCell(c, a)), r = Array.from(n), o = Array.from(n);
    s && r.sort((c, a) => s.order === "asc" ? c - a : s.order === "desc" ? a - c : 0), this.exceptRowSet = i, this.sortedRowMap = /* @__PURE__ */ new Map(), this.unsortedRowMap = /* @__PURE__ */ new Map(), r.forEach((c, a) => {
      this.sortedRowMap.set(o[a], c), this.unsortedRowMap.set(c, o[a]);
    });
  }
  deleteCell(t = "all") {
    const { selector: e } = this;
    this.changeData(() => {
      this.rows.deleteCells(e.range, t), (t === "all" || t === "format") && this.merges.deleteWithin(e.range);
    });
  }
  // type: row | column
  insert(t, e = 1) {
    this.changeData(() => {
      const { sri: s, sci: i } = this.selector.range, { rows: n, merges: r, cols: o } = this;
      let c = s;
      t === "row" ? n.insert(s, e) : t === "column" && (n.insertColumn(i, e), c = i, o.len += 1), r.shift(t, c, e, (a, d, h, f) => {
        const g = n.getCell(a, d);
        g.merge[0] += h, g.merge[1] += f;
      });
    });
  }
  // type: row | column
  delete(t) {
    this.changeData(() => {
      const {
        rows: e,
        merges: s,
        selector: i,
        cols: n
      } = this, { range: r } = i, {
        sri: o,
        sci: c,
        eri: a,
        eci: d
      } = i.range, [h, f] = i.range.size();
      let g = o, p = h;
      t === "row" ? e.delete(o, a) : t === "column" && (e.deleteColumn(c, d), g = r.sci, p = f, n.len -= 1), s.shift(t, g, -p, (w, v, y, C) => {
        const k = e.getCell(w, v);
        k.merge[0] += y, k.merge[1] += C, k.merge[0] === 0 && k.merge[1] === 0 && delete k.merge;
      });
    });
  }
  scrollx(t, e) {
    const { scroll: s, freeze: i, cols: n } = this, [, r] = i, [
      o,
      c,
      a
    ] = F.rangeReduceIf(r, n.len, 0, 0, t, (h) => n.getWidth(h));
    let d = c;
    t > 0 && (d += a), s.x !== d && (s.ci = t > 0 ? o : 0, s.x = d, e());
  }
  scrolly(t, e) {
    const { scroll: s, freeze: i, rows: n } = this, [r] = i, [
      o,
      c,
      a
    ] = F.rangeReduceIf(r, n.len, 0, 0, t, (h) => n.getHeight(h));
    let d = c;
    t > 0 && (d += a), s.y !== d && (s.ri = t > 0 ? o : 0, s.y = d, e());
  }
  cellRect(t, e) {
    const { rows: s, cols: i } = this, n = i.sumWidth(0, e), r = s.sumHeight(0, t), o = s.getCell(t, e);
    let c = i.getWidth(e), a = s.getHeight(t);
    if (o !== null && o.merge) {
      const [d, h] = o.merge;
      if (d > 0)
        for (let f = 1; f <= d; f += 1)
          a += s.getHeight(t + f);
      if (h > 0)
        for (let f = 1; f <= h; f += 1)
          c += i.getWidth(e + f);
    }
    return {
      left: n,
      top: r,
      width: c,
      height: a,
      cell: o
    };
  }
  getCell(t, e) {
    return this.rows.getCell(t, e);
  }
  getCellTextOrDefault(t, e) {
    const s = this.getCell(t, e);
    return s && s.text ? s.text : "";
  }
  getCellStyle(t, e) {
    const s = this.getCell(t, e);
    return s && s.style !== void 0 ? this.styles[s.style] : null;
  }
  getCellStyleOrDefault(t, e) {
    const { styles: s, rows: i } = this, n = i.getCell(t, e), r = n && n.style !== void 0 ? s[n.style] : {};
    return F.merge(this.defaultStyle(), r);
  }
  getSelectedCellStyle() {
    const { ri: t, ci: e } = this.selector;
    return this.getCellStyleOrDefault(t, e);
  }
  // state: input | finished
  setCellText(t, e, s, i) {
    const { rows: n, history: r, validations: o } = this;
    i === "finished" ? (n.setCellText(t, e, ""), r.add(this.getData()), n.setCellText(t, e, s)) : (n.setCellText(t, e, s), this.change(this.getData())), o.validate(t, e, s);
  }
  freezeIsActive() {
    const [t, e] = this.freeze;
    return t > 0 || e > 0;
  }
  setFreeze(t, e) {
    this.changeData(() => {
      this.freeze = [t, e];
    });
  }
  freezeTotalWidth() {
    return this.cols.sumWidth(0, this.freeze[1]);
  }
  freezeTotalHeight() {
    return this.rows.sumHeight(0, this.freeze[0]);
  }
  setRowHeight(t, e) {
    this.changeData(() => {
      this.rows.setHeight(t, e);
    });
  }
  setColWidth(t, e) {
    this.changeData(() => {
      this.cols.setWidth(t, e);
    });
  }
  viewHeight() {
    const { view: t, showToolbar: e, showBottomBar: s } = this.settings;
    let i = t.height();
    return s && (i -= Es), e && (i -= Cs), i;
  }
  viewWidth() {
    return this.settings.view.width();
  }
  freezeViewRange() {
    const [t, e] = this.freeze;
    return new O(0, 0, t - 1, e - 1, this.freezeTotalWidth(), this.freezeTotalHeight());
  }
  contentRange() {
    const { rows: t, cols: e } = this, [s, i] = t.maxCell(), n = t.sumHeight(0, s + 1), r = e.sumWidth(0, i + 1);
    return new O(0, 0, s, i, r, n);
  }
  exceptRowTotalHeight(t, e) {
    const { exceptRowSet: s, rows: i } = this, n = Array.from(s);
    let r = 0;
    return n.forEach((o) => {
      if (o < t || o > e) {
        const c = i.getHeight(o);
        r += c;
      }
    }), r;
  }
  viewRange() {
    const {
      scroll: t,
      rows: e,
      cols: s,
      freeze: i,
      exceptRowSet: n
    } = this;
    let { ri: r, ci: o } = t;
    r <= 0 && ([r] = i), o <= 0 && ([, o] = i);
    let [c, a] = [0, 0], [d, h] = [e.len, s.len];
    for (let f = r; f < e.len && (n.has(f) || (a += e.getHeight(f), d = f), !(a > this.viewHeight())); f += 1)
      ;
    for (let f = o; f < s.len && (c += s.getWidth(f), h = f, !(c > this.viewWidth())); f += 1)
      ;
    return new O(r, o, d, h, c, a);
  }
  eachMergesInView(t, e) {
    this.merges.filterIntersects(t).forEach((s) => e(s));
  }
  hideRowsOrCols() {
    const { rows: t, cols: e, selector: s } = this, [i, n] = s.size(), {
      sri: r,
      sci: o,
      eri: c,
      eci: a
    } = s.range;
    if (i === t.len)
      for (let d = o; d <= a; d += 1)
        e.setHide(d, !0);
    else if (n === e.len)
      for (let d = r; d <= c; d += 1)
        t.setHide(d, !0);
  }
  // type: row | col
  // index row-index | col-index
  unhideRowsOrCols(t, e) {
    this[`${t}s`].unhide(e);
  }
  rowEach(t, e, s) {
    let i = 0;
    const { rows: n } = this, r = this.exceptRowSet, o = [...r];
    let c = 0;
    for (let a = 0; a < o.length; a += 1)
      o[a] < t && (c += 1);
    for (let a = t + c; a <= e + c; a += 1)
      if (r.has(a))
        c += 1;
      else {
        const d = n.getHeight(a);
        if (d > 0 && (s(a, i, d), i += d, i > this.viewHeight()))
          break;
      }
  }
  colEach(t, e, s) {
    let i = 0;
    const { cols: n } = this;
    for (let r = t; r <= e; r += 1) {
      const o = n.getWidth(r);
      if (o > 0 && (s(r, i, o), i += o, i > this.viewWidth()))
        break;
    }
  }
  defaultStyle() {
    return this.settings.style;
  }
  addStyle(t) {
    const { styles: e } = this;
    for (let s = 0; s < e.length; s += 1) {
      const i = e[s];
      if (F.equals(i, t)) return s;
    }
    return e.push(t), e.length - 1;
  }
  changeData(t) {
    this.history.add(this.getData()), t(), this.change(this.getData());
  }
  setData(t) {
    return Object.keys(t).forEach((e) => {
      if (e === "merges" || e === "rows" || e === "cols" || e === "validations")
        this[e].setData(t[e]);
      else if (e === "freeze") {
        const [s, i] = X(t[e]);
        this.freeze = [i, s];
      } else e === "autofilter" ? this.autoFilter.setData(t[e]) : t[e] !== void 0 && (this[e] = t[e]);
    }), this;
  }
  getData() {
    const {
      name: t,
      freeze: e,
      styles: s,
      merges: i,
      rows: n,
      cols: r,
      validations: o,
      autoFilter: c
    } = this;
    return {
      name: t,
      freeze: L(e[1], e[0]),
      styles: s,
      merges: i.getData(),
      rows: n.getData(),
      cols: r.getData(),
      validations: o.getData(),
      autofilter: c.getData()
    };
  }
}
function H(l, t, e) {
  l.addEventListener(t, e);
}
function St(l, t, e) {
  l.removeEventListener(t, e);
}
function ot(l) {
  l.xclickoutside && (St(window.document.body, "click", l.xclickoutside), delete l.xclickoutside);
}
function ft(l, t) {
  l.xclickoutside = (e) => {
    e.detail === 2 || l.contains(e.target) || (t ? t(l) : (l.hide(), ot(l)));
  }, H(window.document.body, "click", l.xclickoutside);
}
function Me(l, t, e) {
  H(l, "mousemove", t);
  const s = l;
  s.xEvtUp = (i) => {
    St(l, "mousemove", t), St(l, "mouseup", l.xEvtUp), e(i);
  }, H(l, "mouseup", l.xEvtUp);
}
function he(l, t, e, s) {
  let i = "";
  Math.abs(l) > Math.abs(t) ? (i = l > 0 ? "right" : "left", s(i, l, e)) : (i = t > 0 ? "down" : "up", s(i, t, e));
}
function Is(l, { move: t, end: e }) {
  let s = 0, i = 0;
  H(l, "touchstart", (n) => {
    const { pageX: r, pageY: o } = n.touches[0];
    s = r, i = o;
  }), H(l, "touchmove", (n) => {
    if (!t) return;
    const { pageX: r, pageY: o } = n.changedTouches[0], c = r - s, a = o - i;
    (Math.abs(c) > 10 || Math.abs(a) > 10) && (he(c, a, n, t), s = r, i = o), n.preventDefault();
  }), H(l, "touchend", (n) => {
    if (!e) return;
    const { pageX: r, pageY: o } = n.changedTouches[0], c = r - s, a = o - i;
    he(c, a, n, e);
  });
}
function As() {
  const l = /* @__PURE__ */ new Map();
  function t(r, o) {
    const c = () => {
      const d = l.get(r);
      return Array.isArray(d) && d.push(o) || !1;
    }, a = () => l.set(r, [].concat(o));
    return l.has(r) && c() || a();
  }
  function e(r, o) {
    const c = () => {
      const a = l.get(r);
      for (const d of a) d.call(null, ...o);
    };
    return l.has(r) && c();
  }
  function s(r, o) {
    const c = () => {
      const a = l.get(r), d = a.indexOf(o);
      return d >= 0 && a.splice(d, 1) && l.get(r).length === 0 && l.delete(r);
    };
    return l.has(r) && c();
  }
  function i(r, o) {
    const c = (...a) => {
      o.call(null, ...a), s(r, c);
    };
    return t(r, c);
  }
  function n() {
    l.clear();
  }
  return {
    get current() {
      return l;
    },
    on: t,
    once: i,
    fire: e,
    removeListener: s,
    removeAllListeners: n
  };
}
const m = "x-spreadsheet";
class de {
  constructor(t = !1, e) {
    this.moving = !1, this.vertical = t, this.el = u("div", `${m}-resizer ${t ? "vertical" : "horizontal"}`).children(
      this.unhideHoverEl = u("div", `${m}-resizer-hover`).on("dblclick.stop", (s) => this.mousedblclickHandler(s)).css("position", "absolute").hide(),
      this.hoverEl = u("div", `${m}-resizer-hover`).on("mousedown.stop", (s) => this.mousedownHandler(s)),
      this.lineEl = u("div", `${m}-resizer-line`).hide()
    ).hide(), this.cRect = null, this.finishedFn = null, this.minDistance = e, this.unhideFn = () => {
    };
  }
  showUnhide(t) {
    this.unhideIndex = t, this.unhideHoverEl.show();
  }
  hideUnhide() {
    this.unhideHoverEl.hide();
  }
  // rect : {top, left, width, height}
  // line : {width, height}
  show(t, e) {
    const {
      moving: s,
      vertical: i,
      hoverEl: n,
      lineEl: r,
      el: o,
      unhideHoverEl: c
    } = this;
    if (s) return;
    this.cRect = t;
    const {
      left: a,
      top: d,
      width: h,
      height: f
    } = t;
    o.offset({
      left: i ? a + h - 5 : a,
      top: i ? d : d + f - 5
    }).show(), n.offset({
      width: i ? 5 : h,
      height: i ? f : 5
    }), r.offset({
      width: i ? 0 : e.width,
      height: i ? e.height : 0
    }), c.offset({
      left: i ? 5 - h : a,
      top: i ? d : 5 - f,
      width: i ? 5 : h,
      height: i ? f : 5
    });
  }
  hide() {
    this.el.offset({
      left: 0,
      top: 0
    }).hide(), this.hideUnhide();
  }
  mousedblclickHandler() {
    this.unhideIndex && this.unhideFn(this.unhideIndex);
  }
  mousedownHandler(t) {
    let e = t;
    const {
      el: s,
      lineEl: i,
      cRect: n,
      vertical: r,
      minDistance: o
    } = this;
    let c = r ? n.width : n.height;
    i.show(), Me(window, (a) => {
      this.moving = !0, e !== null && a.buttons === 1 && (r ? (c += a.movementX, c > o && s.css("left", `${n.left + c}px`)) : (c += a.movementY, c > o && s.css("top", `${n.top + c}px`)), e = a);
    }, () => {
      e = null, i.hide(), this.moving = !1, this.hide(), this.finishedFn && (c < o && (c = o), this.finishedFn(n, c));
    });
  }
}
class fe {
  constructor(t) {
    this.vertical = t, this.moveFn = null, this.el = u("div", `${m}-scrollbar ${t ? "vertical" : "horizontal"}`).child(this.contentEl = u("div", "")).on("mousemove.stop", () => {
    }).on("scroll.stop", (e) => {
      const { scrollTop: s, scrollLeft: i } = e.target;
      this.moveFn && this.moveFn(this.vertical ? s : i, e);
    });
  }
  move(t) {
    return this.el.scroll(t), this;
  }
  scroll() {
    return this.el.scroll();
  }
  set(t, e) {
    const s = t - 1;
    if (e > s) {
      const i = this.vertical ? "height" : "width";
      this.el.css(i, `${s - 15}px`).show(), this.contentEl.css(this.vertical ? "width" : "height", "1px").css(i, `${e}px`);
    } else
      this.el.hide();
    return this;
  }
}
const mt = 3;
let Wt = 10;
class wt {
  constructor(t = !1) {
    this.useHideInput = t, this.inputChange = () => {
    }, this.cornerEl = u("div", `${m}-selector-corner`), this.areaEl = u("div", `${m}-selector-area`).child(this.cornerEl).hide(), this.clipboardEl = u("div", `${m}-selector-clipboard`).hide(), this.autofillEl = u("div", `${m}-selector-autofill`).hide(), this.el = u("div", `${m}-selector`).css("z-index", `${Wt}`).children(this.areaEl, this.clipboardEl, this.autofillEl).hide(), t && (this.hideInput = u("input", "").on("compositionend", (e) => {
      this.inputChange(e.target.value);
    }), this.el.child(this.hideInputDiv = u("div", "hide-input").child(this.hideInput)), this.el.child(this.hideInputDiv = u("div", "hide-input").child(this.hideInput))), Wt += 1;
  }
  setOffset(t) {
    return this.el.offset(t).show(), this;
  }
  hide() {
    return this.el.hide(), this;
  }
  setAreaOffset(t) {
    const {
      left: e,
      top: s,
      width: i,
      height: n
    } = t, r = {
      width: i - mt + 0.8,
      height: n - mt + 0.8,
      left: e - 0.8,
      top: s - 0.8
    };
    this.areaEl.offset(r).show(), this.useHideInput && (this.hideInputDiv.offset(r), this.hideInput.val("").focus());
  }
  setClipboardOffset(t) {
    const {
      left: e,
      top: s,
      width: i,
      height: n
    } = t;
    this.clipboardEl.offset({
      left: e,
      top: s,
      width: i - 5,
      height: n - 5
    });
  }
  showAutofill(t) {
    const {
      left: e,
      top: s,
      width: i,
      height: n
    } = t;
    this.autofillEl.offset({
      width: i - mt,
      height: n - mt,
      left: e,
      top: s
    }).show();
  }
  hideAutofill() {
    this.autofillEl.hide();
  }
  showClipboard() {
    this.clipboardEl.show();
  }
  hideClipboard() {
    this.clipboardEl.hide();
  }
}
function Ut(l) {
  const { data: t } = this, {
    left: e,
    top: s,
    width: i,
    height: n,
    scroll: r,
    l: o,
    t: c
  } = l, a = t.freezeTotalWidth(), d = t.freezeTotalHeight();
  let h = e - a;
  a > o && (h -= r.x);
  let f = s - d;
  return d > c && (f -= r.y), {
    left: h,
    top: f,
    width: i,
    height: n
  };
}
function jt(l) {
  const { data: t } = this, {
    left: e,
    width: s,
    height: i,
    l: n,
    t: r,
    scroll: o
  } = l, c = t.freezeTotalWidth();
  let a = e - c;
  return c > n && (a -= o.x), {
    left: a,
    top: r,
    width: s,
    height: i
  };
}
function Yt(l) {
  const { data: t } = this, {
    top: e,
    width: s,
    height: i,
    l: n,
    t: r,
    scroll: o
  } = l, c = t.freezeTotalHeight();
  let a = e - c;
  return c > r && (a -= o.y), {
    left: n,
    top: a,
    width: s,
    height: i
  };
}
function Vt(l) {
  const { br: t } = this;
  t.setAreaOffset(Ut.call(this, l));
}
function Rs(l) {
  const { tl: t } = this;
  t.setAreaOffset(l);
}
function He(l) {
  const { t } = this;
  t.setAreaOffset(jt.call(this, l));
}
function Ne(l) {
  const { l: t } = this;
  t.setAreaOffset(Yt.call(this, l));
}
function We(l) {
  const { l: t } = this;
  t.setClipboardOffset(Yt.call(this, l));
}
function Pt(l) {
  const { br: t } = this;
  t.setClipboardOffset(Ut.call(this, l));
}
function zs(l) {
  const { tl: t } = this;
  t.setClipboardOffset(l);
}
function Ve(l) {
  const { t } = this;
  t.setClipboardOffset(jt.call(this, l));
}
function ue(l) {
  Vt.call(this, l), Rs.call(this, l), He.call(this, l), Ne.call(this, l);
}
function ge(l) {
  Pt.call(this, l), zs.call(this, l), Ve.call(this, l), We.call(this, l);
}
class Fs {
  constructor(t) {
    this.inputChange = () => {
    }, this.data = t, this.br = new wt(!0), this.t = new wt(), this.l = new wt(), this.tl = new wt(), this.br.inputChange = (e) => {
      this.inputChange(e);
    }, this.br.el.show(), this.offset = null, this.areaOffset = null, this.indexes = null, this.range = null, this.arange = null, this.el = u("div", `${m}-selectors`).children(
      this.tl.el,
      this.t.el,
      this.l.el,
      this.br.el
    ).hide(), this.lastri = -1, this.lastci = -1, Wt += 1;
  }
  resetData(t) {
    this.data = t, this.range = t.selector.range, this.resetAreaOffset();
  }
  hide() {
    this.el.hide();
  }
  resetOffset() {
    const {
      data: t,
      tl: e,
      t: s,
      l: i,
      br: n
    } = this, r = t.freezeTotalHeight(), o = t.freezeTotalWidth();
    r > 0 || o > 0 ? (e.setOffset({ width: o, height: r }), s.setOffset({ left: o, height: r }), i.setOffset({ top: r, width: o }), n.setOffset({ left: o, top: r })) : (e.hide(), s.hide(), i.hide(), n.setOffset({ left: 0, top: 0 }));
  }
  resetAreaOffset() {
    const t = this.data.getSelectedRect(), e = this.data.getClipboardRect();
    ue.call(this, t), ge.call(this, e), this.resetOffset();
  }
  resetBRTAreaOffset() {
    const t = this.data.getSelectedRect(), e = this.data.getClipboardRect();
    Vt.call(this, t), He.call(this, t), Pt.call(this, e), Ve.call(this, e), this.resetOffset();
  }
  resetBRLAreaOffset() {
    const t = this.data.getSelectedRect(), e = this.data.getClipboardRect();
    Vt.call(this, t), Ne.call(this, t), Pt.call(this, e), We.call(this, e), this.resetOffset();
  }
  set(t, e, s = !0) {
    const { data: i } = this, n = i.calSelectedRangeByStart(t, e), { sri: r, sci: o } = n;
    if (s) {
      let [c, a] = [t, e];
      t < 0 && (c = 0), e < 0 && (a = 0), i.selector.setIndexes(c, a), this.indexes = [c, a];
    }
    this.moveIndexes = [r, o], this.range = n, this.resetAreaOffset(), this.el.show();
  }
  setEnd(t, e, s = !0) {
    const { data: i, lastri: n, lastci: r } = this;
    if (s) {
      if (t === n && e === r) return;
      this.lastri = t, this.lastci = e;
    }
    this.range = i.calSelectedRangeByEnd(t, e), ue.call(this, this.data.getSelectedRect());
  }
  reset() {
    const { eri: t, eci: e } = this.data.selector.range;
    this.setEnd(t, e);
  }
  showAutofill(t, e) {
    if (t === -1 && e === -1) return;
    const {
      sri: s,
      sci: i,
      eri: n,
      eci: r
    } = this.range, [o, c] = [t, e], a = s - t, d = i - e, h = n - t, f = r - e;
    if (d > 0)
      this.arange = new O(s, c, n, i - 1);
    else if (a > 0)
      this.arange = new O(o, i, s - 1, r);
    else if (f < 0)
      this.arange = new O(s, r + 1, n, c);
    else if (h < 0)
      this.arange = new O(n + 1, i, o, r);
    else {
      this.arange = null;
      return;
    }
    if (this.arange !== null) {
      const g = this.data.getRect(this.arange);
      g.width += 2, g.height += 2;
      const {
        br: p,
        l: w,
        t: v,
        tl: y
      } = this;
      p.showAutofill(Ut.call(this, g)), w.showAutofill(Yt.call(this, g)), v.showAutofill(jt.call(this, g)), y.showAutofill(g);
    }
  }
  hideAutofill() {
    ["br", "l", "t", "tl"].forEach((t) => {
      this[t].hideAutofill();
    });
  }
  showClipboard() {
    const t = this.data.getClipboardRect();
    ge.call(this, t), ["br", "l", "t", "tl"].forEach((e) => {
      this[e].showClipboard();
    });
  }
  hideClipboard() {
    ["br", "l", "t", "tl"].forEach((t) => {
      this[t].hideClipboard();
    });
  }
}
function Ms(l) {
  l.preventDefault(), l.stopPropagation();
  const { filterItems: t } = this;
  t.length <= 0 || (this.itemIndex >= 0 && t[this.itemIndex].toggle(), this.itemIndex -= 1, this.itemIndex < 0 && (this.itemIndex = t.length - 1), t[this.itemIndex].toggle());
}
function Hs(l) {
  l.stopPropagation();
  const { filterItems: t } = this;
  t.length <= 0 || (this.itemIndex >= 0 && t[this.itemIndex].toggle(), this.itemIndex += 1, this.itemIndex > t.length - 1 && (this.itemIndex = 0), t[this.itemIndex].toggle());
}
function pe(l) {
  l.preventDefault();
  const { filterItems: t } = this;
  t.length <= 0 || (l.stopPropagation(), this.itemIndex < 0 && (this.itemIndex = 0), t[this.itemIndex].el.click(), this.hide());
}
function Ns(l) {
  const { keyCode: t } = l;
  switch (l.ctrlKey && l.stopPropagation(), t) {
    case 37:
      l.stopPropagation();
      break;
    case 38:
      Ms.call(this, l);
      break;
    case 39:
      l.stopPropagation();
      break;
    case 40:
      Hs.call(this, l);
      break;
    case 13:
      pe.call(this, l);
      break;
    case 9:
      pe.call(this, l);
      break;
    default:
      l.stopPropagation();
      break;
  }
}
class Pe {
  constructor(t, e, s = "200px") {
    this.filterItems = [], this.items = t, this.el = u("div", `${m}-suggest`).css("width", s).hide(), this.itemClick = e, this.itemIndex = -1;
  }
  setOffset(t) {
    this.el.cssRemoveKeys("top", "bottom").offset(t);
  }
  hide() {
    const { el: t } = this;
    this.filterItems = [], this.itemIndex = -1, t.hide(), ot(this.el.parent());
  }
  setItems(t) {
    this.items = t;
  }
  search(t) {
    let { items: e } = this;
    if (/^\s*$/.test(t) || (e = e.filter((i) => (i.key || i).startsWith(t.toUpperCase()))), e = e.map((i) => {
      let { title: n } = i;
      n ? typeof n == "function" && (n = n()) : n = i;
      const r = u("div", `${m}-item`).child(n).on("click.stop", () => {
        this.itemClick(i), this.hide();
      });
      return i.label && r.child(u("div", "label").html(i.label)), r;
    }), this.filterItems = e, e.length <= 0)
      return;
    const { el: s } = this;
    s.html("").children(...e).show(), ft(s.parent(), () => {
      this.hide();
    });
  }
  bindInputEvents(t) {
    t.on("keydown", (e) => Ns.call(this, e));
  }
}
class A extends Q {
  constructor(t) {
    super("div", `${m}-icon`), this.iconNameEl = u("div", `${m}-icon-img ${t}`), this.child(this.iconNameEl);
  }
  setName(t) {
    this.iconNameEl.className(`${m}-icon-img ${t}`);
  }
}
function me(l, t) {
  l.setMonth(l.getMonth() + t);
}
function Ws(l, t) {
  const e = new Date(l);
  return e.setDate(t - l.getDay() + 1), e;
}
function Vs(l, t, e) {
  const s = new Date(l, t, 1, 23, 59, 59), i = [[], [], [], [], [], []];
  for (let n = 0; n < 6; n += 1)
    for (let r = 0; r < 7; r += 1) {
      const o = n * 7 + r, c = Ws(s, o), a = c.getMonth() !== t, d = c.getMonth() === e.getMonth() && c.getDate() === e.getDate();
      i[n][r] = { d: c, disabled: a, active: d };
    }
  return i;
}
class Ps {
  constructor(t) {
    this.value = t, this.cvalue = new Date(t), this.headerLeftEl = u("div", "calendar-header-left"), this.bodyEl = u("tbody", ""), this.buildAll(), this.el = u("div", "x-spreadsheet-calendar").children(
      u("div", "calendar-header").children(
        this.headerLeftEl,
        u("div", "calendar-header-right").children(
          u("a", "calendar-prev").on("click.stop", () => this.prev()).child(new A("chevron-left")),
          u("a", "calendar-next").on("click.stop", () => this.next()).child(new A("chevron-right"))
        )
      ),
      u("table", "calendar-body").children(
        u("thead", "").child(
          u("tr", "").children(
            ...I("calendar.weeks").map((e) => u("th", "cell").child(e))
          )
        ),
        this.bodyEl
      )
    ), this.selectChange = () => {
    };
  }
  setValue(t) {
    this.value = t, this.cvalue = new Date(t), this.buildAll();
  }
  prev() {
    const { value: t } = this;
    me(t, -1), this.buildAll();
  }
  next() {
    const { value: t } = this;
    me(t, 1), this.buildAll();
  }
  buildAll() {
    this.buildHeaderLeft(), this.buildBody();
  }
  buildHeaderLeft() {
    const { value: t } = this;
    this.headerLeftEl.html(`${I("calendar.months")[t.getMonth()]} ${t.getFullYear()}`);
  }
  buildBody() {
    const { value: t, cvalue: e, bodyEl: s } = this, n = Vs(t.getFullYear(), t.getMonth(), e).map((r) => {
      const o = r.map((c) => {
        let a = "cell";
        return c.disabled && (a += " disabled"), c.active && (a += " active"), u("td", "").child(
          u("div", a).on("click.stop", () => {
            this.selectChange(c.d);
          }).child(c.d.getDate().toString())
        );
      });
      return u("tr", "").children(...o);
    });
    s.html("").children(...n);
  }
}
class Bs {
  constructor() {
    this.calendar = new Ps(/* @__PURE__ */ new Date()), this.el = u("div", `${m}-datepicker`).child(
      this.calendar.el
    ).hide();
  }
  setValue(t) {
    const { calendar: e } = this;
    return typeof t == "string" ? /^\d{4}-\d{1,2}-\d{1,2}$/.test(t) && e.setValue(new Date(t.replace(new RegExp("-", "g"), "/"))) : t instanceof Date && e.setValue(t), this;
  }
  change(t) {
    this.calendar.selectChange = (e) => {
      t(e), this.hide();
    };
  }
  show() {
    this.el.show();
  }
  hide() {
    this.el.hide();
  }
}
function $t() {
  const { inputText: l } = this;
  if (!/^\s*$/.test(l)) {
    const {
      textlineEl: t,
      textEl: e,
      areaOffset: s
    } = this, i = l.split(`
`), n = Math.max(...i.map((h) => h.length)), o = t.offset().width / l.length, c = (n + 1) * o + 5, a = this.viewFn().width - s.left - o;
    let d = i.length;
    if (c > s.width) {
      let h = c;
      c > a && (h = a, d += parseInt(c / a, 10), d += c % a > 0 ? 1 : 0), e.css("width", `${h}px`);
    }
    d *= this.rowHeight, d > s.height && e.css("height", `${d}px`);
  }
}
function _s({ target: l }, t) {
  const { value: e, selectionEnd: s } = l, i = `${e.slice(0, s)}${t}${e.slice(s)}`;
  l.value = i, l.setSelectionRange(s + 1, s + 1), this.inputText = i, this.textlineEl.html(i), $t.call(this);
}
function Ls(l) {
  const { keyCode: t, altKey: e } = l;
  t !== 13 && t !== 9 && l.stopPropagation(), t === 13 && e && (_s.call(this, l, `
`), l.stopPropagation()), t === 13 && !e && l.preventDefault();
}
function qs(l) {
  const t = l.target.value, { suggest: e, textlineEl: s, validator: i } = this, { cell: n } = this;
  if (n !== null)
    if ("editable" in n && n.editable === !0 || n.editable === void 0) {
      if (this.inputText = t, i)
        i.type === "list" ? e.search(t) : e.hide();
      else {
        const r = t.lastIndexOf("=");
        r !== -1 ? e.search(t.substring(r + 1)) : e.hide();
      }
      s.html(t), $t.call(this), this.change("input", t);
    } else
      l.target.value = n.text;
  else {
    if (this.inputText = t, i)
      i.type === "list" ? e.search(t) : e.hide();
    else {
      const r = t.lastIndexOf("=");
      r !== -1 ? e.search(t.substring(r + 1)) : e.hide();
    }
    s.html(t), $t.call(this), this.change("input", t);
  }
}
function Us(l) {
  const { el: t } = this.textEl;
  setTimeout(() => {
    t.focus(), t.setSelectionRange(l, l);
  }, 0);
}
function Be(l, t) {
  const { textEl: e, textlineEl: s } = this;
  e.el.blur(), e.val(l), s.html(l), Us.call(this, t);
}
function js(l) {
  const { inputText: t, validator: e } = this;
  let s = 0;
  if (e && e.type === "list")
    this.inputText = l, s = this.inputText.length;
  else {
    const i = t.lastIndexOf("="), n = t.substring(0, i + 1);
    let r = t.substring(i + 1);
    r.indexOf(")") !== -1 ? r = r.substring(r.indexOf(")")) : r = "", this.inputText = `${n + l.key}(`, s = this.inputText.length, this.inputText += `)${r}`;
  }
  Be.call(this, this.inputText, s);
}
function Ys() {
  this.suggest.setItems(this.formulas);
}
function Xs(l) {
  let t = l.getMonth() + 1, e = l.getDate();
  return t < 10 && (t = `0${t}`), e < 10 && (e = `0${e}`), `${l.getFullYear()}-${t}-${e}`;
}
class Zs {
  constructor(t, e, s) {
    this.viewFn = e, this.rowHeight = s, this.formulas = t, this.suggest = new Pe(t, (i) => {
      js.call(this, i);
    }), this.datepicker = new Bs(), this.datepicker.change((i) => {
      this.setText(Xs(i)), this.clear();
    }), this.areaEl = u("div", `${m}-editor-area`).children(
      this.textEl = u("textarea", "").on("input", (i) => qs.call(this, i)).on("paste.stop", () => {
      }).on("keydown", (i) => Ls.call(this, i)),
      this.textlineEl = u("div", "textline"),
      this.suggest.el,
      this.datepicker.el
    ).on("mousemove.stop", () => {
    }).on("mousedown.stop", () => {
    }), this.el = u("div", `${m}-editor`).child(this.areaEl).hide(), this.suggest.bindInputEvents(this.textEl), this.areaOffset = null, this.freeze = { w: 0, h: 0 }, this.cell = null, this.inputText = "", this.change = () => {
    };
  }
  setFreezeLengths(t, e) {
    this.freeze.w = t, this.freeze.h = e;
  }
  clear() {
    this.inputText !== "" && this.change("finished", this.inputText), this.cell = null, this.areaOffset = null, this.inputText = "", this.el.hide(), this.textEl.val(""), this.textlineEl.html(""), Ys.call(this), this.datepicker.hide();
  }
  setOffset(t, e = "top") {
    const {
      textEl: s,
      areaEl: i,
      suggest: n,
      freeze: r,
      el: o
    } = this;
    if (t) {
      this.areaOffset = t;
      const {
        left: c,
        top: a,
        width: d,
        height: h,
        l: f,
        t: g
      } = t, p = { left: 0, top: 0 };
      r.w > f && r.h > g || (r.w < f && r.h < g ? (p.left = r.w, p.top = r.h) : r.w > f ? p.top = r.h : r.h > g && (p.left = r.w)), o.offset(p), i.offset({ left: c - p.left - 0.8, top: a - p.top - 0.8 }), s.offset({ width: d - 9 + 0.8, height: h - 3 + 0.8 });
      const w = { left: 0 };
      w[e] = h, n.setOffset(w), n.hide();
    }
  }
  setCell(t, e) {
    const { el: s, datepicker: i, suggest: n } = this;
    s.show(), this.cell = t;
    const r = t && t.text || "";
    if (this.setText(r), this.validator = e, e) {
      const { type: o } = e;
      o === "date" && (i.show(), /^\s*$/.test(r) || i.setValue(r)), o === "list" && (n.setItems(e.values()), n.search(""));
    }
  }
  setText(t) {
    this.inputText = t, Be.call(this, t, t.length), $t.call(this);
  }
}
class G extends Q {
  // type: primary
  constructor(t, e = "") {
    super("div", `${m}-button ${e}`), this.child(I(`button.${t}`));
  }
}
function Dt() {
  return window.devicePixelRatio || 1;
}
function Xt() {
  return Dt() - 0.5;
}
function E(l) {
  return parseInt(l * Dt(), 10);
}
function it(l) {
  const t = E(l);
  return t > 0 ? t - 0.5 : 0.5;
}
class Ks {
  constructor(t, e, s, i, n = 0) {
    this.x = t, this.y = e, this.width = s, this.height = i, this.padding = n, this.bgcolor = "#ffffff", this.borderTop = null, this.borderRight = null, this.borderBottom = null, this.borderLeft = null;
  }
  setBorders({
    top: t,
    bottom: e,
    left: s,
    right: i
  }) {
    t && (this.borderTop = t), i && (this.borderRight = i), e && (this.borderBottom = e), s && (this.borderLeft = s);
  }
  innerWidth() {
    return this.width - this.padding * 2 - 2;
  }
  innerHeight() {
    return this.height - this.padding * 2 - 2;
  }
  textx(t) {
    const { width: e, padding: s } = this;
    let { x: i } = this;
    return t === "left" ? i += s : t === "center" ? i += e / 2 : t === "right" && (i += e - s), i;
  }
  texty(t, e) {
    const { height: s, padding: i } = this;
    let { y: n } = this;
    return t === "top" ? n += i : t === "middle" ? n += s / 2 - e / 2 : t === "bottom" && (n += s - i - e), n;
  }
  topxys() {
    const { x: t, y: e, width: s } = this;
    return [[t, e], [t + s, e]];
  }
  rightxys() {
    const {
      x: t,
      y: e,
      width: s,
      height: i
    } = this;
    return [[t + s, e], [t + s, e + i]];
  }
  bottomxys() {
    const {
      x: t,
      y: e,
      width: s,
      height: i
    } = this;
    return [[t, e + i], [t + s, e + i]];
  }
  leftxys() {
    const {
      x: t,
      y: e,
      height: s
    } = this;
    return [[t, e], [t, e + s]];
  }
}
function we(l, t, e, s, i, n, r) {
  const o = { x: 0, y: 0 };
  l === "underline" ? i === "bottom" ? o.y = 0 : i === "top" ? o.y = -(n + 2) : o.y = -n / 2 : l === "strike" && (i === "bottom" ? o.y = n / 2 : i === "top" && (o.y = -(n / 2 + 2))), s === "center" ? o.x = r / 2 : s === "right" && (o.x = r), this.line(
    [t - o.x, e - o.y],
    [t - o.x + r, e - o.y]
  );
}
class _e {
  constructor(t, e, s) {
    this.el = t, this.ctx = t.getContext("2d"), this.resize(e, s), this.ctx.scale(Dt(), Dt());
  }
  resize(t, e) {
    this.el.style.width = `${t}px`, this.el.style.height = `${e}px`, this.el.width = E(t), this.el.height = E(e);
  }
  clear() {
    const { width: t, height: e } = this.el;
    return this.ctx.clearRect(0, 0, t, e), this;
  }
  attr(t) {
    return Object.assign(this.ctx, t), this;
  }
  save() {
    return this.ctx.save(), this.ctx.beginPath(), this;
  }
  restore() {
    return this.ctx.restore(), this;
  }
  beginPath() {
    return this.ctx.beginPath(), this;
  }
  translate(t, e) {
    return this.ctx.translate(E(t), E(e)), this;
  }
  scale(t, e) {
    return this.ctx.scale(t, e), this;
  }
  clearRect(t, e, s, i) {
    return this.ctx.clearRect(t, e, s, i), this;
  }
  fillRect(t, e, s, i) {
    return this.ctx.fillRect(E(t) - 0.5, E(e) - 0.5, E(s), E(i)), this;
  }
  fillText(t, e, s) {
    return this.ctx.fillText(t, E(e), E(s)), this;
  }
  /*
    txt: render text
    box: DrawBox
    attr: {
      align: left | center | right
      valign: top | middle | bottom
      color: '#333333',
      strike: false,
      font: {
        name: 'Arial',
        size: 14,
        bold: false,
        italic: false,
      }
    }
    textWrap: text wrapping
  */
  text(t, e, s = {}, i = !0) {
    const { ctx: n } = this, {
      align: r,
      valign: o,
      font: c,
      color: a,
      strike: d,
      underline: h
    } = s, f = e.textx(r);
    n.save(), n.beginPath(), this.attr({
      textAlign: r,
      textBaseline: o,
      font: `${c.italic ? "italic" : ""} ${c.bold ? "bold" : ""} ${E(c.size)}px ${c.name}`,
      fillStyle: a,
      strokeStyle: a
    });
    const g = `${t}`.split(`
`), p = e.innerWidth(), w = [];
    g.forEach((C) => {
      const k = n.measureText(C).width;
      if (i && k > E(p)) {
        let b = { w: 0, len: 0, start: 0 };
        for (let x = 0; x < C.length; x += 1)
          b.w >= E(p) && (w.push(C.substr(b.start, b.len)), b = { w: 0, len: 0, start: x }), b.len += 1, b.w += n.measureText(C[x]).width + 1;
        b.len > 0 && w.push(C.substr(b.start, b.len));
      } else
        w.push(C);
    });
    const v = (w.length - 1) * (c.size + 2);
    let y = e.texty(o, v);
    return w.forEach((C) => {
      const k = n.measureText(C).width;
      this.fillText(C, f, y), d && we.call(this, "strike", f, y, r, o, c.size, k), h && we.call(this, "underline", f, y, r, o, c.size, k), y += c.size + 2;
    }), n.restore(), this;
  }
  border(t, e) {
    const { ctx: s } = this;
    return s.lineWidth = Xt, s.strokeStyle = e, t === "medium" ? s.lineWidth = E(2) - 0.5 : t === "thick" ? s.lineWidth = E(3) : t === "dashed" ? s.setLineDash([E(3), E(2)]) : t === "dotted" ? s.setLineDash([E(1), E(1)]) : t === "double" && s.setLineDash([E(2), 0]), this;
  }
  line(...t) {
    const { ctx: e } = this;
    if (t.length > 1) {
      e.beginPath();
      const [s, i] = t[0];
      e.moveTo(it(s), it(i));
      for (let n = 1; n < t.length; n += 1) {
        const [r, o] = t[n];
        e.lineTo(it(r), it(o));
      }
      e.stroke();
    }
    return this;
  }
  strokeBorders(t) {
    const { ctx: e } = this;
    e.save();
    const {
      borderTop: s,
      borderRight: i,
      borderBottom: n,
      borderLeft: r
    } = t;
    s && (this.border(...s), this.line(...t.topxys())), i && (this.border(...i), this.line(...t.rightxys())), n && (this.border(...n), this.line(...t.bottomxys())), r && (this.border(...r), this.line(...t.leftxys())), e.restore();
  }
  dropdown(t) {
    const { ctx: e } = this, {
      x: s,
      y: i,
      width: n,
      height: r
    } = t, o = s + n - 15, c = i + r - 15;
    e.save(), e.beginPath(), e.moveTo(E(o), E(c)), e.lineTo(E(o + 8), E(c)), e.lineTo(E(o + 4), E(c + 6)), e.closePath(), e.fillStyle = "rgba(0, 0, 0, .45)", e.fill(), e.restore();
  }
  error(t) {
    const { ctx: e } = this, { x: s, y: i, width: n } = t, r = s + n - 1;
    e.save(), e.beginPath(), e.moveTo(E(r - 8), E(i - 1)), e.lineTo(E(r), E(i - 1)), e.lineTo(E(r), E(i + 8)), e.closePath(), e.fillStyle = "rgba(255, 0, 0, .65)", e.fill(), e.restore();
  }
  frozen(t) {
    const { ctx: e } = this, { x: s, y: i, width: n } = t, r = s + n - 1;
    e.save(), e.beginPath(), e.moveTo(E(r - 8), E(i - 1)), e.lineTo(E(r), E(i - 1)), e.lineTo(E(r), E(i + 8)), e.closePath(), e.fillStyle = "rgba(0, 255, 0, .85)", e.fill(), e.restore();
  }
  rect(t, e) {
    const { ctx: s } = this, {
      x: i,
      y: n,
      width: r,
      height: o,
      bgcolor: c
    } = t;
    s.save(), s.beginPath(), s.fillStyle = c || "#fff", s.rect(it(i + 1), it(n + 1), E(r - 2), E(o - 2)), s.clip(), s.fill(), e(), s.restore();
  }
}
const be = [
  { key: "Arial", title: "Arial" },
  { key: "Helvetica", title: "Helvetica" },
  { key: "Source Sans Pro", title: "Source Sans Pro" },
  { key: "Comic Sans MS", title: "Comic Sans MS" },
  { key: "Courier New", title: "Courier New" },
  { key: "Verdana", title: "Verdana" },
  { key: "Lato", title: "Lato" }
], Bt = [
  { pt: 7.5, px: 10 },
  { pt: 8, px: 11 },
  { pt: 9, px: 12 },
  { pt: 10, px: 13 },
  { pt: 10.5, px: 14 },
  { pt: 11, px: 15 },
  { pt: 12, px: 16 },
  { pt: 14, px: 18.7 },
  { pt: 15, px: 20 },
  { pt: 16, px: 21.3 },
  { pt: 18, px: 24 },
  { pt: 22, px: 29.3 },
  { pt: 24, px: 32 },
  { pt: 26, px: 34.7 },
  { pt: 36, px: 48 },
  { pt: 42, px: 56 }
  // { pt: 54, px: 71.7 },
  // { pt: 63, px: 83.7 },
  // { pt: 72, px: 95.6 },
];
function Gs(l) {
  for (let t = 0; t < Bt.length; t += 1) {
    const e = Bt[t];
    if (e.pt === l)
      return e.px;
  }
  return l;
}
const Js = (l) => {
  const t = [], e = [];
  let s = [], i = 0, n = "", r = 1, o = "";
  for (let c = 0; c < l.length; c += 1) {
    const a = l.charAt(c);
    if (a !== " ") {
      if (a >= "a" && a <= "z")
        s.push(a.toUpperCase());
      else if (a >= "0" && a <= "9" || a >= "A" && a <= "Z" || a === ".")
        s.push(a);
      else if (a === '"') {
        for (c += 1; l.charAt(c) !== '"'; )
          s.push(l.charAt(c)), c += 1;
        e.push(`"${s.join("")}`), s = [];
      } else if (a === "-" && /[+\-*/,(]/.test(o))
        s.push(a);
      else {
        if (a !== "(" && s.length > 0 && e.push(s.join("")), a === ")") {
          let d = t.pop();
          if (i === 2)
            try {
              const [h, f] = X(e.pop()), [g, p] = X(e.pop());
              let w = 0;
              for (let v = g; v <= h; v += 1)
                for (let y = p; y <= f; y += 1)
                  e.push(L(v, y)), w += 1;
              e.push([d, w]);
            } catch {
            }
          else if (i === 1 || i === 3)
            i === 3 && e.push(n), e.push([d, r]), r = 1;
          else
            for (; d !== "(" && (e.push(d), !(t.length <= 0)); )
              d = t.pop();
          i = 0;
        } else if (a === "=" || a === ">" || a === "<") {
          const d = l.charAt(c + 1);
          n = a, (d === "=" || d === "-") && (n += d, c += 1), i = 3;
        } else if (a === ":")
          i = 2;
        else if (a === ",")
          i === 3 && e.push(n), i = 1, r += 1;
        else if (a === "(" && s.length > 0)
          t.push(s.join(""));
        else {
          if (t.length > 0 && (a === "+" || a === "-")) {
            let d = t[t.length - 1];
            if (d !== "(" && e.push(t.pop()), d === "*" || d === "/")
              for (; t.length > 0 && (d = t[t.length - 1], d !== "("); )
                e.push(t.pop());
          } else if (t.length > 0) {
            const d = t[t.length - 1];
            (d === "*" || d === "/") && e.push(t.pop());
          }
          t.push(a);
        }
        s = [];
      }
      o = a;
    }
  }
  for (s.length > 0 && e.push(s.join("")); t.length > 0; )
    e.push(t.pop());
  return e;
}, Qs = (l, t) => {
  const [e] = l;
  let s = l;
  if (e === '"')
    return l.substring(1);
  let i = 1;
  if (e === "-" && (s = l.substring(1), i = -1), s[0] >= "0" && s[0] <= "9")
    return i * Number(s);
  const [n, r] = X(s);
  return i * t(n, r);
}, ti = (l, t, e, s) => {
  const i = [];
  for (let n = 0; n < l.length; n += 1) {
    const r = l[n], o = r[0];
    if (r === "+") {
      const c = i.pop();
      i.push(K("+", i.pop(), c));
    } else if (r === "-")
      if (i.length === 1) {
        const c = i.pop();
        i.push(K("*", c, -1));
      } else {
        const c = i.pop();
        i.push(K("-", i.pop(), c));
      }
    else if (r === "*")
      i.push(K("*", i.pop(), i.pop()));
    else if (r === "/") {
      const c = i.pop();
      i.push(K("/", i.pop(), c));
    } else if (o === "=" || o === ">" || o === "<") {
      let c = i.pop();
      Number.isNaN(c) || (c = Number(c));
      let a = i.pop();
      Number.isNaN(a) || (a = Number(a));
      let d = !1;
      o === "=" ? d = a === c : r === ">" ? d = a > c : r === ">=" ? d = a >= c : r === "<" ? d = a < c : r === "<=" && (d = a <= c), i.push(d);
    } else if (Array.isArray(r)) {
      const [c, a] = r, d = [];
      for (let h = 0; h < a; h += 1)
        d.push(i.pop());
      i.push(t[c].render(d.reverse()));
    } else {
      if (s.includes(r))
        return 0;
      (o >= "a" && o <= "z" || o >= "A" && o <= "Z") && s.push(r), i.push(Qs(r, e)), s.pop();
    }
  }
  return i[0];
}, Le = (l, t, e, s = []) => {
  if (l[0] === "=") {
    const i = Js(l.substring(1));
    return i.length <= 0 ? l : ti(
      i,
      t,
      (n, r) => Le(e(n, r), t, e, s),
      s
    );
  }
  return l;
}, ei = {
  render: Le
}, Zt = [
  {
    key: "SUM",
    title: S("formula.sum"),
    render: (l) => l.reduce((t, e) => K("+", t, e), 0)
  },
  {
    key: "AVERAGE",
    title: S("formula.average"),
    render: (l) => l.reduce((t, e) => Number(t) + Number(e), 0) / l.length
  },
  {
    key: "MAX",
    title: S("formula.max"),
    render: (l) => Math.max(...l.map((t) => Number(t)))
  },
  {
    key: "MIN",
    title: S("formula.min"),
    render: (l) => Math.min(...l.map((t) => Number(t)))
  },
  {
    key: "IF",
    title: S("formula._if"),
    render: ([l, t, e]) => l ? t : e
  },
  {
    key: "AND",
    title: S("formula.and"),
    render: (l) => l.every((t) => t)
  },
  {
    key: "OR",
    title: S("formula.or"),
    render: (l) => l.some((t) => t)
  },
  {
    key: "CONCAT",
    title: S("formula.concat"),
    render: (l) => l.join("")
  }
  /* support:  1 + A1 + B2 * 3
  {
    key: 'DIVIDE',
    title: tf('formula.divide'),
    render: ary => ary.reduce((a, b) => Number(a) / Number(b)),
  },
  {
    key: 'PRODUCT',
    title: tf('formula.product'),
    render: ary => ary.reduce((a, b) => Number(a) * Number(b),1),
  },
  {
    key: 'SUBTRACT',
    title: tf('formula.subtract'),
    render: ary => ary.reduce((a, b) => Number(a) - Number(b)),
  },
  */
], si = Zt, qe = {};
Zt.forEach((l) => {
  qe[l.key] = l;
});
const lt = (l) => l, bt = (l) => {
  if (/^(-?\d*.?\d*)$/.test(l)) {
    const t = Number(l).toFixed(2).toString(), [e, ...s] = t.split("\\.");
    return [e.replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1,"), ...s];
  }
  return l;
}, at = [
  {
    key: "normal",
    title: S("format.normal"),
    type: "string",
    render: lt
  },
  {
    key: "text",
    title: S("format.text"),
    type: "string",
    render: lt
  },
  {
    key: "number",
    title: S("format.number"),
    type: "number",
    label: "1,000.12",
    render: bt
  },
  {
    key: "percent",
    title: S("format.percent"),
    type: "number",
    label: "10.12%",
    render: (l) => `${l}%`
  },
  {
    key: "rmb",
    title: S("format.rmb"),
    type: "number",
    label: "￥10.00",
    render: (l) => `￥${bt(l)}`
  },
  {
    key: "usd",
    title: S("format.usd"),
    type: "number",
    label: "$10.00",
    render: (l) => `$${bt(l)}`
  },
  {
    key: "eur",
    title: S("format.eur"),
    type: "number",
    label: "€10.00",
    render: (l) => `€${bt(l)}`
  },
  {
    key: "date",
    title: S("format.date"),
    type: "date",
    label: "26/09/2008",
    render: lt
  },
  {
    key: "time",
    title: S("format.time"),
    type: "date",
    label: "15:59:00",
    render: lt
  },
  {
    key: "datetime",
    title: S("format.datetime"),
    type: "date",
    label: "26/09/2008 15:59:00",
    render: lt
  },
  {
    key: "duration",
    title: S("format.duration"),
    type: "date",
    label: "24:01:00",
    render: lt
  }
], Ue = {};
at.forEach((l) => {
  Ue[l.key] = l;
});
const ii = 5, li = { fillStyle: "#f4f5f8" }, ni = {
  fillStyle: "#fff",
  lineWidth: Xt,
  strokeStyle: "#e6e6e6"
};
function ri() {
  return {
    textAlign: "center",
    textBaseline: "middle",
    font: `500 ${E(12)}px Source Sans Pro`,
    fillStyle: "#585757",
    lineWidth: Xt(),
    strokeStyle: "#e6e6e6"
  };
}
function je(l, t, e, s = 0) {
  const {
    left: i,
    top: n,
    width: r,
    height: o
  } = l.cellRect(t, e);
  return new Ks(i, n + s, r, o, ii);
}
function Tt(l, t, e, s, i = 0) {
  const { sortedRowMap: n, rows: r, cols: o } = t;
  if (r.isHide(e) || o.isHide(s)) return;
  let c = e;
  n.has(e) && (c = n.get(e));
  const a = t.getCell(c, s);
  if (a === null) return;
  let d = !1;
  "editable" in a && a.editable === !1 && (d = !0);
  const h = t.getCellStyleOrDefault(c, s), f = je(t, e, s, i);
  f.bgcolor = h.bgcolor, h.border !== void 0 && (f.setBorders(h.border), l.strokeBorders(f)), l.rect(f, () => {
    let g = "";
    t.settings.evalPaused ? g = a.text || "" : g = ei.render(a.text || "", qe, (v, y) => t.getCellTextOrDefault(y, v)), h.format && (g = Ue[h.format].render(g));
    const p = Object.assign({}, h.font);
    p.size = Gs(p.size), l.text(g, f, {
      align: h.align,
      valign: h.valign,
      font: p,
      color: h.color,
      strike: h.strike,
      underline: h.underline
    }, h.textwrap), t.validations.getError(e, s) && l.error(f), d && l.frozen(f);
  });
}
function oi(l) {
  const { data: t, draw: e } = this;
  if (l) {
    const { autoFilter: s } = t;
    if (!s.active()) return;
    const i = s.hrange();
    l.intersects(i) && i.each((n, r) => {
      const o = je(t, n, r);
      e.dropdown(o);
    });
  }
}
function xt(l, t, e, s, i) {
  const { draw: n, data: r } = this;
  n.save(), n.translate(t, e).translate(s, i);
  const { exceptRowSet: o } = r, c = (h) => {
    const f = o.has(h);
    if (f) {
      const g = r.rows.getHeight(h);
      n.translate(0, -g);
    }
    return !f;
  }, a = r.exceptRowTotalHeight(l.sri, l.eri);
  n.save(), n.translate(0, -a), l.each((h, f) => {
    Tt(n, r, h, f);
  }, (h) => c(h)), n.restore();
  const d = /* @__PURE__ */ new Set();
  n.save(), n.translate(0, -a), r.eachMergesInView(l, ({ sri: h, sci: f, eri: g }) => {
    if (!o.has(h))
      Tt(n, r, h, f);
    else if (!d.has(h)) {
      d.add(h);
      const p = r.rows.sumHeight(h, g + 1);
      n.translate(0, -p);
    }
  }), n.restore(), oi.call(this, l), n.restore();
}
function xe(l, t, e, s) {
  const { draw: i } = this;
  i.save(), i.attr({ fillStyle: "rgba(75, 137, 255, 0.08)" }).fillRect(l, t, e, s), i.restore();
}
function vt(l, t, e, s, i, n) {
  const { draw: r, data: o } = this, c = t.h, a = t.w, d = n + s, h = i + e;
  r.save(), r.attr(li), (l === "all" || l === "left") && r.fillRect(0, d, e, c), (l === "all" || l === "top") && r.fillRect(h, 0, a, s);
  const {
    sri: f,
    sci: g,
    eri: p,
    eci: w
  } = o.selector.range;
  r.attr(ri()), (l === "all" || l === "left") && (o.rowEach(t.sri, t.eri, (v, y, C) => {
    const k = d + y, b = v;
    r.line([0, k], [e, k]), f <= b && b < p + 1 && xe.call(this, 0, k, e, C), r.fillText(b + 1, e / 2, k + C / 2), v > 0 && o.rows.isHide(v - 1) && (r.save(), r.attr({ strokeStyle: "#c6c6c6" }), r.line([5, k + 5], [e - 5, k + 5]), r.restore());
  }), r.line([0, c + d], [e, c + d]), r.line([e, d], [e, c + d])), (l === "all" || l === "top") && (o.colEach(t.sci, t.eci, (v, y, C) => {
    const k = h + y, b = v;
    r.line([k, 0], [k, s]), g <= b && b < w + 1 && xe.call(this, k, 0, C, s), r.fillText(Ie(b), k + C / 2, s / 2), v > 0 && o.cols.isHide(v - 1) && (r.save(), r.attr({ strokeStyle: "#c6c6c6" }), r.line([k + 5, 5], [k + 5, s - 5]), r.restore());
  }), r.line([a + h, 0], [a + h, s]), r.line([0, s], [a + h, s])), r.restore();
}
function ci(l, t) {
  const { draw: e } = this;
  e.save(), e.attr({ fillStyle: "#f4f5f8" }).fillRect(0, 0, l, t), e.restore();
}
function yt({
  sri: l,
  sci: t,
  eri: e,
  eci: s,
  w: i,
  h: n
}, r, o, c, a) {
  const { draw: d, data: h } = this, { settings: f } = h;
  if (d.save(), d.attr(ni).translate(r + c, o + a), !f.showGrid) {
    d.restore();
    return;
  }
  h.rowEach(l, e, (g, p, w) => {
    g !== l && d.line([0, p], [i, p]), g === e && d.line([0, p + w], [i, p + w]);
  }), h.colEach(t, s, (g, p, w) => {
    g !== t && d.line([p, 0], [p, n]), g === s && d.line([p + w, 0], [p + w, n]);
  }), d.restore();
}
function ai(l, t, e, s) {
  const { draw: i, data: n } = this, r = n.viewWidth() - l, o = n.viewHeight() - t;
  i.save().translate(l, t).attr({ strokeStyle: "rgba(75, 137, 255, .6)" }), i.line([0, s], [r, s]), i.line([e, 0], [e, o]), i.restore();
}
class hi {
  constructor(t, e) {
    this.el = t, this.draw = new _e(t, e.viewWidth(), e.viewHeight()), this.data = e;
  }
  resetData(t) {
    this.data = t, this.render();
  }
  render() {
    const { data: t } = this, { rows: e, cols: s } = t, i = s.indexWidth, n = e.height;
    this.draw.resize(t.viewWidth(), t.viewHeight()), this.clear();
    const r = t.viewRange(), o = t.freezeTotalWidth(), c = t.freezeTotalHeight(), { x: a, y: d } = t.scroll;
    yt.call(this, r, i, n, o, c), xt.call(this, r, i, n, -a, -d), vt.call(this, "all", r, i, n, o, c), ci.call(this, i, n);
    const [h, f] = t.freeze;
    if (h > 0 || f > 0) {
      if (h > 0) {
        const p = r.clone();
        p.sri = 0, p.eri = h - 1, p.h = c, yt.call(this, p, i, n, o, 0), xt.call(this, p, i, n, -a, 0), vt.call(this, "top", p, i, n, o, 0);
      }
      if (f > 0) {
        const p = r.clone();
        p.sci = 0, p.eci = f - 1, p.w = o, yt.call(this, p, i, n, 0, c), vt.call(this, "left", p, i, n, 0, c), xt.call(this, p, i, n, 0, -d);
      }
      const g = t.freezeViewRange();
      yt.call(this, g, i, n, 0, 0), vt.call(this, "all", g, i, n, 0, 0), xt.call(this, g, i, n, 0, 0), ai.call(this, i, n, o, c);
    }
  }
  clear() {
    this.draw.clear();
  }
}
const kt = [
  ["A3", 11.69, 16.54],
  ["A4", 8.27, 11.69],
  ["A5", 5.83, 8.27],
  ["B4", 9.84, 13.9],
  ["B5", 6.93, 9.84]
], _t = ["landscape", "portrait"];
function Ot(l) {
  return parseInt(96 * l, 10);
}
function ve(l) {
  l === "cancel" ? this.el.hide() : this.toPrint();
}
function di(l) {
  const { paper: t } = this, { value: e } = l.target, s = kt[e];
  t.w = Ot(s[1]), t.h = Ot(s[2]), this.preview();
}
function fi(l) {
  const { paper: t } = this, { value: e } = l.target, s = _t[e];
  t.orientation = s, this.preview();
}
let ui = class {
  constructor(t) {
    this.paper = {
      w: Ot(kt[0][1]),
      h: Ot(kt[0][2]),
      padding: 50,
      orientation: _t[0],
      get width() {
        return this.orientation === "landscape" ? this.h : this.w;
      },
      get height() {
        return this.orientation === "landscape" ? this.w : this.h;
      }
    }, this.data = t, this.el = u("div", `${m}-print`).children(
      u("div", `${m}-print-bar`).children(
        u("div", "-title").child("Print settings"),
        u("div", "-right").children(
          u("div", `${m}-buttons`).children(
            new G("cancel").on("click", ve.bind(this, "cancel")),
            new G("next", "primary").on("click", ve.bind(this, "next"))
          )
        )
      ),
      u("div", `${m}-print-content`).children(
        this.contentEl = u("div", "-content"),
        u("div", "-sider").child(
          u("form", "").children(
            u("fieldset", "").children(
              u("label", "").child(`${I("print.size")}`),
              u("select", "").children(
                ...kt.map((e, s) => u("option", "").attr("value", s).child(`${e[0]} ( ${e[1]}''x${e[2]}'' )`))
              ).on("change", di.bind(this))
            ),
            u("fieldset", "").children(
              u("label", "").child(`${I("print.orientation")}`),
              u("select", "").children(
                ..._t.map((e, s) => u("option", "").attr("value", s).child(`${I("print.orientations")[s]}`))
              ).on("change", fi.bind(this))
            )
          )
        )
      )
    ).hide();
  }
  resetData(t) {
    this.data = t;
  }
  preview() {
    const { data: t, paper: e } = this, { width: s, height: i, padding: n } = e, r = s - n * 2, o = i - n * 2, c = t.contentRange(), a = parseInt(c.h / o, 10) + 1, d = r / c.w;
    let h = n;
    const f = n;
    d > 1 && (h += (r - c.w) / 2);
    let g = 0, p = 0;
    this.contentEl.html(""), this.canvases = [];
    const w = {
      sri: 0,
      sci: 0,
      eri: 0,
      eci: 0
    };
    for (let v = 0; v < a; v += 1) {
      let y = 0, C = 0;
      const k = u("div", `${m}-canvas-card`), b = u("canvas", `${m}-canvas`);
      this.canvases.push(b.el);
      const x = new _e(b.el, s, i);
      for (x.save(), x.translate(h, f), d < 1 && x.scale(d, d); g <= c.eri; g += 1) {
        const T = t.rows.getHeight(g);
        if (y += T, y < o)
          for (let D = 0; D <= c.eci; D += 1)
            Tt(x, t, g, D, p), w.eci = D;
        else {
          C = -(y - T);
          break;
        }
      }
      w.eri = g, x.restore(), x.save(), x.translate(h, f), d < 1 && x.scale(d, d);
      const $ = p;
      t.eachMergesInView(w, ({ sri: T, sci: D }) => {
        Tt(x, t, T, D, $);
      }), x.restore(), w.sri = w.eri, w.sci = w.eci, p += C, this.contentEl.child(u("div", `${m}-canvas-card-wraper`).child(k.child(b)));
    }
    this.el.show();
  }
  toPrint() {
    this.el.hide();
    const { paper: t } = this, e = u("iframe", "").hide(), { el: s } = e;
    window.document.body.appendChild(s);
    const { contentWindow: i } = s, n = i.document, r = document.createElement("style");
    r.innerHTML = `
      @page { size: ${t.width}px ${t.height}px; };
      canvas {
        page-break-before: auto;        
        page-break-after: always;
        image-rendering: pixelated;
      };
    `, n.head.appendChild(r), this.canvases.forEach((o) => {
      const c = o.cloneNode(!1);
      c.getContext("2d").drawImage(o, 0, 0), n.body.appendChild(c);
    }), i.print();
  }
};
const gi = [
  { key: "copy", title: S("contextmenu.copy"), label: "Ctrl+C" },
  { key: "cut", title: S("contextmenu.cut"), label: "Ctrl+X" },
  { key: "paste", title: S("contextmenu.paste"), label: "Ctrl+V" },
  { key: "paste-value", title: S("contextmenu.pasteValue"), label: "Ctrl+Shift+V" },
  { key: "paste-format", title: S("contextmenu.pasteFormat"), label: "Ctrl+Alt+V" },
  { key: "divider" },
  { key: "insert-row", title: S("contextmenu.insertRow") },
  { key: "insert-column", title: S("contextmenu.insertColumn") },
  { key: "divider" },
  { key: "delete-row", title: S("contextmenu.deleteRow") },
  { key: "delete-column", title: S("contextmenu.deleteColumn") },
  { key: "delete-cell-text", title: S("contextmenu.deleteCellText") },
  { key: "hide", title: S("contextmenu.hide") },
  { key: "divider" },
  { key: "validation", title: S("contextmenu.validation") },
  { key: "divider" },
  { key: "cell-printable", title: S("contextmenu.cellprintable") },
  { key: "cell-non-printable", title: S("contextmenu.cellnonprintable") },
  { key: "divider" },
  { key: "cell-editable", title: S("contextmenu.celleditable") },
  { key: "cell-non-editable", title: S("contextmenu.cellnoneditable") }
];
function pi(l) {
  return l.key === "divider" ? u("div", `${m}-item divider`) : u("div", `${m}-item`).on("click", () => {
    this.itemClick(l.key), this.hide();
  }).children(
    l.title(),
    u("div", "label").child(l.label || "")
  );
}
function mi() {
  return gi.map((l) => pi.call(this, l));
}
let wi = class {
  constructor(t, e = !1) {
    this.menuItems = mi.call(this), this.el = u("div", `${m}-contextmenu`).children(...this.menuItems).hide(), this.viewFn = t, this.itemClick = () => {
    }, this.isHide = e, this.setMode("range");
  }
  // row-col: the whole rows or the whole cols
  // range: select range
  setMode(t) {
    const e = this.menuItems[12];
    t === "row-col" ? e.show() : e.hide();
  }
  hide() {
    const { el: t } = this;
    t.hide(), ot(t);
  }
  setPosition(t, e) {
    if (this.isHide) return;
    const { el: s } = this, { width: i } = s.show().offset(), n = this.viewFn(), r = n.height / 2;
    let o = t;
    n.width - t <= i && (o -= i), s.css("left", `${o}px`), e > r ? s.css("bottom", `${n.height - e}px`).css("max-height", `${e}px`).css("top", "auto") : s.css("top", `${e}px`).css("max-height", `${n.height - e}px`).css("bottom", "auto"), ft(s);
  }
};
function bi(l, t) {
  if (t.classList.contains("active"))
    return;
  const {
    left: e,
    top: s,
    width: i,
    height: n
  } = t.getBoundingClientRect(), r = u("div", `${m}-tooltip`).html(l).show();
  document.body.appendChild(r.el);
  const o = r.box();
  r.css("left", `${e + i / 2 - o.width / 2}px`).css("top", `${s + n + 2}px`), H(t, "mouseleave", () => {
    document.body.contains(r.el) && document.body.removeChild(r.el);
  }), H(t, "click", () => {
    document.body.contains(r.el) && document.body.removeChild(r.el);
  });
}
class Kt {
  // tooltip
  // tag: the subclass type
  // shortcut: shortcut key
  constructor(t, e, s) {
    this.tip = I(`toolbar.${t.replace(/-[a-z]/g, (i) => i[1].toUpperCase())}`), e && (this.tip += ` (${e})`), this.tag = t, this.shortcut = e, this.value = s, this.el = this.element(), this.change = () => {
    };
  }
  element() {
    const { tip: t } = this;
    return u("div", `${m}-toolbar-btn`).on("mouseenter", (e) => {
      bi(t, e.target);
    }).attr("data-tooltip", t);
  }
  setState() {
  }
}
class B extends Kt {
  dropdown() {
  }
  getValue(t) {
    return t;
  }
  element() {
    const { tag: t } = this;
    return this.dd = this.dropdown(), this.dd.change = (e) => this.change(t, this.getValue(e)), super.element().child(
      this.dd
    );
  }
  setState(t) {
    t && (this.value = t, this.dd.setTitle(t));
  }
}
class _ extends Q {
  constructor(t, e, s, i, ...n) {
    super("div", `${m}-dropdown ${i}`), this.title = t, this.change = () => {
    }, this.headerClick = () => {
    }, typeof t == "string" ? this.title = u("div", `${m}-dropdown-title`).child(t) : s && this.title.addClass("arrow-left"), this.contentEl = u("div", `${m}-dropdown-content`).css("width", e).hide(), this.setContentChildren(...n), this.headerEl = u("div", `${m}-dropdown-header`), this.headerEl.on("click", () => {
      this.contentEl.css("display") !== "block" ? this.show() : this.hide();
    }).children(
      this.title,
      s ? u("div", `${m}-icon arrow-right`).child(
        u("div", `${m}-icon-img arrow-down`)
      ) : ""
    ), this.children(this.headerEl, this.contentEl);
  }
  setContentChildren(...t) {
    this.contentEl.html(""), t.length > 0 && this.contentEl.children(...t);
  }
  setTitle(t) {
    this.title.html(t), this.hide();
  }
  show() {
    const { contentEl: t } = this;
    t.show(), this.parent().active(), ft(this.parent(), () => {
      this.hide();
    });
  }
  hide() {
    this.parent().active(!1), this.contentEl.hide(), ot(this.parent());
  }
}
function xi(l) {
  return u("div", `${m}-item`).child(new A(l));
}
class Ye extends _ {
  constructor(t, e) {
    const s = new A(`align-${e}`), i = t.map((n) => xi(`align-${n}`).on("click", () => {
      this.setTitle(n), this.change(n);
    }));
    super(s, "auto", !0, "bottom-left", ...i);
  }
  setTitle(t) {
    this.title.setName(`align-${t}`), this.hide();
  }
}
class vi extends B {
  constructor(t) {
    super("align", "", t);
  }
  dropdown() {
    const { value: t } = this;
    return new Ye(["left", "center", "right"], t);
  }
}
class yi extends B {
  constructor(t) {
    super("valign", "", t);
  }
  dropdown() {
    const { value: t } = this;
    return new Ye(["top", "middle", "bottom"], t);
  }
}
class q extends Kt {
  element() {
    const { tag: t } = this;
    return super.element().child(new A(t)).on("click", () => this.click());
  }
  click() {
    this.change(this.tag, this.toggle());
  }
  setState(t) {
    this.el.active(t);
  }
  toggle() {
    return this.el.toggle();
  }
  active() {
    return this.el.hasClass("active");
  }
}
class ki extends q {
  constructor() {
    super("autofilter");
  }
  setState() {
  }
}
class Ci extends q {
  constructor() {
    super("font-bold", "Ctrl+B");
  }
}
class Ei extends q {
  constructor() {
    super("font-italic", "Ctrl+I");
  }
}
class Si extends q {
  constructor() {
    super("strike", "Ctrl+U");
  }
}
class $i extends q {
  constructor() {
    super("underline", "Ctrl+U");
  }
}
const Di = ["#ffffff", "#000100", "#e7e5e6", "#445569", "#5b9cd6", "#ed7d31", "#a5a5a5", "#ffc001", "#4371c6", "#71ae47"], Ti = [
  ["#f2f2f2", "#7f7f7f", "#d0cecf", "#d5dce4", "#deeaf6", "#fce5d5", "#ededed", "#fff2cd", "#d9e2f3", "#e3efd9"],
  ["#d8d8d8", "#595959", "#afabac", "#adb8ca", "#bdd7ee", "#f7ccac", "#dbdbdb", "#ffe59a", "#b3c6e7", "#c5e0b3"],
  ["#bfbfbf", "#3f3f3f", "#756f6f", "#8596b0", "#9cc2e6", "#f4b184", "#c9c9c9", "#fed964", "#8eaada", "#a7d08c"],
  ["#a5a5a5", "#262626", "#3a3839", "#333f4f", "#2e75b5", "#c45a10", "#7b7b7b", "#bf8e01", "#2f5596", "#538136"],
  ["#7f7f7f", "#0c0c0c", "#171516", "#222a35", "#1f4e7a", "#843c0a", "#525252", "#7e6000", "#203864", "#365624"]
], Oi = ["#c00000", "#fe0000", "#fdc101", "#ffff01", "#93d051", "#00b04e", "#01b0f1", "#0170c1", "#012060", "#7030a0"];
function Rt(l) {
  return u("td", "").child(
    u("div", `${m}-color-palette-cell`).on("click.stop", () => this.change(l)).css("background-color", l)
  );
}
class Ii {
  constructor() {
    this.el = u("div", `${m}-color-palette`), this.change = () => {
    };
    const t = u("table", "").children(
      u("tbody", "").children(
        u("tr", `${m}-theme-color-placeholders`).children(
          ...Di.map((e) => Rt.call(this, e))
        ),
        ...Ti.map((e) => u("tr", `${m}-theme-colors`).children(
          ...e.map((s) => Rt.call(this, s))
        )),
        u("tr", `${m}-standard-colors`).children(
          ...Oi.map((e) => Rt.call(this, e))
        )
      )
    );
    this.el.child(t);
  }
}
class Gt extends _ {
  constructor(t, e) {
    const s = new A(t).css("height", "16px").css("border-bottom", `3px solid ${e}`), i = new Ii();
    i.change = (n) => {
      this.setTitle(n), this.change(n);
    }, super(s, "auto", !1, "bottom-left", i.el);
  }
  setTitle(t) {
    this.title.css("border-color", t), this.hide();
  }
}
const Ai = [
  ["thin", '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="1" style="user-select: none;"><line x1="0" y1="0.5" x2="50" y2="0.5" stroke-width="1" stroke="black" style="user-select: none;"></line></svg>'],
  ["medium", '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="2" style="user-select: none;"><line x1="0" y1="1.0" x2="50" y2="1.0" stroke-width="2" stroke="black" style="user-select: none;"></line></svg>'],
  ["thick", '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="3" style="user-select: none;"><line x1="0" y1="1.5" x2="50" y2="1.5" stroke-width="3" stroke="black" style="user-select: none;"></line></svg>'],
  ["dashed", '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="1" style="user-select: none;"><line x1="0" y1="0.5" x2="50" y2="0.5" stroke-width="1" stroke="black" stroke-dasharray="2" style="user-select: none;"></line></svg>'],
  ["dotted", '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="1" style="user-select: none;"><line x1="0" y1="0.5" x2="50" y2="0.5" stroke-width="1" stroke="black" stroke-dasharray="1" style="user-select: none;"></line></svg>']
  // ['double', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="3" style="user-select: none;"><line x1="0" y1="0.5" x2="50" y2="0.5" stroke-width="1" stroke="black" style="user-select: none;"></line><line x1="0" y1="2.5" x2="50" y2="2.5" stroke-width="1" stroke="black" style="user-select: none;"></line></svg>'],
];
class Ri extends _ {
  constructor(t) {
    const e = new A("line-type");
    let s = 0;
    const i = Ai.map((n, r) => u("div", `${m}-item state ${t === n[0] ? "checked" : ""}`).on("click", () => {
      i[s].toggle("checked"), i[r].toggle("checked"), s = r, this.hide(), this.change(n);
    }).child(
      u("div", `${m}-line-type`).html(n[1])
    ));
    super(e, "auto", !1, "bottom-left", ...i);
  }
}
function ye(...l) {
  return u("table", "").child(
    u("tbody", "").children(...l)
  );
}
function ke(l) {
  return u("td", "").child(
    u("div", `${m}-border-palette-cell`).child(
      new A(`border-${l}`)
    ).on("click", () => {
      this.mode = l;
      const { mode: t, style: e, color: s } = this;
      this.change({ mode: t, style: e, color: s });
    })
  );
}
class zi {
  constructor() {
    this.color = "#000", this.style = "thin", this.mode = "all", this.change = () => {
    }, this.ddColor = new Gt("line-color", this.color), this.ddColor.change = (e) => {
      this.color = e;
    }, this.ddType = new Ri(this.style), this.ddType.change = ([e]) => {
      this.style = e;
    }, this.el = u("div", `${m}-border-palette`);
    const t = ye(
      u("tr", "").children(
        u("td", `${m}-border-palette-left`).child(
          ye(
            u("tr", "").children(
              ...["all", "inside", "horizontal", "vertical", "outside"].map((e) => ke.call(this, e))
            ),
            u("tr", "").children(
              ...["left", "top", "right", "bottom", "none"].map((e) => ke.call(this, e))
            )
          )
        ),
        u("td", `${m}-border-palette-right`).children(
          u("div", `${m}-toolbar-btn`).child(this.ddColor.el),
          u("div", `${m}-toolbar-btn`).child(this.ddType.el)
        )
      )
    );
    this.el.child(t);
  }
}
class Fi extends _ {
  constructor() {
    const t = new A("border-all"), e = new zi();
    e.change = (s) => {
      this.change(s), this.hide();
    }, super(t, "auto", !1, "bottom-left", e.el);
  }
}
class Mi extends B {
  constructor() {
    super("border");
  }
  dropdown() {
    return new Fi();
  }
}
class It extends Kt {
  element() {
    return super.element().child(new A(this.tag)).on("click", () => this.change(this.tag));
  }
  setState(t) {
    this.el.disabled(t);
  }
}
class Hi extends It {
  constructor() {
    super("clearformat");
  }
}
class Ni extends q {
  constructor() {
    super("paintformat");
  }
  setState() {
  }
}
class Wi extends B {
  constructor(t) {
    super("color", void 0, t);
  }
  dropdown() {
    const { tag: t, value: e } = this;
    return new Gt(t, e);
  }
}
class Vi extends B {
  constructor(t) {
    super("bgcolor", void 0, t);
  }
  dropdown() {
    const { tag: t, value: e } = this;
    return new Gt(t, e);
  }
}
class Pi extends _ {
  constructor() {
    const t = Bt.map((e) => u("div", `${m}-item`).on("click", () => {
      this.setTitle(`${e.pt}`), this.change(e);
    }).child(`${e.pt}`));
    super("10", "60px", !0, "bottom-left", ...t);
  }
}
let Bi = class extends B {
  constructor() {
    super("font-size");
  }
  getValue(t) {
    return t.pt;
  }
  dropdown() {
    return new Pi();
  }
};
class _i extends _ {
  constructor() {
    const t = be.map((e) => u("div", `${m}-item`).on("click", () => {
      this.setTitle(e.title), this.change(e);
    }).child(e.title));
    super(be[0].title, "160px", !0, "bottom-left", ...t);
  }
}
class Li extends B {
  constructor() {
    super("font-name");
  }
  getValue(t) {
    return t.key;
  }
  dropdown() {
    return new _i();
  }
}
class qi extends _ {
  constructor() {
    let t = at.slice(0);
    t.splice(2, 0, { key: "divider" }), t.splice(8, 0, { key: "divider" }), t = t.map((e) => {
      const s = u("div", `${m}-item`);
      return e.key === "divider" ? s.addClass("divider") : (s.child(e.title()).on("click", () => {
        this.setTitle(e.title()), this.change(e);
      }), e.label && s.child(u("div", "label").html(e.label))), s;
    }), super("Normal", "220px", !0, "bottom-left", ...t);
  }
  setTitle(t) {
    for (let e = 0; e < at.length; e += 1)
      at[e].key === t && this.title.html(at[e].title());
    this.hide();
  }
}
let Ui = class extends B {
  constructor() {
    super("format");
  }
  getValue(t) {
    return t.key;
  }
  dropdown() {
    return new qi();
  }
};
class ji extends _ {
  constructor() {
    const t = Zt.map((e) => u("div", `${m}-item`).on("click", () => {
      this.hide(), this.change(e);
    }).child(e.key));
    super(new A("formula"), "180px", !0, "bottom-left", ...t);
  }
}
class Yi extends B {
  constructor() {
    super("formula");
  }
  getValue(t) {
    return t.key;
  }
  dropdown() {
    return new ji();
  }
}
class Xi extends q {
  constructor() {
    super("freeze");
  }
}
class Zi extends q {
  constructor() {
    super("merge");
  }
  setState(t, e) {
    this.el.active(t).disabled(e);
  }
}
class Ki extends It {
  constructor() {
    super("redo", "Ctrl+Y");
  }
}
class Gi extends It {
  constructor() {
    super("undo", "Ctrl+Z");
  }
}
class Ji extends It {
  constructor() {
    super("print", "Ctrl+P");
  }
}
class Qi extends q {
  constructor() {
    super("textwrap");
  }
}
let tl = class extends _ {
  constructor() {
    const t = new A("ellipsis"), e = u("div", `${m}-toolbar-more`);
    super(t, "auto", !1, "bottom-right", e), this.moreBtns = e, this.contentEl.css("max-width", "420px");
  }
};
class el extends B {
  constructor() {
    super("more"), this.el.hide();
  }
  dropdown() {
    return new tl();
  }
  show() {
    this.el.show();
  }
  hide() {
    this.el.hide();
  }
}
function nt() {
  return u("div", `${m}-toolbar-divider`);
}
function sl() {
  this.btns2 = [], this.items.forEach((l) => {
    if (Array.isArray(l))
      l.forEach(({ el: t }) => {
        const e = t.box(), { marginLeft: s, marginRight: i } = t.computedStyle();
        this.btns2.push([t, e.width + parseInt(s, 10) + parseInt(i, 10)]);
      });
    else {
      const t = l.box(), { marginLeft: e, marginRight: s } = l.computedStyle();
      this.btns2.push([l, t.width + parseInt(e, 10) + parseInt(s, 10)]);
    }
  });
}
function Ce() {
  const {
    el: l,
    btns: t,
    moreEl: e,
    btns2: s
  } = this, { moreBtns: i, contentEl: n } = e.dd;
  l.css("width", `${this.widthFn() - 60}px`);
  const r = l.box();
  let o = 160, c = 12;
  const a = [], d = [];
  s.forEach(([h, f], g) => {
    o += f, g === s.length - 1 || o < r.width ? a.push(h) : (c += f, d.push(h));
  }), t.html("").children(...a), i.html("").children(...d), n.css("width", `${c}px`), d.length > 0 ? e.show() : e.hide();
}
class il {
  constructor(t, e, s = !1) {
    this.data = t, this.change = () => {
    }, this.widthFn = e, this.isHide = s;
    const i = t.defaultStyle();
    this.items = [
      [
        this.undoEl = new Gi(),
        this.redoEl = new Ki(),
        new Ji(),
        this.paintformatEl = new Ni(),
        this.clearformatEl = new Hi()
      ],
      nt(),
      [
        this.formatEl = new Ui()
      ],
      nt(),
      [
        this.fontEl = new Li(),
        this.fontSizeEl = new Bi()
      ],
      nt(),
      [
        this.boldEl = new Ci(),
        this.italicEl = new Ei(),
        this.underlineEl = new $i(),
        this.strikeEl = new Si(),
        this.textColorEl = new Wi(i.color)
      ],
      nt(),
      [
        this.fillColorEl = new Vi(i.bgcolor),
        this.borderEl = new Mi(),
        this.mergeEl = new Zi()
      ],
      nt(),
      [
        this.alignEl = new vi(i.align),
        this.valignEl = new yi(i.valign),
        this.textwrapEl = new Qi()
      ],
      nt(),
      [
        this.freezeEl = new Xi(),
        this.autofilterEl = new ki(),
        this.formulaEl = new Yi(),
        this.moreEl = new el()
      ]
    ], this.el = u("div", `${m}-toolbar`), this.btns = u("div", `${m}-toolbar-btns`), this.items.forEach((n) => {
      Array.isArray(n) ? n.forEach((r) => {
        this.btns.child(r.el), r.change = (...o) => {
          this.change(...o);
        };
      }) : this.btns.child(n.el);
    }), this.el.child(this.btns), s ? this.el.hide() : (this.reset(), setTimeout(() => {
      sl.call(this), Ce.call(this);
    }, 0), H(window, "resize", () => {
      Ce.call(this);
    }));
  }
  paintformatActive() {
    return this.paintformatEl.active();
  }
  paintformatToggle() {
    this.paintformatEl.toggle();
  }
  trigger(t) {
    this[`${t}El`].click();
  }
  resetData(t) {
    this.data = t, this.reset();
  }
  reset() {
    if (this.isHide) return;
    const { data: t } = this, e = t.getSelectedCellStyle();
    this.undoEl.setState(!t.canUndo()), this.redoEl.setState(!t.canRedo()), this.mergeEl.setState(t.canUnmerge(), !t.selector.multiple()), this.autofilterEl.setState(!t.canAutofilter());
    const { font: s, format: i } = e;
    this.formatEl.setState(i), this.fontEl.setState(s.name), this.fontSizeEl.setState(s.size), this.boldEl.setState(s.bold), this.italicEl.setState(s.italic), this.underlineEl.setState(e.underline), this.strikeEl.setState(e.strike), this.textColorEl.setState(e.color), this.fillColorEl.setState(e.bgcolor), this.alignEl.setState(e.align), this.valignEl.setState(e.valign), this.textwrapEl.setState(e.textwrap), this.freezeEl.setState(t.freezeIsActive());
  }
}
class ll {
  constructor(t, e, s = "600px") {
    this.title = t, this.el = u("div", `${m}-modal`).css("width", s).children(
      u("div", `${m}-modal-header`).children(
        new A("close").on("click.stop", () => this.hide()),
        this.title
      ),
      u("div", `${m}-modal-content`).children(...e)
    ).hide();
  }
  show() {
    this.dimmer = u("div", `${m}-dimmer active`), document.body.appendChild(this.dimmer.el);
    const { width: t, height: e } = this.el.show().box(), { clientHeight: s, clientWidth: i } = document.documentElement;
    this.el.offset({
      left: (i - t) / 2,
      top: (s - e) / 3
    }), window.xkeydownEsc = (n) => {
      n.keyCode === 27 && this.hide();
    }, H(window, "keydown", window.xkeydownEsc);
  }
  hide() {
    this.el.hide(), document.body.removeChild(this.dimmer.el), St(window, "keydown", window.xkeydownEsc), delete window.xkeydownEsc;
  }
}
class rt {
  constructor(t, e) {
    this.vchange = () => {
    }, this.el = u("div", `${m}-form-input`), this.input = u("input", "").css("width", t).on("input", (s) => this.vchange(s)).attr("placeholder", e), this.el.child(this.input);
  }
  focus() {
    setTimeout(() => {
      this.input.el.focus();
    }, 10);
  }
  hint(t) {
    this.input.attr("placeholder", t);
  }
  val(t) {
    return this.input.val(t);
  }
}
class zt {
  constructor(t, e, s, i = (r) => r, n = () => {
  }) {
    this.key = t, this.getTitle = i, this.vchange = () => {
    }, this.el = u("div", `${m}-form-select`), this.suggest = new Pe(e.map((r) => ({ key: r, title: this.getTitle(r) })), (r) => {
      this.itemClick(r.key), n(r.key), this.vchange(r.key);
    }, s, this.el), this.el.children(
      this.itemEl = u("div", "input-text").html(this.getTitle(t)),
      this.suggest.el
    ).on("click", () => this.show());
  }
  show() {
    this.suggest.search("");
  }
  itemClick(t) {
    this.key = t, this.itemEl.html(this.getTitle(t));
  }
  val(t) {
    return t !== void 0 ? (this.key = t, this.itemEl.html(this.getTitle(t)), this) : this.key;
  }
}
const nl = {
  number: /(^\d+$)|(^\d+(\.\d{0,4})?$)/,
  date: /^\d{4}-\d{1,2}-\d{1,2}$/
};
class j {
  constructor(t, e, s, i) {
    this.label = "", this.rule = e, s && (this.label = u("label", "label").css("width", `${i}px`).html(s)), this.tip = u("div", "tip").child("tip").hide(), this.input = t, this.input.vchange = () => this.validate(), this.el = u("div", `${m}-form-field`).children(this.label, t.el, this.tip);
  }
  isShow() {
    return this.el.css("display") !== "none";
  }
  show() {
    this.el.show();
  }
  hide() {
    return this.el.hide(), this;
  }
  val(t) {
    return this.input.val(t);
  }
  hint(t) {
    this.input.hint(t);
  }
  validate() {
    const {
      input: t,
      rule: e,
      tip: s,
      el: i
    } = this, n = t.val();
    return e.required && /^\s*$/.test(n) ? (s.html(I("validation.required")), i.addClass("error"), !1) : (e.type || e.pattern) && !(e.pattern || nl[e.type]).test(n) ? (s.html(I("validation.notMatch")), i.addClass("error"), !1) : (i.removeClass("error"), !0);
  }
}
const Ee = 100;
class rl extends ll {
  constructor() {
    const t = new j(
      new zt(
        "cell",
        ["cell"],
        // cell|row|column
        "100%",
        (a) => I(`dataValidation.modeType.${a}`)
      ),
      { required: !0 },
      `${I("dataValidation.range")}:`,
      Ee
    ), e = new j(
      new rt("120px", "E3 or E3:F12"),
      { required: !0, pattern: /^([A-Z]{1,2}[1-9]\d*)(:[A-Z]{1,2}[1-9]\d*)?$/ }
    ), s = new j(
      new zt(
        "list",
        ["list", "number", "date", "phone", "email"],
        "100%",
        (a) => I(`dataValidation.type.${a}`),
        (a) => this.criteriaSelected(a)
      ),
      { required: !0 },
      `${I("dataValidation.criteria")}:`,
      Ee
    ), i = new j(
      new zt(
        "be",
        ["be", "nbe", "eq", "neq", "lt", "lte", "gt", "gte"],
        "160px",
        (a) => I(`dataValidation.operator.${a}`),
        (a) => this.criteriaOperatorSelected(a)
      ),
      { required: !0 }
    ).hide(), n = new j(
      new rt("70px", "10"),
      { required: !0 }
    ).hide(), r = new j(
      new rt("70px", "100"),
      { required: !0, type: "number" }
    ).hide(), o = new j(
      new rt("120px", "a,b,c"),
      { required: !0 }
    ), c = new j(
      new rt("70px", "10"),
      { required: !0, type: "number" }
    ).hide();
    super(I("contextmenu.validation"), [
      u("div", `${m}-form-fields`).children(
        t.el,
        e.el
      ),
      u("div", `${m}-form-fields`).children(
        s.el,
        i.el,
        n.el,
        r.el,
        c.el,
        o.el
      ),
      u("div", `${m}-buttons`).children(
        new G("cancel").on("click", () => this.btnClick("cancel")),
        new G("remove").on("click", () => this.btnClick("remove")),
        new G("save", "primary").on("click", () => this.btnClick("save"))
      )
    ]), this.mf = t, this.rf = e, this.cf = s, this.of = i, this.minvf = n, this.maxvf = r, this.vf = c, this.svf = o, this.change = () => {
    };
  }
  showVf(t) {
    const e = t === "date" ? "2018-11-12" : "10", { vf: s } = this;
    s.input.hint(e), s.show();
  }
  criteriaSelected(t) {
    const {
      of: e,
      minvf: s,
      maxvf: i,
      vf: n,
      svf: r
    } = this;
    t === "date" || t === "number" ? (e.show(), s.rule.type = t, i.rule.type = t, t === "date" ? (s.hint("2018-11-12"), i.hint("2019-11-12")) : (s.hint("10"), i.hint("100")), s.show(), i.show(), n.hide(), r.hide()) : (t === "list" ? r.show() : r.hide(), n.hide(), e.hide(), s.hide(), i.hide());
  }
  criteriaOperatorSelected(t) {
    if (!t) return;
    const {
      minvf: e,
      maxvf: s,
      vf: i
    } = this;
    if (t === "be" || t === "nbe")
      e.show(), s.show(), i.hide();
    else {
      const n = this.cf.val();
      i.rule.type = n, n === "date" ? i.hint("2018-11-12") : i.hint("10"), i.show(), e.hide(), s.hide();
    }
  }
  btnClick(t) {
    if (t === "cancel")
      this.hide();
    else if (t === "remove")
      this.change("remove"), this.hide();
    else if (t === "save") {
      const e = ["mf", "rf", "cf", "of", "svf", "vf", "minvf", "maxvf"];
      for (let c = 0; c < e.length; c += 1) {
        const a = this[e[c]];
        if (a.isShow() && !a.validate())
          return;
      }
      const s = this.mf.val(), i = this.rf.val(), n = this.cf.val(), r = this.of.val();
      let o = this.svf.val();
      (n === "number" || n === "date") && (r === "be" || r === "nbe" ? o = [this.minvf.val(), this.maxvf.val()] : o = this.vf.val()), this.change(
        "save",
        s,
        i,
        {
          type: n,
          operator: r,
          required: !1,
          value: o
        }
      ), this.hide();
    }
  }
  // validation: { mode, ref, validator }
  setValue(t) {
    if (t) {
      const {
        mf: e,
        rf: s,
        cf: i,
        of: n,
        svf: r,
        vf: o,
        minvf: c,
        maxvf: a
      } = this, {
        mode: d,
        ref: h,
        validator: f
      } = t, {
        type: g,
        operator: p,
        value: w
      } = f || { type: "list" };
      e.val(d || "cell"), s.val(h), i.val(g), n.val(p), Array.isArray(w) ? (c.val(w[0]), a.val(w[1])) : (r.val(w || ""), o.val(w || "")), this.criteriaSelected(g), this.criteriaOperatorSelected(p);
    }
    this.show();
  }
}
function Xe(l) {
  return u("div", `${m}-item ${l}`);
}
function Se(l) {
  return Xe("state").child(I(`sort.${l}`)).on("click.stop", () => this.itemClick(l));
}
function ol(l) {
  const { filterbEl: t, filterValues: e } = this;
  t.html(""), Object.keys(l).forEach((i, n) => {
    const r = l[i], o = e.includes(i) ? "checked" : "";
    t.child(u("div", `${m}-item state ${o}`).on("click.stop", () => this.filterClick(n, i)).children(i === "" ? I("filter.empty") : i, u("div", "label").html(`(${r})`)));
  });
}
function $e() {
  const { filterhEl: l, filterValues: t, values: e } = this;
  l.html(`${t.length} / ${e.length}`), l.checked(t.length === e.length);
}
class cl {
  constructor() {
    this.filterbEl = u("div", `${m}-body`), this.filterhEl = u("div", `${m}-header state`).on("click.stop", () => this.filterClick(0, "all")), this.el = u("div", `${m}-sort-filter`).children(
      this.sortAscEl = Se.call(this, "asc"),
      this.sortDescEl = Se.call(this, "desc"),
      Xe("divider"),
      u("div", `${m}-filter`).children(
        this.filterhEl,
        this.filterbEl
      ),
      u("div", `${m}-buttons`).children(
        new G("cancel").on("click", () => this.btnClick("cancel")),
        new G("ok", "primary").on("click", () => this.btnClick("ok"))
      )
    ).hide(), this.ci = null, this.sortDesc = null, this.values = null, this.filterValues = [];
  }
  btnClick(t) {
    if (t === "ok") {
      const { ci: e, sort: s, filterValues: i } = this;
      this.ok && this.ok(e, s, "in", i);
    }
    this.hide();
  }
  itemClick(t) {
    this.sort = t;
    const { sortAscEl: e, sortDescEl: s } = this;
    e.checked(t === "asc"), s.checked(t === "desc");
  }
  filterClick(t, e) {
    const { filterbEl: s, filterValues: i, values: n } = this, r = s.children();
    e === "all" ? r.length === i.length ? (this.filterValues = [], r.forEach((o) => u(o).checked(!1))) : (this.filterValues = Array.from(n), r.forEach((o) => u(o).checked(!0))) : u(r[t]).toggle("checked") ? i.push(e) : i.splice(i.findIndex((c) => c === e), 1), $e.call(this);
  }
  // v: autoFilter
  // items: {value: cnt}
  // sort { ci, order }
  set(t, e, s, i) {
    this.ci = t;
    const { sortAscEl: n, sortDescEl: r } = this;
    i !== null ? (this.sort = i.order, n.checked(i.asc()), r.checked(i.desc())) : (this.sortDesc = null, n.checked(!1), r.checked(!1)), this.values = Object.keys(e), this.filterValues = s ? Array.from(s.value) : Object.keys(e), ol.call(this, e, s), $e.call(this);
  }
  setOffset(t) {
    this.el.offset(t).show();
    let e = 1;
    ft(this.el, () => {
      e <= 0 && this.hide(), e -= 1;
    });
  }
  show() {
    this.el.show();
  }
  hide() {
    this.el.hide(), ot(this.el);
  }
}
function Ze(l, t) {
  const e = u("div", `${m}-toast`), s = u("div", `${m}-dimmer active`), i = () => {
    document.body.removeChild(e.el), document.body.removeChild(s.el);
  };
  e.children(
    u("div", `${m}-toast-header`).children(
      new A("close").on("click.stop", () => i()),
      l
    ),
    u("div", `${m}-toast-content`).html(t)
  ), document.body.appendChild(e.el), document.body.appendChild(s.el);
  const { width: n, height: r } = e.box(), { clientHeight: o, clientWidth: c } = document.documentElement;
  e.offset({
    left: (c - n) / 2,
    top: (o - r) / 3
  });
}
function Ft(l, t) {
  let e;
  return (...s) => {
    const i = this, n = s;
    e || (e = setTimeout(() => {
      e = null, l.apply(i, n);
    }, t));
  };
}
function al() {
  const {
    data: l,
    verticalScrollbar: t,
    horizontalScrollbar: e
  } = this, {
    l: s,
    t: i,
    left: n,
    top: r,
    width: o,
    height: c
  } = l.getSelectedRect(), a = this.getTableOffset();
  if (Math.abs(n) + o > a.width)
    e.move({ left: s + o - a.width });
  else {
    const d = l.freezeTotalWidth();
    n < d && e.move({ left: s - 1 - d });
  }
  if (Math.abs(r) + c > a.height)
    t.move({ top: i + c - a.height - 1 });
  else {
    const d = l.freezeTotalHeight();
    r < d && t.move({ top: i - 1 - d });
  }
}
function J(l, t, e, s = !0, i = !1) {
  if (t === -1 && e === -1) return;
  const {
    table: n,
    selector: r,
    toolbar: o,
    data: c,
    contextMenu: a
  } = this;
  a.setMode(t === -1 || e === -1 ? "row-col" : "range");
  const d = c.getCell(t, e);
  l ? (r.setEnd(t, e, i), this.trigger("cells-selected", d, r.range)) : (r.set(t, e, s), this.trigger("cell-selected", d, t, e)), o.reset(), n.render();
}
function P(l, t) {
  const {
    selector: e,
    data: s
  } = this, { rows: i, cols: n } = s;
  let [r, o] = e.indexes;
  const { eri: c, eci: a } = e.range;
  l && ([r, o] = e.moveIndexes), t === "left" ? o > 0 && (o -= 1) : t === "right" ? (a !== o && (o = a), o < n.len - 1 && (o += 1)) : t === "up" ? r > 0 && (r -= 1) : t === "down" ? (c !== r && (r = c), r < i.len - 1 && (r += 1)) : t === "row-first" ? o = 0 : t === "row-last" ? o = n.len - 1 : t === "col-first" ? r = 0 : t === "col-last" && (r = i.len - 1), l && (e.moveIndexes = [r, o]), J.call(this, l, r, o), al.call(this);
}
function hl(l) {
  if (l.buttons !== 0 || l.target.className === `${m}-resizer-hover`) return;
  const { offsetX: t, offsetY: e } = l, {
    rowResizer: s,
    colResizer: i,
    tableEl: n,
    data: r
  } = this, { rows: o, cols: c } = r;
  if (t > c.indexWidth && e > o.height) {
    s.hide(), i.hide();
    return;
  }
  const a = n.box(), d = r.getCellRectByXY(l.offsetX, l.offsetY);
  d.ri >= 0 && d.ci === -1 ? (d.width = c.indexWidth, s.show(d, {
    width: a.width
  }), o.isHide(d.ri - 1) ? s.showUnhide(d.ri) : s.hideUnhide()) : s.hide(), d.ri === -1 && d.ci >= 0 ? (d.height = o.height, i.show(d, {
    height: a.height
  }), c.isHide(d.ci - 1) ? i.showUnhide(d.ci) : i.hideUnhide()) : i.hide();
}
function dl(l) {
  const { verticalScrollbar: t, horizontalScrollbar: e, data: s } = this, { top: i } = t.scroll(), { left: n } = e.scroll(), { rows: r, cols: o } = s, { deltaY: c, deltaX: a } = l, d = (v, y) => {
    let C = v, k = 0;
    do
      k = y(C), C += 1;
    while (k <= 0);
    return k;
  }, h = (v) => {
    if (v > 0) {
      const y = s.scroll.ri + 1;
      if (y < r.len) {
        const C = d(y, (k) => r.getHeight(k));
        t.move({ top: i + C - 1 });
      }
    } else {
      const y = s.scroll.ri - 1;
      if (y >= 0) {
        const C = d(y, (k) => r.getHeight(k));
        t.move({ top: y === 0 ? 0 : i - C });
      }
    }
  }, f = (v) => {
    if (v > 0) {
      const y = s.scroll.ci + 1;
      if (y < o.len) {
        const C = d(y, (k) => o.getWidth(k));
        e.move({ left: n + C - 1 });
      }
    } else {
      const y = s.scroll.ci - 1;
      if (y >= 0) {
        const C = d(y, (k) => o.getWidth(k));
        e.move({ left: y === 0 ? 0 : n - C });
      }
    }
  }, g = Math.abs(c), p = Math.abs(a), w = Math.max(g, p);
  /Firefox/i.test(window.navigator.userAgent) && Ft(h(l.detail), 50), w === p && Ft(f(a), 50), w === g && Ft(h(c), 50);
}
function fl(l, t) {
  const { verticalScrollbar: e, horizontalScrollbar: s } = this, { top: i } = e.scroll(), { left: n } = s.scroll();
  l === "left" || l === "right" ? s.move({ left: n - t }) : (l === "up" || l === "down") && e.move({ top: i - t });
}
function Jt() {
  const { data: l, verticalScrollbar: t } = this, { height: e } = this.getTableOffset(), s = l.exceptRowTotalHeight(0, -1);
  t.set(e, l.rows.totalHeight() - s);
}
function Qt() {
  const { data: l, horizontalScrollbar: t } = this, { width: e } = this.getTableOffset();
  l && t.set(e, l.cols.totalWidth());
}
function ul() {
  const {
    selector: l,
    data: t,
    editor: e
  } = this, [s, i] = t.freeze;
  if (s > 0 || i > 0) {
    const n = t.freezeTotalWidth(), r = t.freezeTotalHeight();
    e.setFreezeLengths(n, r);
  }
  l.resetAreaOffset();
}
function M() {
  const {
    tableEl: l,
    overlayerEl: t,
    overlayerCEl: e,
    table: s,
    toolbar: i,
    selector: n,
    el: r
  } = this, o = this.getTableOffset(), c = this.getRect();
  l.attr(c), t.offset(c), e.offset(o), r.css("width", `${c.width}px`), Jt.call(this), Qt.call(this), ul.call(this), s.render(), i.reset(), n.reset();
}
function ut() {
  const { data: l, selector: t } = this;
  l.clearClipboard(), t.hideClipboard();
}
function Lt() {
  const { data: l, selector: t } = this;
  l.copy(), l.copyToSystemClipboard(), t.showClipboard();
}
function De() {
  const { data: l, selector: t } = this;
  l.cut(), t.showClipboard();
}
function ht(l, t) {
  const { data: e } = this;
  if (e.settings.mode !== "read") {
    if (e.paste(l, (s) => Ze("Tip", s)))
      M.call(this);
    else if (t) {
      const s = t.clipboardData.getData("text/plain");
      this.data.pasteFromText(s), M.call(this);
    }
  }
}
function gl() {
  this.data.hideRowsOrCols(), M.call(this);
}
function Te(l, t) {
  this.data.unhideRowsOrCols(l, t), M.call(this);
}
function pl() {
  const { data: l } = this;
  l.autofilter(), M.call(this);
}
function ml() {
  const { toolbar: l } = this;
  l.paintformatActive() && (ht.call(this, "format"), ut.call(this), l.paintformatToggle());
}
function Oe(l) {
  const {
    selector: t,
    data: e,
    table: s,
    sortFilter: i
  } = this, { offsetX: n, offsetY: r } = l, o = l.target.className === `${m}-selector-corner`, c = e.getCellRectByXY(n, r), {
    left: a,
    top: d,
    width: h,
    height: f
  } = c;
  let { ri: g, ci: p } = c;
  const { autoFilter: w } = e;
  if (w.includes(g, p) && a + h - 20 < n && d + f - 20 < r) {
    const v = w.items(p, (y, C) => e.rows.getCell(y, C));
    i.hide(), i.set(p, v, w.getFilter(p), w.getSort(p)), i.setOffset({ left: a, top: d + f + 2 });
    return;
  }
  l.shiftKey || (o ? t.showAutofill(g, p) : J.call(this, !1, g, p), Me(window, (v) => {
    ({ ri: g, ci: p } = e.getCellRectByXY(v.offsetX, v.offsetY)), o ? t.showAutofill(g, p) : v.buttons === 1 && !v.shiftKey && J.call(this, !0, g, p, !0, !0);
  }, () => {
    o && t.arange && e.settings.mode !== "read" && e.autofill(t.arange, "all", (v) => Ze("Tip", v)) && s.render(), t.hideAutofill(), ml.call(this);
  })), !o && l.buttons === 1 && l.shiftKey && J.call(this, !0, g, p);
}
function gt() {
  const { editor: l, data: t } = this, e = t.getSelectedRect(), s = this.getTableOffset();
  let i = "top";
  e.top > s.height / 2 && (i = "bottom"), l.setOffset(e, i);
}
function dt() {
  const { editor: l, data: t } = this;
  t.settings.mode !== "read" && (gt.call(this), l.setCell(t.getSelectedCell(), t.getSelectedValidator()), ut.call(this));
}
function wl(l) {
  const { data: t, table: e, selector: s } = this;
  t.scrolly(l, () => {
    s.resetBRLAreaOffset(), gt.call(this), e.render();
  });
}
function bl(l) {
  const { data: t, table: e, selector: s } = this;
  t.scrollx(l, () => {
    s.resetBRTAreaOffset(), gt.call(this), e.render();
  });
}
function xl(l, t) {
  const { ri: e } = l, { table: s, selector: i, data: n } = this;
  n.rows.setHeight(e, t), s.render(), i.resetAreaOffset(), Jt.call(this), gt.call(this);
}
function vl(l, t) {
  const { ci: e } = l, { table: s, selector: i, data: n } = this;
  n.cols.setWidth(e, t), s.render(), i.resetAreaOffset(), Qt.call(this), gt.call(this);
}
function Mt(l, t = "finished") {
  const { data: e, table: s } = this;
  if (e.settings.mode === "read") return;
  e.setSelectedCellText(l, t);
  const { ri: i, ci: n } = e.selector;
  t === "finished" ? s.render() : this.trigger("cell-edited", l, i, n);
}
function Ct(l) {
  const { data: t } = this;
  t.settings.mode !== "read" && (l === "insert-row" ? t.insert("row") : l === "delete-row" ? t.delete("row") : l === "insert-column" ? t.insert("column") : l === "delete-column" ? t.delete("column") : l === "delete-cell" ? t.deleteCell() : l === "delete-cell-format" ? t.deleteCell("format") : l === "delete-cell-text" ? t.deleteCell("text") : l === "cell-printable" ? t.setSelectedCellAttr("printable", !0) : l === "cell-non-printable" ? t.setSelectedCellAttr("printable", !1) : l === "cell-editable" ? t.setSelectedCellAttr("editable", !0) : l === "cell-non-editable" && t.setSelectedCellAttr("editable", !1), ut.call(this), M.call(this));
}
function yl(l, t) {
  const { data: e } = this;
  if (l === "undo")
    this.undo();
  else if (l === "redo")
    this.redo();
  else if (l === "print")
    this.print.preview();
  else if (l === "paintformat")
    t === !0 ? Lt.call(this) : ut.call(this);
  else if (l === "clearformat")
    Ct.call(this, "delete-cell-format");
  else if (l !== "link") {
    if (l !== "chart") if (l === "autofilter")
      pl.call(this);
    else if (l === "freeze")
      if (t) {
        const { ri: s, ci: i } = e.selector;
        this.freeze(s, i);
      } else
        this.freeze(0, 0);
    else
      e.setSelectedCellAttr(l, t), l === "formula" && !e.selector.multiple() && dt.call(this), M.call(this);
  }
}
function kl(l, t, e, s) {
  this.data.setAutoFilter(l, t, e, s), M.call(this);
}
function Cl() {
  const {
    selector: l,
    overlayerEl: t,
    rowResizer: e,
    colResizer: s,
    verticalScrollbar: i,
    horizontalScrollbar: n,
    editor: r,
    contextMenu: o,
    toolbar: c,
    modalValidation: a,
    sortFilter: d
  } = this;
  t.on("mousemove", (h) => {
    hl.call(this, h);
  }).on("mousedown", (h) => {
    r.clear(), o.hide(), h.buttons === 2 ? (this.data.xyInSelectedRect(h.offsetX, h.offsetY) || Oe.call(this, h), o.setPosition(h.offsetX, h.offsetY), h.stopPropagation()) : h.detail === 2 ? dt.call(this) : Oe.call(this, h);
  }).on("mousewheel.stop", (h) => {
    dl.call(this, h);
  }).on("mouseout", (h) => {
    const { offsetX: f, offsetY: g } = h;
    g <= 0 && s.hide(), f <= 0 && e.hide();
  }), l.inputChange = (h) => {
    Mt.call(this, h, "input"), dt.call(this);
  }, Is(t.el, {
    move: (h, f) => {
      fl.call(this, h, f);
    }
  }), c.change = (h, f) => yl.call(this, h, f), d.ok = (h, f, g, p) => kl.call(this, h, f, g, p), e.finishedFn = (h, f) => {
    xl.call(this, h, f);
  }, s.finishedFn = (h, f) => {
    vl.call(this, h, f);
  }, e.unhideFn = (h) => {
    Te.call(this, "row", h);
  }, s.unhideFn = (h) => {
    Te.call(this, "col", h);
  }, i.moveFn = (h, f) => {
    wl.call(this, h, f);
  }, n.moveFn = (h, f) => {
    bl.call(this, h, f);
  }, r.change = (h, f) => {
    Mt.call(this, f, h);
  }, a.change = (h, ...f) => {
    h === "save" ? this.data.addValidation(...f) : this.data.removeValidation();
  }, o.itemClick = (h) => {
    h === "validation" ? a.setValue(this.data.getSelectedValidation()) : h === "copy" ? Lt.call(this) : h === "cut" ? De.call(this) : h === "paste" ? ht.call(this, "all") : h === "paste-value" ? ht.call(this, "text") : h === "paste-format" ? ht.call(this, "format") : h === "hide" ? gl.call(this) : Ct.call(this, h);
  }, H(window, "resize", () => {
    this.reload();
  }), H(window, "click", (h) => {
    this.focusing = t.contains(h.target);
  }), H(window, "paste", (h) => {
    this.focusing && (ht.call(this, "all", h), h.preventDefault());
  }), H(window, "keydown", (h) => {
    if (!this.focusing) return;
    const f = h.keyCode || h.which, {
      key: g,
      ctrlKey: p,
      shiftKey: w,
      metaKey: v
    } = h;
    if (p || v)
      switch (f) {
        case 90:
          this.undo(), h.preventDefault();
          break;
        case 89:
          this.redo(), h.preventDefault();
          break;
        case 67:
          Lt.call(this), h.preventDefault();
          break;
        case 88:
          De.call(this), h.preventDefault();
          break;
        case 85:
          c.trigger("underline"), h.preventDefault();
          break;
        case 86:
          break;
        case 37:
          P.call(this, w, "row-first"), h.preventDefault();
          break;
        case 38:
          P.call(this, w, "col-first"), h.preventDefault();
          break;
        case 39:
          P.call(this, w, "row-last"), h.preventDefault();
          break;
        case 40:
          P.call(this, w, "col-last"), h.preventDefault();
          break;
        case 32:
          J.call(this, !1, -1, this.data.selector.ci, !1), h.preventDefault();
          break;
        case 66:
          c.trigger("bold");
          break;
        case 73:
          c.trigger("italic");
          break;
      }
    else {
      switch (f) {
        case 32:
          w && J.call(this, !1, this.data.selector.ri, -1, !1);
          break;
        case 27:
          o.hide(), ut.call(this);
          break;
        case 37:
          P.call(this, w, "left"), h.preventDefault();
          break;
        case 38:
          P.call(this, w, "up"), h.preventDefault();
          break;
        case 39:
          P.call(this, w, "right"), h.preventDefault();
          break;
        case 40:
          P.call(this, w, "down"), h.preventDefault();
          break;
        case 9:
          r.clear(), P.call(this, !1, w ? "left" : "right"), h.preventDefault();
          break;
        case 13:
          r.clear(), P.call(this, !1, w ? "up" : "down"), h.preventDefault();
          break;
        case 8:
          Ct.call(this, "delete-cell-text"), h.preventDefault();
          break;
      }
      g === "Delete" ? (Ct.call(this, "delete-cell-text"), h.preventDefault()) : f >= 65 && f <= 90 || f >= 48 && f <= 57 || f >= 96 && f <= 105 || h.key === "=" ? (Mt.call(this, h.key, "input"), dt.call(this)) : f === 113 && dt.call(this);
    }
  });
}
class El {
  constructor(t, e) {
    this.eventMap = As();
    const { view: s, showToolbar: i, showContextmenu: n } = e.settings;
    this.el = u("div", `${m}-sheet`), this.toolbar = new il(e, s.width, !i), this.print = new ui(e), t.children(this.toolbar.el, this.el, this.print.el), this.data = e, this.tableEl = u("canvas", `${m}-table`), this.rowResizer = new de(!1, e.rows.height), this.colResizer = new de(!0, e.cols.minWidth), this.verticalScrollbar = new fe(!0), this.horizontalScrollbar = new fe(!1), this.editor = new Zs(
      si,
      () => this.getTableOffset(),
      e.rows.height
    ), this.modalValidation = new rl(), this.contextMenu = new wi(() => this.getRect(), !n), this.selector = new Fs(e), this.overlayerCEl = u("div", `${m}-overlayer-content`).children(
      this.editor.el,
      this.selector.el
    ), this.overlayerEl = u("div", `${m}-overlayer`).child(this.overlayerCEl), this.sortFilter = new cl(), this.el.children(
      this.tableEl,
      this.overlayerEl.el,
      this.rowResizer.el,
      this.colResizer.el,
      this.verticalScrollbar.el,
      this.horizontalScrollbar.el,
      this.contextMenu.el,
      this.modalValidation.el,
      this.sortFilter.el
    ), this.table = new hi(this.tableEl.el, e), Cl.call(this), M.call(this), J.call(this, !1, 0, 0);
  }
  on(t, e) {
    return this.eventMap.on(t, e), this;
  }
  trigger(t, ...e) {
    const { eventMap: s } = this;
    s.fire(t, e);
  }
  resetData(t) {
    this.editor.clear(), this.data = t, Jt.call(this), Qt.call(this), this.toolbar.resetData(t), this.print.resetData(t), this.selector.resetData(t), this.table.resetData(t);
  }
  loadData(t) {
    return this.data.setData(t), M.call(this), this;
  }
  // freeze rows or cols
  freeze(t, e) {
    const { data: s } = this;
    return s.setFreeze(t, e), M.call(this), this;
  }
  undo() {
    this.data.undo(), M.call(this);
  }
  redo() {
    this.data.redo(), M.call(this);
  }
  reload() {
    return M.call(this), this;
  }
  getRect() {
    const { data: t } = this;
    return { width: t.viewWidth(), height: t.viewHeight() };
  }
  getTableOffset() {
    const { rows: t, cols: e } = this.data, { width: s, height: i } = this.getRect();
    return {
      width: s - e.indexWidth,
      height: i - t.height,
      left: e.indexWidth,
      top: t.height
    };
  }
}
class Sl extends _ {
  constructor(t) {
    const e = new A("ellipsis");
    super(e, "auto", !1, "top-left"), this.contentClick = t;
  }
  reset(t) {
    const e = t.map((s, i) => u("div", `${m}-item`).css("width", "150px").css("font-weight", "normal").on("click", () => {
      this.contentClick(i), this.hide();
    }).child(s));
    this.setContentChildren(...e);
  }
  setTitle() {
  }
}
const $l = [
  { key: "delete", title: S("contextmenu.deleteSheet") }
];
function Dl(l) {
  return u("div", `${m}-item`).child(l.title()).on("click", () => {
    this.itemClick(l.key), this.hide();
  });
}
function Tl() {
  return $l.map((l) => Dl.call(this, l));
}
class Ol {
  constructor() {
    this.el = u("div", `${m}-contextmenu`).css("width", "160px").children(...Tl.call(this)).hide(), this.itemClick = () => {
    };
  }
  hide() {
    const { el: t } = this;
    t.hide(), ot(t);
  }
  setOffset(t) {
    const { el: e } = this;
    e.offset(t), e.show(), ft(e);
  }
}
class Il {
  constructor(t = () => {
  }, e = () => {
  }, s = () => {
  }, i = () => {
  }) {
    this.swapFunc = e, this.updateFunc = i, this.dataNames = [], this.activeEl = null, this.deleteEl = null, this.items = [], this.moreEl = new Sl((n) => {
      this.clickSwap2(this.items[n]);
    }), this.contextMenu = new Ol(), this.contextMenu.itemClick = s, this.el = u("div", `${m}-bottombar`).children(
      this.contextMenu.el,
      this.menuEl = u("ul", `${m}-menu`).child(
        u("li", "").children(
          new A("add").on("click", () => {
            t();
          }),
          u("span", "").child(this.moreEl)
        )
      )
    );
  }
  addItem(t, e) {
    this.dataNames.push(t);
    const s = u("li", e ? "active" : "").child(t);
    s.on("click", () => {
      this.clickSwap2(s);
    }).on("contextmenu", (i) => {
      const { offsetLeft: n, offsetHeight: r } = i.target;
      this.contextMenu.setOffset({ left: n, bottom: r + 1 }), this.deleteEl = s;
    }).on("dblclick", () => {
      const i = s.html(), n = new rt("auto", "");
      n.val(i), n.input.on("blur", ({ target: r }) => {
        const { value: o } = r, c = this.dataNames.findIndex((a) => a === i);
        this.renameItem(c, o);
      }), s.html("").child(n.el), n.focus();
    }), e && this.clickSwap(s), this.items.push(s), this.menuEl.child(s), this.moreEl.reset(this.dataNames);
  }
  renameItem(t, e) {
    this.dataNames.splice(t, 1, e), this.moreEl.reset(this.dataNames), this.items[t].html("").child(e), this.updateFunc(t, e);
  }
  clear() {
    this.items.forEach((t) => {
      this.menuEl.removeChild(t.el);
    }), this.items = [], this.dataNames = [], this.moreEl.reset(this.dataNames);
  }
  deleteItem() {
    const { activeEl: t, deleteEl: e } = this;
    if (this.items.length > 1) {
      const s = this.items.findIndex((i) => i === e);
      if (this.items.splice(s, 1), this.dataNames.splice(s, 1), this.menuEl.removeChild(e.el), this.moreEl.reset(this.dataNames), t === e) {
        const [i] = this.items;
        return this.activeEl = i, this.activeEl.toggle(), [s, 0];
      }
      return [s, -1];
    }
    return [-1];
  }
  clickSwap2(t) {
    const e = this.items.findIndex((s) => s === t);
    this.clickSwap(t), this.activeEl.toggle(), this.swapFunc(e);
  }
  clickSwap(t) {
    this.activeEl !== null && this.activeEl.toggle(), this.activeEl = t;
  }
}
class Ke {
  constructor(t, e = {}) {
    let s = t;
    this.options = { showBottomBar: !0, ...e }, this.sheetIndex = 1, this.datas = [], typeof t == "string" && (s = document.querySelector(t)), this.bottombar = this.options.showBottomBar ? new Il(() => {
      const n = this.addSheet();
      this.sheet.resetData(n);
    }, (n) => {
      const r = this.datas[n];
      this.sheet.resetData(r);
    }, () => {
      this.deleteSheet();
    }, (n, r) => {
      this.datas[n].name = r;
    }) : null, this.data = this.addSheet();
    const i = u("div", `${m}`).on("contextmenu", (n) => n.preventDefault());
    s.appendChild(i.el), this.sheet = new El(i, this.data), this.bottombar !== null && i.child(this.bottombar.el);
  }
  addSheet(t, e = !0) {
    const s = t || `sheet${this.sheetIndex}`, i = new Os(s, this.options);
    return i.change = (...n) => {
      this.sheet.trigger("change", ...n);
    }, this.datas.push(i), this.bottombar !== null && this.bottombar.addItem(s, e), this.sheetIndex += 1, i;
  }
  deleteSheet() {
    if (this.bottombar === null) return;
    const [t, e] = this.bottombar.deleteItem();
    t >= 0 && (this.datas.splice(t, 1), e >= 0 && this.sheet.resetData(this.datas[e]));
  }
  loadData(t) {
    const e = Array.isArray(t) ? t : [t];
    if (this.bottombar !== null && this.bottombar.clear(), this.datas = [], e.length > 0)
      for (let s = 0; s < e.length; s += 1) {
        const i = e[s], n = this.addSheet(i.name, s === 0);
        n.setData(i), s === 0 && this.sheet.resetData(n);
      }
    return this;
  }
  getData() {
    return this.datas.map((t) => t.getData());
  }
  cellText(t, e, s, i = 0) {
    return this.datas[i].setCellText(t, e, s, "finished"), this;
  }
  cell(t, e, s = 0) {
    return this.datas[s].getCell(t, e);
  }
  cellStyle(t, e, s = 0) {
    return this.datas[s].getCellStyle(t, e);
  }
  reRender() {
    return this.sheet.table.render(), this;
  }
  on(t, e) {
    return this.sheet.on(t, e), this;
  }
  validate() {
    const { validations: t } = this.data;
    return t.errors.size <= 0;
  }
  change(t) {
    return this.sheet.on("change", t), this;
  }
  static locale(t, e) {
    ze(t, e);
  }
}
const Al = (l, t = {}) => new Ke(l, t);
window && (window.x_spreadsheet = Al, window.x_spreadsheet.locale = (l, t) => ze(l, t));
class Ge {
  constructor(t) {
    this.context = t;
  }
  /**
   * 计算公式
   */
  calculate(t, e, s) {
    if (!t.startsWith("="))
      return t;
    t = t.substring(1);
    try {
      return t = this.replaceCellReferences(t), t = this.replaceFunctions(t), new Function("return " + t)();
    } catch (i) {
      return console.error("Formula calculation error:", i), "#ERROR!";
    }
  }
  /**
   * 替换单元格引用
   */
  replaceCellReferences(t) {
    const e = /([A-Z]+)(\d+)/g;
    return t.replace(e, (s, i, n) => {
      const r = this.columnToIndex(i), o = parseInt(n) - 1, c = this.getCellValue(o, r);
      return isNaN(c) ? `"${c}"` : c;
    });
  }
  /**
   * 替换函数
   */
  replaceFunctions(t) {
    return t = t.replace(/SUM\(([^)]+)\)/gi, (e, s) => this.calculateSum(s)), t = t.replace(/AVERAGE\(([^)]+)\)/gi, (e, s) => this.calculateAverage(s)), t = t.replace(/COUNT\(([^)]+)\)/gi, (e, s) => this.calculateCount(s)), t = t.replace(/MAX\(([^)]+)\)/gi, (e, s) => this.calculateMax(s)), t = t.replace(/MIN\(([^)]+)\)/gi, (e, s) => this.calculateMin(s)), t;
  }
  /**
   * 计算 SUM
   */
  calculateSum(t) {
    return this.getRangeValues(t).reduce((i, n) => i + (parseFloat(n) || 0), 0).toString();
  }
  /**
   * 计算 AVERAGE
   */
  calculateAverage(t) {
    const s = this.getRangeValues(t).filter((n) => !isNaN(parseFloat(n)));
    return s.length === 0 ? "0" : (s.reduce((n, r) => n + parseFloat(r), 0) / s.length).toString();
  }
  /**
   * 计算 COUNT
   */
  calculateCount(t) {
    return this.getRangeValues(t).filter((i) => !isNaN(parseFloat(i))).length.toString();
  }
  /**
   * 计算 MAX
   */
  calculateMax(t) {
    const s = this.getRangeValues(t).filter((i) => !isNaN(parseFloat(i))).map((i) => parseFloat(i));
    return s.length === 0 ? "0" : Math.max(...s).toString();
  }
  /**
   * 计算 MIN
   */
  calculateMin(t) {
    const s = this.getRangeValues(t).filter((i) => !isNaN(parseFloat(i))).map((i) => parseFloat(i));
    return s.length === 0 ? "0" : Math.min(...s).toString();
  }
  /**
   * 获取范围内的值
   */
  getRangeValues(t) {
    const e = [], s = /([A-Z]+)(\d+):([A-Z]+)(\d+)/, i = t.match(s);
    if (i) {
      const [, n, r, o, c] = i, a = this.columnToIndex(n), d = this.columnToIndex(o), h = parseInt(r) - 1, f = parseInt(c) - 1;
      for (let g = h; g <= f; g++)
        for (let p = a; p <= d; p++) {
          const w = this.getCellValue(g, p);
          w != null && w !== "" && e.push(w);
        }
    } else {
      const n = /([A-Z]+)(\d+)/, r = t.match(n);
      if (r) {
        const [, o, c] = r, a = this.getCellValue(
          parseInt(c) - 1,
          this.columnToIndex(o)
        );
        a != null && a !== "" && e.push(a);
      }
    }
    return e;
  }
  /**
   * 获取单元格值
   */
  getCellValue(t, e) {
    const s = this.context.data;
    if (!s[t] || !s[t].cells || !s[t].cells[e])
      return 0;
    const i = s[t].cells[e];
    if (i.value !== void 0)
      return i.value;
    const n = i.text || "";
    if (n.startsWith("="))
      return 0;
    const r = parseFloat(n);
    return isNaN(r) ? n : r;
  }
  /**
   * 列字母转索引
   */
  columnToIndex(t) {
    let e = 0;
    for (let s = 0; s < t.length; s++)
      e = e * 26 + (t.charCodeAt(s) - 65 + 1);
    return e - 1;
  }
  /**
   * 索引转列字母
   */
  indexToColumn(t) {
    let e = "";
    for (; t >= 0; )
      e = String.fromCharCode(t % 26 + 65) + e, t = Math.floor(t / 26) - 1;
    return e;
  }
}
const Rl = { class: "grid-view-container" }, zl = { class: "grid-toolbar" }, Fl = { class: "formula-bar" }, Ml = { class: "status-bar" }, Hl = { key: 0 }, Nl = /* @__PURE__ */ Je({
  __name: "GridView",
  setup(l) {
    const t = {
      toolbar: {
        undo: "撤销",
        redo: "重做",
        print: "打印",
        paintformat: "格式刷",
        clearformat: "清除格式",
        format: "格式",
        font: "字体",
        fontSize: "字号",
        fontBold: "加粗",
        fontItalic: "斜体",
        underline: "下划线",
        strike: "删除线",
        color: "文字颜色",
        bgcolor: "背景颜色",
        border: "边框",
        merge: "合并单元格",
        align: "对齐方式",
        valign: "垂直对齐",
        textwrap: "自动换行",
        freeze: "冻结窗格",
        autofilter: "自动筛选",
        formula: "公式",
        more: "更多"
      }
    }, e = et(), s = et(""), i = et("A1"), n = et(100), r = et(26), o = et("");
    let c = null, a = null;
    function d() {
      if (!e.value) return;
      c = new Ke(e.value, {
        mode: "edit",
        showToolbar: !0,
        showGrid: !0,
        showContextmenu: !0,
        view: {
          height: () => window.innerHeight - 200,
          width: () => e.value?.clientWidth || 1e3
        },
        row: {
          len: n.value,
          height: 25
        },
        col: {
          len: r.value,
          width: 100,
          minWidth: 60
        },
        style: {
          bgcolor: "#ffffff",
          align: "left",
          valign: "middle",
          textwrap: !1,
          strike: !1,
          underline: !1,
          color: "#0a0a0a",
          font: {
            name: "Arial",
            size: 10,
            bold: !1,
            italic: !1
          }
        }
      }), c.locale("zh-cn", t), c.change((x) => {
        console.log("Data changed:", x), h();
      }), c.on("cell-selected", (x, $, T) => {
        i.value = `${String.fromCharCode(65 + T)}${$ + 1}`;
        const D = c.getData()[0].rows[$]?.[T];
        D?.text && D.text.startsWith("=") ? s.value = D.text : s.value = "";
      });
      const b = c.getData()[0];
      a = new Ge({
        data: b.rows || [],
        columns: []
      }), f();
    }
    function h() {
      if (!c || !a) return;
      const b = c.getData()[0], x = b.rows || {};
      Object.keys(x).forEach(($) => {
        const T = x[$];
        T && T.cells && Object.keys(T.cells).forEach((D) => {
          const R = T.cells[D];
          if (R && R.text && R.text.startsWith("="))
            try {
              const N = a.calculate(R.text, parseInt($), parseInt(D));
              R.value = N;
            } catch {
              R.value = "#ERROR!";
            }
        });
      }), c.loadData(b);
    }
    function f() {
      const b = {
        rows: {
          0: { cells: { 0: { text: "产品" }, 1: { text: "数量" }, 2: { text: "单价" }, 3: { text: "总价" } } },
          1: { cells: { 0: { text: "产品A" }, 1: { text: "10" }, 2: { text: "100" }, 3: { text: "=B2*C2" } } },
          2: { cells: { 0: { text: "产品B" }, 1: { text: "20" }, 2: { text: "150" }, 3: { text: "=B3*C3" } } },
          3: { cells: { 0: { text: "产品C" }, 1: { text: "15" }, 2: { text: "200" }, 3: { text: "=B4*C4" } } },
          4: { cells: { 0: { text: "合计" }, 1: { text: "=SUM(B2:B4)" }, 2: { text: "" }, 3: { text: "=SUM(D2:D4)" } } }
        }
      };
      c && (c.loadData([b]), h());
    }
    function g() {
      const b = c?.getData();
      console.log("Saving data:", b), localStorage.setItem("gridData", JSON.stringify(b)), o.value = (/* @__PURE__ */ new Date()).toLocaleTimeString(), alert("数据已保存！");
    }
    function p() {
      const b = document.createElement("input");
      b.type = "file", b.accept = ".xlsx,.csv", b.onchange = (x) => {
        const $ = x.target.files[0];
        $ && (console.log("Import file:", $), alert("导入功能开发中..."));
      }, b.click();
    }
    function w() {
      const b = c?.getData();
      console.log("Exporting data:", b);
      let x = "";
      const $ = b[0].rows || {};
      Object.keys($).forEach((N) => {
        const U = $[N], Z = [];
        if (U && U.cells)
          for (let W = 0; W < r.value; W++) {
            const tt = U.cells[W];
            Z.push(tt?.text || "");
          }
        x += Z.join(",") + `
`;
      });
      const T = new Blob([x], { type: "text/csv" }), D = URL.createObjectURL(T), R = document.createElement("a");
      R.href = D, R.download = "export.csv", R.click(), URL.revokeObjectURL(D);
    }
    function v() {
      n.value += 10, d();
    }
    function y() {
      r.value += 5, d();
    }
    function C() {
      if (!c || !s.value) return;
      const b = c.getData()[0], [x, $] = k();
      b.rows[x] || (b.rows[x] = { cells: {} }), b.rows[x].cells || (b.rows[x].cells = {}), b.rows[x].cells[$] = { text: s.value }, c.loadData([b]), h();
    }
    function k() {
      const b = i.value.match(/([A-Z]+)(\d+)/);
      if (!b) return [0, 0];
      const x = b[1].charCodeAt(0) - 65;
      return [parseInt(b[2]) - 1, x];
    }
    return Qe(() => {
      d();
      const b = localStorage.getItem("gridData");
      if (b)
        try {
          const x = JSON.parse(b);
          c?.loadData(x), h();
        } catch (x) {
          console.error("Failed to load saved data:", x);
        }
    }), ts(() => {
      c = null, a = null;
    }), (b, x) => (se(), ee("div", Rl, [
      z("div", zl, [
        z("button", {
          onClick: g,
          class: "btn btn-primary"
        }, " 💾 保存 "),
        z("button", {
          onClick: p,
          class: "btn"
        }, " 📥 导入 "),
        z("button", {
          onClick: w,
          class: "btn"
        }, " 📤 导出 "),
        x[2] || (x[2] = z("div", { class: "separator" }, null, -1)),
        z("button", {
          onClick: v,
          class: "btn"
        }, " ➕ 添加行 "),
        z("button", {
          onClick: y,
          class: "btn"
        }, " ➕ 添加列 "),
        x[3] || (x[3] = z("div", { class: "separator" }, null, -1)),
        z("span", Fl, [
          x[1] || (x[1] = z("span", { class: "label" }, "公式:", -1)),
          es(z("input", {
            "onUpdate:modelValue": x[0] || (x[0] = ($) => s.value = $),
            onKeyup: ss(C, ["enter"]),
            placeholder: "输入公式，如 =SUM(A1:A10)"
          }, null, 544), [
            [is, s.value]
          ])
        ])
      ]),
      z("div", {
        ref_key: "spreadsheetEl",
        ref: e,
        class: "spreadsheet-container"
      }, null, 512),
      z("div", Ml, [
        z("span", null, pt(i.value), 1),
        z("span", null, pt(n.value) + " 行 × " + pt(r.value) + " 列", 1),
        o.value ? (se(), ee("span", Hl, "最后保存: " + pt(o.value), 1)) : ls("", !0)
      ])
    ]));
  }
}), Wl = (l, t) => {
  const e = l.__vccOpts || l;
  for (const [s, i] of t)
    e[s] = i;
  return e;
}, Vl = /* @__PURE__ */ Wl(Nl, [["__scopeId", "data-v-733f181c"]]), Yl = {
  activate(l) {
    console.log("Grid View Plugin activated"), l.core.events.emit("plugin:component:register", {
      name: "grid-view",
      component: Vl,
      category: "views",
      title: "网格视图",
      description: "提供高级网格视图和公式计算功能"
    }), l.core.events.emit("plugin:service:register", {
      name: "formula-engine",
      service: Ge,
      version: "1.0.0"
    }), console.log("Grid View Plugin registration complete");
  },
  deactivate() {
    console.log("Grid View Plugin deactivated");
  }
};
export {
  Ge as FormulaEngine,
  Vl as GridView,
  Yl as default
};
