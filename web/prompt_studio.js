/**
 * Prompt Studio for ComfyUI — 提示词工作室
 * ------------------------------------------------------------------
 * 仿 WebUI 提示词页面的 ComfyUI 提示词编辑器（悬浮面板）：
 *   · 正 / 负提示词双栏，逗号切分成彩色标签，可拖动排序、可跨栏拖动
 *   · Danbooru / e621 / 双站合并 三个检索页签，支持中文反查
 *   · 下方提示词整合分组（人物 / 服饰 / 表情动作 / 画面 / 环境 / 场景 / 物品 / 镜头 / 汉服 / 魔法系 / 反向提示词）
 *   · 右侧预设提示词（保存 / 删除 / 应用，支持 {prompt} 占位符）
 *   · 在 CLIP 文本编码节点上挂一个开关，点开面板
 *
 * 面板只做编辑：不写入节点、不参与采样、不注入提示词，复制后自行粘贴。
 */

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const VERSION = "1.0.0";
const STORE_KEY = "PromptStudio.ui.v1";
const API = "/prompt_studio";

const SOURCES = [
  { id: "danbooru", label: "Danbooru" },
  { id: "e621", label: "e621" },
  { id: "both", label: "双站合并" },
];

const CAT_LABELS = {
  danbooru: { 0: "通用", 1: "画师", 3: "作品", 4: "角色", 5: "meta" },
  e621: { 0: "通用", 1: "画师", 3: "作品", 4: "角色", 5: "物种", 6: "无效", 7: "meta" },
  both: { 0: "通用", 1: "画师", 3: "作品", 4: "角色", 5: "meta", 7: "meta" },
};

const CAT_COLORS = {
  "-1": "#8d9199",
  0: "#79b473",
  1: "#e08a3c",
  3: "#a97ad0",
  4: "#5fa8d3",
  5: "#d4b04a",
  6: "#7f7f7f",
  7: "#c9a227",
};

/* ======================================================================== */
/* 小工具                                                                    */
/* ======================================================================== */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset" && typeof v === "object") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const kid of kids.flat(4)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.appendChild(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return `rgba(141,145,153,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function chipColors(color) {
  const c = String(color || "").trim();
  if (!c) return { bg: "rgba(141,145,153,.18)", bd: "rgba(141,145,153,.55)" };
  if (c.startsWith("#")) return { bg: hexToRgba(c, 0.26), bd: hexToRgba(c, 0.72) };
  return { bg: c, bd: c };
}

function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(v);
}

let toastTimer = 0;
function toast(msg) {
  let el = document.getElementById("ps-toast");
  if (!el) {
    el = h("div", { id: "ps-toast", class: "ps-toast" });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.style.display = "none"), 1600);
}

async function getJSON(path) {
  const res = await api.fetchApi(path, { cache: "no-store" });
  const data = await res.json();
  if (data && data.ok === false) throw new Error(data.error || "后端返回错误");
  return data;
}

async function postJSON(path, body) {
  const res = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return await res.json();
}

async function copyText(text) {
  if (!text) {
    toast("没有可复制的内容");
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      /* ignore */
    }
    ta.remove();
  }
  toast("已复制到剪贴板");
  return true;
}

/* ======================================================================== */
/* 状态                                                                      */
/* ======================================================================== */
const state = {
  source: "danbooru",
  pos: "",
  neg: "",
  cat: "收藏列表",
  catSel: [],
  groupFilter: "",
  cnLabels: true,
  favorites: [],
  presets: [],
  staged: new Set(),
  presetChecked: new Set(),
  opened: false,
};

const ui = {};
const tagMeta = new Map();      // tag -> { cat, count, zh }
const groupColorByTag = new Map();
const metaQueue = new Set();
const expandedGroups = new Set();

let groupsData = { groups: [] };
let currentNode = null;
let dragCtx = null;
let searchSeq = 0;
let searchResults = [];
let activeResult = -1;
let bootstrapped = false;
let cssInjected = false;

/* ======================================================================== */
/* 持久化                                                                    */
/* ======================================================================== */
function saveState() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        source: state.source,
        pos: state.pos,
        neg: state.neg,
        cat: state.cat,
        cnLabels: state.cnLabels,
      })
    );
  } catch (e) {
    /* ignore */
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return;
    if (SOURCES.some((s) => s.id === data.source)) state.source = data.source;
    if (typeof data.pos === "string") state.pos = data.pos;
    if (typeof data.neg === "string") state.neg = data.neg;
    if (typeof data.cat === "string") state.cat = data.cat;
    if (typeof data.cnLabels === "boolean") state.cnLabels = data.cnLabels;
  } catch (e) {
    /* ignore */
  }
}

/* ======================================================================== */
/* 标签 / 颜色                                                               */
/* ======================================================================== */
function splitTags(text) {
  if (!text) return [];
  const out = [];
  let buf = "";
  let depth = 0;
  let angle = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      buf += ch + (text[i + 1] || "");
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);

    if ((ch === "," || ch === "\n") && depth === 0 && angle === 0) {
      const piece = buf.trim();
      if (piece) out.push(piece);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out;
}

/* ---------------- 权重编辑（行为对齐 WebUI，独立实现） ---------------- */
const ATTENTION_STEP = 0.1;
const EXTRA_STEP = 0.05;
const WEIGHT_PAIRS = { "(": ")", "[": "]", "<": ">" };

function formatWeight(value) {
  const v = parseFloat(Number(value).toPrecision(12));
  if (Number.isInteger(v)) return v.toFixed(1);
  return String(v);
}

/** 找到与 openIdx 配对的右括号，跳过转义字符 */
function matchingClose(text, openIdx) {
  const open = text[openIdx];
  const close = WEIGHT_PAIRS[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 光标所在的最近一层括号组 */
function enclosingGroup(text, caret) {
  const stack = [];
  for (let i = 0; i < caret; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (WEIGHT_PAIRS[ch]) stack.push(i);
    else if (ch === ")" || ch === "]" || ch === ">") {
      const want = ch === ")" ? "(" : ch === "]" ? "[" : "<";
      for (let k = stack.length - 1; k >= 0; k--) {
        if (text[stack[k]] === want) {
          stack.length = k;
          break;
        }
      }
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const open = stack[k];
    const close = matchingClose(text, open);
    if (close >= caret) return { open, close, ch: text[open] };
  }
  return null;
}

/** 把 ((tag)) / [[tag]] 这种多层括号展开成一层 + 深度 */
function expandGroup(text, open, close, ch) {
  const closeCh = WEIGHT_PAIRS[ch];
  let a = open;
  let b = close;
  let depth = 1;
  while (a > 0 && text[a - 1] === ch && text[b + 1] === closeCh) {
    a--;
    b++;
    depth++;
  }
  return { open: a, close: b, ch, depth };
}

/** 拆出 "tag:1.2" 里的基名与显式权重 */
function explicitWeight(inner) {
  const m = /^(.*):(-?\d*\.?\d+)$/s.exec(inner);
  if (!m) return null;
  const weight = parseFloat(m[2]);
  if (isNaN(weight)) return null;
  return { base: m[1], weight };
}

function commaSegment(text, start, end) {
  let a = start;
  let b = end;
  while (a > 0 && !",\n\r\t".includes(text[a - 1])) a--;
  while (b < text.length && !",\n\r\t".includes(text[b])) b++;
  while (a < b && text[a] === " ") a++;
  while (b > a && text[b - 1] === " ") b--;
  return [a, b];
}

/**
 * Ctrl+↑ / Ctrl+↓ 调权重：
 *   - 有选区：对选区包裹或调整
 *   - 无选区：光标在 ()/[]/<> 里就调该组，否则选当前逗号段
 *   - 权重回到 1.0 时自动去掉括号；<lora:...> 保留尖括号，步长 0.05
 */
function adjustAttention(text, selStart, selEnd, isPlus) {
  let start = selStart;
  let end = selEnd;
  let group = null;

  if (start === end) {
    group = enclosingGroup(text, start);
    if (group) {
      group = expandGroup(text, group.open, group.close, group.ch);
      const inner = text.slice(group.open + 1, group.close);
      const ex = explicitWeight(inner);
      start = group.open + 1;
      end = ex ? start + ex.base.length : group.close;
    } else {
      const seg = commaSegment(text, start, end);
      start = seg[0];
      end = seg[1];
    }
  } else {
    const sel = text.slice(start, end);
    const first = sel[0];
    const closeCh = WEIGHT_PAIRS[first];
    if (sel.length > 2 && closeCh && sel[sel.length - 1] === closeCh) {
      // 选区本身带括号：(tag) / ((tag)) / [tag] / (tag:1.2)
      let head = 0;
      while (sel[head] === first) head++;
      let tail = 0;
      while (sel[sel.length - 1 - tail] === closeCh) tail++;
      const depth = Math.max(1, Math.min(head, tail));
      group = { open: start, close: end - 1, ch: first, depth };
    } else {
      // 选区正好是某个括号组的基名（连续 Ctrl+↑ 的常见情况）
      const around = enclosingGroup(text, start);
      if (around) {
        const g = expandGroup(text, around.open, around.close, around.ch);
        const inner = text.slice(g.open + 1, g.close);
        const pad = Math.max(0, g.depth - 1);
        const core = pad > 0 ? inner.slice(pad, inner.length - pad) : inner;
        const ex = explicitWeight(core);
        const coreStart = g.open + 1 + pad;
        const baseLen = ex ? ex.base.length : core.length;
        if (start === coreStart && end === coreStart + baseLen) group = g;
        else return null; // 选区落在括号组内部但不是基名，避免把语法包坏
      }
    }
  }

  if (start === end) return null;
  const target = text.slice(start, end);

  if (!group) {
    const next = isPlus ? 1.1 : 0.9;
    const wrapped = `(${target}:${formatWeight(next)})`;
    const newText = text.slice(0, start) + wrapped + text.slice(end);
    return { text: newText, start: start + 1, end: start + 1 + target.length };
  }

  const ch = group.ch;
  const inner = text.slice(group.open + 1, group.close);
  const pad = Math.max(0, group.depth - 1);
  const core = pad > 0 ? inner.slice(pad, inner.length - pad) : inner;
  const ex = explicitWeight(core);
  const base = ex ? ex.base : core;
  const step = ch === "<" ? EXTRA_STEP : ATTENTION_STEP;

  let current;
  if (ex) current = ex.weight;
  else if (ch === "<") return null; // <lora:name> 没有权重可调，不去破坏语法
  else current = ch === "(" ? Math.pow(1.1, group.depth) : Math.pow(1 / 1.1, group.depth);
  current = Math.round(current * 10) / 10;

  const next = Math.round((current + (isPlus ? step : -step)) * 100) / 100;
  let replacement;
  let selectOffset;
  if (ch === "<") {
    replacement = `<${base}:${formatWeight(next)}>`;
    selectOffset = group.open + 1;
  } else if (Math.abs(next - 1) < 1e-9) {
    replacement = base;
    selectOffset = group.open;
  } else {
    replacement = `(${base}:${formatWeight(next)})`;
    selectOffset = group.open + 1;
  }

  const newText = text.slice(0, group.open) + replacement + text.slice(group.close + 1);
  return { text: newText, start: selectOffset, end: selectOffset + base.length };
}

/** 解析单个标签的权重，用于 chip 显示与一键 +/- */
function tokenWeight(token) {
  const extra = /^<[^>]*:(-?\d*\.?\d+)>$/.exec(token);
  if (extra) return { base: token, weight: parseFloat(extra[1]), explicit: true, extra: true };

  const explicit = /^\(([\s\S]*):(-?\d*\.?\d+)\)$/.exec(token);
  if (explicit) {
    return { base: explicit[1], weight: parseFloat(explicit[2]), explicit: true };
  }
  const paren = /^(\(+)([\s\S]*?)(\)+)$/.exec(token);
  if (paren) {
    const depth = Math.min(paren[1].length, paren[3].length);
    if (depth > 0) {
      const w = Math.pow(1.1, depth);
      return { base: paren[2], weight: Math.round(w / ATTENTION_STEP) * ATTENTION_STEP, explicit: false };
    }
  }
  const bracket = /^(\[+)([\s\S]*?)(\]+)$/.exec(token);
  if (bracket) {
    const depth = Math.min(bracket[1].length, bracket[3].length);
    if (depth > 0) {
      const w = Math.pow(1 / 1.1, depth);
      return { base: bracket[2], weight: Math.round(w / ATTENTION_STEP) * ATTENTION_STEP, explicit: false };
    }
  }
  return { base: token, weight: 1, explicit: false };
}

function adjustTokenWeight(token, dir) {
  const info = tokenWeight(token);
  if (info.extra) {
    const m = /^(<[^>]*:)(-?\d*\.?\d+)(>)$/.exec(token);
    let w = parseFloat(m[2]) + dir * EXTRA_STEP;
    w = Math.round(w * 1000) / 1000;
    return m[1] + formatWeight(w) + m[3];
  }
  if (info.explicit || Math.abs(info.weight - 1) > 1e-9) {
    const next = Math.round((info.weight + dir * ATTENTION_STEP) * 100) / 100;
    if (Math.abs(next - 1) < 1e-9) return info.base;
    return `(${info.base}:${formatWeight(next)})`;
  }
  return `(${token}:${dir > 0 ? "1.1" : "0.9"})`;
}

function applyAttentionTo(kind, isPlus) {
  const ta = kind === "pos" ? ui.posInput : ui.negInput;
  if (!ta) return;
  const res = adjustAttention(ta.value, ta.selectionStart, ta.selectionEnd, isPlus);
  if (!res) return;
  ta.value = res.text;
  if (kind === "pos") state.pos = res.text;
  else state.neg = res.text;
  renderPrompt(kind, true);
  saveState();
  requestAnimationFrame(() => {
    ta.focus();
    try {
      ta.setSelectionRange(res.start, res.end);
    } catch (e) {
      /* ignore */
    }
  });
}

function bumpTokenWeight(kind, index, dir) {
  const tags = splitTags(kind === "pos" ? state.pos : state.neg);
  if (index < 0 || index >= tags.length) return;
  tags[index] = adjustTokenWeight(tags[index], dir);
  setPrompt(kind, tags.join(", "));
}

function colorOf(tag) {
  const g = groupColorByTag.get(tag);
  if (g) return g;
  const meta = tagMeta.get(tag);
  return CAT_COLORS[meta ? meta.cat : -1] || CAT_COLORS["-1"];
}

function queueMeta(names) {
  let added = false;
  for (const n of names) {
    if (!n || tagMeta.has(n) || metaQueue.has(n)) continue;
    metaQueue.add(n);
    added = true;
    if (metaQueue.size >= 300) break;
  }
  if (added) scheduleMetaFlush();
}

async function fetchMeta(names) {
  const clean = Array.from(new Set(names.map((n) => String(n || "").trim()).filter(Boolean))).slice(0, 400);
  if (!clean.length) return;
  try {
    const data = await getJSON(API + "/lookup?names=" + encodeURIComponent(clean.join(",")));
    const tags = data.tags || {};
    for (const [name, info] of Object.entries(tags)) {
      tagMeta.set(name, { cat: info.cat, count: info.count, zh: info.zh || "" });
    }
    renderPrompt("pos", true);
    renderPrompt("neg", true);
  } catch (e) {
    /* 后端不可用时静默 */
  }
}

const scheduleMetaFlush = debounce(flushMeta, 260);

async function flushMeta() {
  if (!metaQueue.size) return;
  const names = Array.from(metaQueue).slice(0, 400);
  names.forEach((n) => metaQueue.delete(n));
  await fetchMeta(names);
  if (metaQueue.size) scheduleMetaFlush();
}

/* ======================================================================== */
/* 提示词编辑                                                                */
/* ======================================================================== */
function setPrompt(kind, text, opts) {
  if (kind === "pos") state.pos = text;
  else state.neg = text;
  const ta = kind === "pos" ? ui.posInput : ui.negInput;
  if (ta && ta.value !== text) ta.value = text;
  renderPrompt(kind);
  saveState();
  if (!opts || opts.normalize !== false) {
    /* 只有显式操作才规范化文本框内容，输入过程保持原样 */
  }
}

function addTag(kind, tag, opts) {
  const clean = String(tag || "").trim();
  if (!clean) return;
  const tags = splitTags(kind === "pos" ? state.pos : state.neg);
  if (tags.includes(clean)) {
    toast("已在提示词中：" + clean);
    return;
  }
  tags.push(clean);
  setPrompt(kind, tags.join(", "));
  tagMeta.set(clean, tagMeta.get(clean) || { cat: -1, count: 0, zh: "" });
  queueMeta([clean]);
  if (!opts || !opts.silent) toast((kind === "pos" ? "＋正向：" : "＋反向：") + clean);
}

function removeAt(kind, index) {
  const tags = splitTags(kind === "pos" ? state.pos : state.neg);
  if (index < 0 || index >= tags.length) return;
  tags.splice(index, 1);
  setPrompt(kind, tags.join(", "));
}

function reorderAt(kind, from, to) {
  const tags = splitTags(kind === "pos" ? state.pos : state.neg);
  if (from < 0 || from >= tags.length) return;
  const [moved] = tags.splice(from, 1);
  let target = to;
  if (from < target) target -= 1;
  target = Math.max(0, Math.min(tags.length, target));
  tags.splice(target, 0, moved);
  setPrompt(kind, tags.join(", "));
}

function readDrag(e) {
  let text = "";
  try {
    text = e.dataTransfer.getData("application/x-ps-tag") || e.dataTransfer.getData("text/plain") || "";
  } catch (err) {
    text = "";
  }
  if (!text && dragCtx) text = dragCtx.text;
  return String(text || "").trim();
}

function dropInto(kind, index, text) {
  if (!text) return;
  const tags = splitTags(kind === "pos" ? state.pos : state.neg);
  if (dragCtx && dragCtx.kind === kind) {
    let from = dragCtx.index;
    if (from < 0 || from >= tags.length || tags[from] !== dragCtx.text) from = tags.indexOf(dragCtx.text);
    if (from >= 0) {
      reorderAt(kind, from, index < 0 ? tags.length : index);
      return;
    }
  }
  const at = index < 0 ? tags.length : Math.max(0, Math.min(tags.length, index));
  tags.splice(at, 0, text);
  setPrompt(kind, tags.join(", "));

  if (dragCtx && dragCtx.kind && dragCtx.kind !== kind) {
    const srcKind = dragCtx.kind;
    const src = splitTags(srcKind === "pos" ? state.pos : state.neg);
    const i = src.indexOf(dragCtx.text);
    if (i >= 0) {
      src.splice(i, 1);
      setPrompt(srcKind, src.join(", "));
    }
  }
  tagMeta.set(text, tagMeta.get(text) || { cat: -1, count: 0, zh: "" });
  queueMeta([text]);
}

function makePromptChip(text, kind, index) {
  const info = tokenWeight(text);
  const base = info.base;
  const meta = tagMeta.get(base) || tagMeta.get(text);
  const colors = chipColors(colorOf(base));
  const chip = h("span", {
    class: "ps-chip",
    draggable: "true",
    title: text + (meta && meta.zh ? " · " + meta.zh : "") + "\nCtrl+↑/↓ 调权重",
    style: { background: colors.bg, borderColor: colors.bd, color: "#eef0f3" },
  });

  const wMinus = h("b", { class: "ps-chip-wbtn", title: "降低权重 0.1（Ctrl+↓）" }, "−");
  wMinus.addEventListener("mousedown", (e) => e.stopPropagation());
  wMinus.addEventListener("click", (e) => {
    e.stopPropagation();
    bumpTokenWeight(kind, index, -1);
  });
  const wPlus = h("b", { class: "ps-chip-wbtn", title: "提高权重 0.1（Ctrl+↑）" }, "+");
  wPlus.addEventListener("mousedown", (e) => e.stopPropagation());
  wPlus.addEventListener("click", (e) => {
    e.stopPropagation();
    bumpTokenWeight(kind, index, 1);
  });
  chip.appendChild(h("span", { class: "ps-chip-t" }, base));
  if (meta && meta.zh) chip.appendChild(h("span", { class: "ps-chip-cn" }, "· " + meta.zh));

  if (info.explicit || Math.abs(info.weight - 1) > 1e-9) {
    const w = Math.round(info.weight * 100) / 100;
    chip.appendChild(h("span", { class: "ps-chip-w", title: "当前权重" }, "×" + formatWeight(w)));
  }

  chip.appendChild(wMinus);
  chip.appendChild(wPlus);

  const x = h("b", { class: "ps-chip-x", title: "移除" }, "✕");
  x.addEventListener("click", (e) => {
    e.stopPropagation();
    removeAt(kind, index);
  });
  chip.appendChild(x);

  chip.addEventListener("dragstart", (e) => {
    dragCtx = { kind, index, text };
    try {
      e.dataTransfer.setData("application/x-ps-tag", text);
      e.dataTransfer.setData("text/plain", text);
      e.dataTransfer.effectAllowed = "copyMove";
    } catch (err) {
      /* ignore */
    }
    chip.classList.add("ps-dragging");
  });
  chip.addEventListener("dragend", () => {
    chip.classList.remove("ps-dragging");
    dragCtx = null;
  });
  chip.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chip.classList.add("ps-drop-target");
  });
  chip.addEventListener("dragleave", () => chip.classList.remove("ps-drop-target"));
  chip.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chip.classList.remove("ps-drop-target");
    dropInto(kind, index, readDrag(e));
  });
  return chip;
}

function renderPrompt(kind, keepScroll) {
  const wrap = kind === "pos" ? ui.posChips : ui.negChips;
  if (!wrap) return;
  const scrollTop = keepScroll ? wrap.scrollTop : 0;
  const text = kind === "pos" ? state.pos : state.neg;
  const tags = splitTags(text);
  wrap.textContent = "";
  if (!tags.length) {
    wrap.appendChild(h("span", { class: "ps-empty" }, "空 · 从右侧检索或下方分组里点选标签"));
  } else {
    tags.forEach((t, i) => wrap.appendChild(makePromptChip(t, kind, i)));
  }
  wrap.scrollTop = scrollTop;
  const metaEl = kind === "pos" ? ui.posMeta : ui.negMeta;
  if (metaEl) metaEl.textContent = `${tags.length} 词条 · ${text.length} 字符`;
  queueMeta(tags.map((t) => tokenWeight(t).base).filter((t) => !tagMeta.has(t)));
}

/* ======================================================================== */
/* 检索                                                                      */
/* ======================================================================== */
function setSource(id) {
  if (state.source === id) return;
  state.source = id;
  saveState();
  if (ui.srcTabs) {
    for (const tab of ui.srcTabs.children) {
      tab.classList.toggle("ps-on", tab.dataset.id === id);
    }
  }
  renderCatFilters();
  runSearch();
}

function renderCatFilters() {
  if (!ui.catFilters) return;
  const labels = CAT_LABELS[state.source] || CAT_LABELS.danbooru;
  ui.catFilters.textContent = "";
  for (const key of Object.keys(labels)) {
    const num = Number(key);
    const on = state.catSel.includes(num);
    const chip = h(
      "div",
      {
        class: "ps-catfilter" + (on ? " ps-on" : ""),
        style: on ? { background: CAT_COLORS[num], borderColor: CAT_COLORS[num] } : {},
        title: "按分类过滤",
      },
      labels[key]
    );
    chip.addEventListener("click", () => {
      const i = state.catSel.indexOf(num);
      if (i >= 0) state.catSel.splice(i, 1);
      else state.catSel.push(num);
      renderCatFilters();
      runSearch();
    });
    ui.catFilters.appendChild(chip);
  }
}

const runSearch = debounce(async function () {
  // 标签里空格基本等于下划线，顺手归一化，避免「silver hair」搜不到
  const q = (ui.searchInput.value || "").trim().replace(/\s+/g, "_");
  activeResult = -1;
  if (!q) {
    searchResults = [];
    renderResults();
    return;
  }
  const seq = ++searchSeq;
  ui.results.classList.add("ps-loading");
  const cats = state.catSel.length ? `&cats=${state.catSel.join(",")}` : "";
  try {
    const data = await getJSON(
      `${API}/tags?q=${encodeURIComponent(q)}&source=${state.source}&limit=120${cats}`
    );
    if (seq !== searchSeq) return;
    searchResults = data.tags || [];
    renderResults(data);
  } catch (err) {
    if (seq !== searchSeq) return;
    searchResults = [];
    ui.results.textContent = "";
    ui.results.appendChild(
      h("div", { class: "ps-empty-tip" }, "检索失败：后端未响应。" + String(err && err.message ? err.message : ""))
    );
  } finally {
    if (seq === searchSeq) ui.results.classList.remove("ps-loading");
  }
}, 220);

function renderResults(data) {
  if (!ui.results) return;
  ui.results.textContent = "";
  if (!searchResults.length) {
    ui.results.appendChild(
      h("div", { class: "ps-empty-tip" }, "输入关键词检索标签，例如：银发 / long_hair / 1girl\n搜不到词库？右上角 ⚙ → 下载词库")
    );
    return;
  }
  const srcLabel = { danbooru: "DB", e621: "E6", zh: "CN" };
  searchResults.forEach((row, i) => {
    const [name, cat, count, zh, src] = row;
    const rowEl = h("div", { class: "ps-result", "data-i": String(i) });

    const cb = h("input", { type: "checkbox", title: "加入预选" });
    cb.checked = state.staged.has(name);
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleStage(name);
    });
    rowEl.appendChild(cb);

    rowEl.appendChild(h("span", { class: "ps-dot", style: { background: CAT_COLORS[cat] || CAT_COLORS["-1"] } }));
    rowEl.appendChild(h("span", { class: "ps-name" }, name));
    if (zh) rowEl.appendChild(h("span", { class: "ps-cn" }, zh));
    if (src && src !== state.source) rowEl.appendChild(h("span", { class: "ps-src" }, srcLabel[src] || src));
    rowEl.appendChild(h("span", { class: "ps-posts" }, fmtCount(count)));

    const btns = h("span", { class: "ps-rowbtns" });
    const bPos = h("b", { class: "ps-btn ps-sm", title: "加入正向" }, "正");
    bPos.addEventListener("click", (e) => {
      e.stopPropagation();
      addTag("pos", name);
    });
    const bNeg = h("b", { class: "ps-btn ps-sm", title: "加入反向" }, "反");
    bNeg.addEventListener("click", (e) => {
      e.stopPropagation();
      addTag("neg", name);
    });
    btns.appendChild(bPos);
    btns.appendChild(bNeg);
    rowEl.appendChild(btns);

    rowEl.addEventListener("click", (e) => {
      if (e.shiftKey) addTag("neg", name);
      else addTag("pos", name);
    });
    rowEl.addEventListener("mouseenter", () => {
      activeResult = i;
      highlightResult();
    });
    ui.results.appendChild(rowEl);
    tagMeta.set(name, tagMeta.get(name) || { cat, count, zh: zh || "" });
  });
  highlightResult();
}

function highlightResult() {
  if (!ui.results) return;
  const rows = ui.results.querySelectorAll(".ps-result");
  rows.forEach((r, i) => r.classList.toggle("ps-active", i === activeResult));
  const cur = rows[activeResult];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
}

function toggleStage(name) {
  if (state.staged.has(name)) state.staged.delete(name);
  else state.staged.add(name);
  renderStaging();
  renderResults();
}

function renderStaging() {
  if (!ui.staging) return;
  ui.staging.textContent = "";
  ui.staging.appendChild(h("span", null, `预选 ${state.staged.size}`));
  const box = h("span", { class: "ps-stage-tags" });
  Array.from(state.staged)
    .slice(0, 6)
    .forEach((t) => box.appendChild(h("span", { class: "ps-mini", title: t }, t)));
  if (state.staged.size > 6) box.appendChild(h("span", { class: "ps-mini" }, `+${state.staged.size - 6}`));
  ui.staging.appendChild(box);

  const addAll = (kind) => {
    if (!state.staged.size) {
      toast("预选区是空的");
      return;
    }
    const tags = Array.from(state.staged);
    const cur = splitTags(kind === "pos" ? state.pos : state.neg);
    for (const t of tags) if (!cur.includes(t)) cur.push(t);
    setPrompt(kind, cur.join(", "));
    state.staged.clear();
    renderStaging();
    renderResults();
    toast(`已加入${kind === "pos" ? "正向" : "反向"} ${tags.length} 个标签`);
  };

  const bPos = h("b", { class: "ps-btn ps-sm" }, "加入正");
  bPos.addEventListener("click", () => addAll("pos"));
  const bNeg = h("b", { class: "ps-btn ps-sm" }, "加入反");
  bNeg.addEventListener("click", () => addAll("neg"));
  const bClr = h("b", { class: "ps-btn ps-sm" }, "清空");
  bClr.addEventListener("click", () => {
    state.staged.clear();
    renderStaging();
    renderResults();
  });
  ui.staging.appendChild(bPos);
  ui.staging.appendChild(bNeg);
  ui.staging.appendChild(bClr);
}

/* ======================================================================== */
/* 分组词库                                                                  */
/* ======================================================================== */
async function loadGroups() {
  try {
    const data = await getJSON(API + "/groups");
    groupsData = data.data || { groups: [] };
    groupColorByTag.clear();
    for (const top of groupsData.groups || []) {
      for (const sub of top.groups || []) {
        for (const pair of sub.tags || []) {
          if (!groupColorByTag.has(pair[0])) groupColorByTag.set(pair[0], sub.color || "");
        }
      }
    }
    if (!["收藏列表"].concat((groupsData.groups || []).map((g) => g.name)).includes(state.cat)) {
      state.cat = (groupsData.groups[0] && groupsData.groups[0].name) || "收藏列表";
    }
    renderGroupTabs();
    renderGroupBody();
  } catch (e) {
    toast("分组词库加载失败：" + (e && e.message ? e.message : e));
  }
}

function renderGroupTabs() {
  if (!ui.gtabs) return;
  ui.gtabs.textContent = "";
  const names = ["收藏列表"].concat((groupsData.groups || []).map((g) => g.name));
  for (const name of names) {
    const tab = h("div", { class: "ps-gtab" + (state.cat === name ? " ps-on" : "") }, name);
    tab.addEventListener("click", () => {
      state.cat = name;
      saveState();
      renderGroupTabs();
      renderGroupBody();
    });
    ui.gtabs.appendChild(tab);
  }
}

function makeGroupChip(tag, zh, color) {
  const colors = chipColors(color || colorOf(tag));
  const label = state.cnLabels && zh ? zh : tag;
  const chip = h("span", {
    class: "ps-gtag",
    draggable: "true",
    title: `${tag}${zh ? " · " + zh : ""}\n单击加入正向 / 右键加入反向 / 拖入提示词框`,
    style: { background: colors.bg, borderColor: colors.bd },
  });
  chip.appendChild(document.createTextNode(label));
  const fav = state.favorites.includes(tag);
  const star = h("span", { class: "ps-star" + (fav ? "" : " ps-off"), title: fav ? "取消收藏" : "收藏" }, fav ? "★" : "☆");
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(tag);
  });
  chip.appendChild(star);

  chip.addEventListener("click", () => addTag("pos", tag));
  chip.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    addTag("neg", tag);
  });
  chip.addEventListener("dragstart", (e) => {
    dragCtx = { kind: "ext", index: -1, text: tag };
    try {
      e.dataTransfer.setData("application/x-ps-tag", tag);
      e.dataTransfer.setData("text/plain", tag);
      e.dataTransfer.effectAllowed = "copy";
    } catch (err) {
      /* ignore */
    }
  });
  chip.addEventListener("dragend", () => {
    dragCtx = null;
  });
  return chip;
}

function renderGroupBody() {
  if (!ui.gbody) return;
  ui.gbody.textContent = "";
  const filter = (state.groupFilter || "").trim().toLowerCase();

  if (state.cat === "收藏列表") {
    const favs = state.favorites.filter((t) => !filter || t.toLowerCase().includes(filter));
    const section = h("div", { class: "ps-gsection" });
    section.appendChild(
      h(
        "div",
        { class: "ps-gsection-head" },
        h("span", { class: "ps-dot", style: { background: "#d9b45a" } }),
        "收藏",
        h("span", { class: "ps-count" }, ` ${favs.length}`)
      )
    );
    const grid = h("div", { class: "ps-gtags" });
    if (!favs.length) {
      section.appendChild(
        h("div", { class: "ps-empty-tip" }, "还没有收藏。鼠标移到分组标签右侧的 ☆ 上点一下即可收藏。")
      );
    } else {
      favs.forEach((t) => grid.appendChild(makeGroupChip(t, (tagMeta.get(t) || {}).zh || "", "#d9b45a")));
      section.appendChild(grid);
    }
    ui.gbody.appendChild(section);
    queueMeta(favs.filter((t) => !tagMeta.has(t)));
    return;
  }

  const top = (groupsData.groups || []).find((g) => g.name === state.cat);
  if (!top) {
    ui.gbody.appendChild(h("div", { class: "ps-empty-tip" }, "该分组没有内容"));
    return;
  }

  let total = 0;
  for (const sub of top.groups || []) {
    const all = sub.tags || [];
    const tags = filter
      ? all.filter((p) => p[0].toLowerCase().includes(filter) || (p[1] && p[1].toLowerCase().includes(filter)))
      : all;
    if (!tags.length) continue;
    total += tags.length;

    const key = state.cat + "/" + sub.name;
    const open = expandedGroups.has(key);
    const shown = open ? tags : tags.slice(0, 140);

    const section = h("div", { class: "ps-gsection" });
    section.appendChild(
      h(
        "div",
        { class: "ps-gsection-head" },
        h("span", { class: "ps-dot", style: { background: sub.color || "#8d9199" } }),
        sub.name || "未命名",
        h("span", { class: "ps-count" }, ` ${tags.length}`)
      )
    );
    const grid = h("div", { class: "ps-gtags" });
    for (const pair of shown) grid.appendChild(makeGroupChip(pair[0], pair[1], sub.color));
    section.appendChild(grid);

    if (shown.length < tags.length) {
      const more = h("div", { class: "ps-btn ps-sm", style: { marginTop: "5px", display: "inline-flex" } },
        `展开剩余 ${tags.length - shown.length} 个`);
      more.addEventListener("click", () => {
        expandedGroups.add(key);
        renderGroupBody();
      });
      section.appendChild(more);
    }
    ui.gbody.appendChild(section);
  }

  if (!total) ui.gbody.appendChild(h("div", { class: "ps-empty-tip" }, "没有匹配的标签"));
}

async function toggleFavorite(tag) {
  const i = state.favorites.indexOf(tag);
  if (i >= 0) state.favorites.splice(i, 1);
  else state.favorites.push(tag);
  renderGroupBody();
  try {
    await postJSON(API + "/favorites", { tags: state.favorites });
  } catch (e) {
    toast("收藏写入失败（仅本地生效）");
  }
}

async function loadFavorites() {
  try {
    const data = await getJSON(API + "/favorites");
    state.favorites = Array.isArray(data.tags) ? data.tags : [];
  } catch (e) {
    state.favorites = [];
  }
}

/* ======================================================================== */
/* 预设提示词                                                                */
/* ======================================================================== */
async function loadPresets() {
  try {
    const data = await getJSON(API + "/presets");
    state.presets = (data.data && data.data.items) || [];
    renderPresets();
  } catch (e) {
    toast("预设读取失败：" + (e && e.message ? e.message : e));
  }
}

async function persistPresets() {
  try {
    const res = await postJSON(API + "/presets", { items: state.presets });
    if (res && res.ok) return true;
    toast("保存失败：" + (res && res.error ? res.error : "未知错误"));
  } catch (e) {
    toast("保存失败：后端未响应");
  }
  return false;
}

function applyPreset(preset, kind) {
  const tplRaw = ((kind === "neg" ? preset.negative : preset.prompt) || "").trim();
  if (!tplRaw) {
    toast("该预设没有" + (kind === "neg" ? "反向" : "正向") + "内容");
    return;
  }
  const cur = kind === "neg" ? state.neg : state.pos;
  let out;
  if (tplRaw.includes("{prompt}")) {
    out = tplRaw.split("{prompt}").join(cur.trim());
  } else {
    out = cur.trim() ? cur.replace(/[\s,]+$/g, "") + ", " + tplRaw : tplRaw;
  }
  out = out.replace(/,\s*,+/g, ", ").replace(/^\s*,\s*/, "").trim();
  setPrompt(kind, out);
  toast("已应用预设：" + preset.name + " → " + (kind === "pos" ? "正向" : "反向"));
}

function renderPresets() {
  if (!ui.presetList) return;
  ui.presetCount.textContent = `${state.presets.length} 个`;
  ui.presetList.textContent = "";
  if (!state.presets.length) {
    ui.presetList.appendChild(
      h("div", { class: "ps-empty-tip" }, "还没有预设。点下方「保存当前」把当前正负提示词存成预设。")
    );
    return;
  }
  state.presets.forEach((p) => {
    const row = h("div", { class: "ps-preset" + (state.presetChecked.has(p.id) ? " ps-on" : "") });
    const cb = h("input", { type: "checkbox" });
    cb.checked = state.presetChecked.has(p.id);
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.presetChecked.has(p.id)) state.presetChecked.delete(p.id);
      else state.presetChecked.add(p.id);
      renderPresets();
    });
    row.appendChild(cb);

    const nameEl = h("span", { class: "ps-pname", title: p.name }, p.name);
    row.appendChild(nameEl);

    const stat = h(
      "span",
      { class: "ps-pstat" },
      `正${(p.prompt || "").length} 反${(p.negative || "").length}`
    );
    row.appendChild(stat);

    const acts = h("span", { class: "ps-pacts" });
    const mk = (label, title, fn, cls) => {
      const b = h("b", { class: "ps-btn ps-sm " + (cls || ""), title }, label);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    acts.appendChild(mk("正", "应用到正向", () => applyPreset(p, "pos")));
    acts.appendChild(mk("反", "应用到反向", () => applyPreset(p, "neg")));
    acts.appendChild(mk("✎", "编辑", () => openPresetEditor(p), "ps-extra"));
    acts.appendChild(mk("⧉", "复制一份", () => duplicatePreset(p), "ps-extra"));
    acts.appendChild(mk("🗑", "删除", () => deletePreset(p), "ps-extra ps-danger"));
    row.appendChild(acts);

    row.addEventListener("click", () => applyPreset(p, "pos"));
    ui.presetList.appendChild(row);
  });
}

async function deletePreset(preset) {
  if (!window.confirm(`删除预设「${preset.name}」？`)) return;
  state.presets = state.presets.filter((p) => p.id !== preset.id);
  state.presetChecked.delete(preset.id);
  if (await persistPresets()) {
    renderPresets();
    toast("已删除预设");
  }
}

async function duplicatePreset(preset) {
  const copy = {
    id: "p_" + Date.now().toString(36),
    name: preset.name + " 副本",
    prompt: preset.prompt || "",
    negative: preset.negative || "",
  };
  state.presets.push(copy);
  if (await persistPresets()) {
    renderPresets();
    toast("已复制预设");
  }
}

/* --------------------------- 预设编辑对话框 --------------------------- */
function openPresetEditor(preset) {
  const editing = preset || null;
  const draft = {
    id: editing ? editing.id : "",
    name: editing ? editing.name : "",
    prompt: editing ? editing.prompt || "" : state.pos,
    negative: editing ? editing.negative || "" : state.neg,
  };

  const nameInput = h("input", {
    class: "ps-input",
    placeholder: "预设名称，例如：基础起手式",
    list: "ps-preset-names",
    value: draft.name,
  });
  const names = h("datalist", { id: "ps-preset-names" });
  state.presets.forEach((p) => names.appendChild(h("option", { value: p.name })));

  const posTa = h("textarea", { class: "ps-input", placeholder: "提示词（可用 {prompt} 代表当前正向提示词）" });
  posTa.value = draft.prompt;
  const negTa = h("textarea", { class: "ps-input", placeholder: "反向提示词（可用 {prompt} 代表当前反向提示词）" });
  negTa.value = draft.negative;

  const body = h(
    "div",
    { class: "ps-dialog-body" },
    h(
      "div",
      { class: "ps-dialog-tip" },
      "预设样式允许将整段自定义文本添加到提示词中。文本里写 {prompt} 时，应用预设会用当前提示词替换该占位符；不写 {prompt} 时，预设文本会追加到提示词末尾。"
    ),
    h("label", null, "预设名称"),
    nameInput,
    names,
    h("label", null, "提示词"),
    posTa,
    h("label", null, "反向提示词"),
    negTa
  );

  const dlg = h("div", { class: "ps-dialog" });
  dlg.appendChild(h("div", { class: "ps-dialog-head" }, editing ? "编辑预设样式" : "新建预设样式"));
  dlg.appendChild(body);

  const foot = h("div", { class: "ps-dialog-foot" });
  const saveBtn = h("b", { class: "ps-btn ps-primary" }, "保存");
  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      toast("请先填写预设名称");
      nameInput.focus();
      return;
    }
    const payload = { name, prompt: posTa.value, negative: negTa.value };
    if (editing) {
      const item = state.presets.find((p) => p.id === editing.id);
      if (item) Object.assign(item, payload);
    } else {
      state.presets.push({ id: "p_" + Date.now().toString(36), ...payload });
    }
    if (await persistPresets()) {
      closeDialog();
      renderPresets();
      toast("预设已保存");
    }
  });
  const saveAsBtn = h("b", { class: "ps-btn" }, "另存为");
  saveAsBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      toast("请先填写预设名称");
      return;
    }
    state.presets.push({
      id: "p_" + Date.now().toString(36),
      name,
      prompt: posTa.value,
      negative: negTa.value,
    });
    if (await persistPresets()) {
      closeDialog();
      renderPresets();
      toast("已另存为新预设");
    }
  });
  const delBtn = h("b", { class: "ps-btn ps-danger" }, "删除");
  delBtn.addEventListener("click", async () => {
    if (!editing) return;
    if (!window.confirm(`删除预设「${editing.name}」？`)) return;
    state.presets = state.presets.filter((p) => p.id !== editing.id);
    if (await persistPresets()) {
      closeDialog();
      renderPresets();
      toast("已删除");
    }
  });
  const closeBtn = h("b", { class: "ps-btn" }, "关闭");
  closeBtn.addEventListener("click", closeDialog);
  if (editing) foot.appendChild(delBtn);
  foot.appendChild(saveBtn);
  foot.appendChild(saveAsBtn);
  foot.appendChild(closeBtn);
  dlg.appendChild(foot);

  const mask = h("div", { class: "ps-dialog-mask" }, dlg);
  mask.addEventListener("mousedown", (e) => {
    if (e.target === mask) closeDialog();
  });
  ui.overlay.appendChild(mask);
  ui.dialog = mask;
  setTimeout(() => nameInput.focus(), 30);
}

function closeDialog() {
  if (ui.dialog) {
    ui.dialog.remove();
    ui.dialog = null;
  }
}

/* --------------------------- 设置 / 状态 --------------------------- */
async function openStatusDialog() {
  const body = h("div", { class: "ps-dialog-body" });
  body.appendChild(h("div", { class: "ps-dialog-tip" }, "词库文件位置、索引条数、状态目录。若 danbooru / e621 显示未找到，可以直接点下方「下载词库」，或编辑 data/tags_config.json 的 search_dirs 后重启 ComfyUI。"));
  const kv = h("div", { class: "ps-kv" }, "读取中…");
  body.appendChild(kv);

  const dlg = h("div", { class: "ps-dialog" });
  dlg.appendChild(h("div", { class: "ps-dialog-head" }, "Prompt Studio 状态"));
  dlg.appendChild(body);
  const foot = h("div", { class: "ps-dialog-foot" });
  const downloadBtn = h("b", { class: "ps-btn ps-primary", title: "从 a1111-sd-webui-tagcomplete 仓库下载 danbooru.csv / e621.csv" }, "下载词库");
  downloadBtn.addEventListener("click", async () => {
    if (downloadBtn.dataset.busy === "1") return;
    downloadBtn.dataset.busy = "1";
    const label = downloadBtn.textContent;
    downloadBtn.textContent = "下载中…";
    toast("开始下载词库（约 6MB），请稍候…");
    try {
      const res = await postJSON(API + "/download_tags", { keys: ["danbooru", "e621"] });
      if (res && res.ok) {
        const r = res.results || {};
        const ok = Object.keys(r).filter((k) => r[k] && r[k].ok).length;
        const bad = Object.keys(r).filter((k) => r[k] && !r[k].ok);
        toast(bad.length ? `已下载 ${ok} 个，失败：${bad.join(", ")}` : "词库下载完成");
      } else {
        toast("下载失败：" + ((res && res.error) || "后端未响应"));
      }
    } catch (e) {
      toast("下载失败：后端未响应");
    }
    downloadBtn.textContent = label;
    downloadBtn.dataset.busy = "";
    load();
  });
  const refresh = h("b", { class: "ps-btn" }, "刷新");
  refresh.addEventListener("click", () => load());
  const closeBtn = h("b", { class: "ps-btn ps-primary" }, "关闭");
  closeBtn.addEventListener("click", closeDialog);
  foot.appendChild(downloadBtn);
  foot.appendChild(refresh);
  foot.appendChild(closeBtn);
  dlg.appendChild(foot);

  const mask = h("div", { class: "ps-dialog-mask" }, dlg);
  mask.addEventListener("mousedown", (e) => {
    if (e.target === mask) closeDialog();
  });
  ui.overlay.appendChild(mask);
  ui.dialog = mask;

  async function load() {
    try {
      const data = await getJSON(API + "/status");
      const d = data.data || {};
      kv.textContent = "";
      const line = (k, v) => kv.appendChild(h("div", null, h("b", null, k + "："), String(v)));
      line("版本", d.version || VERSION);
      line("状态目录", d.state_dir || "-");
      line("中文对照", d.zh_rows || 0);
      line("预设数量", d.presets || 0);
      line("收藏数量", d.favorites || 0);
      const files = d.tag_files || {};
      for (const key of Object.keys(files)) {
        const info = files[key] || {};
        line(key, (info.path || "未找到") + (info.rows ? `（${info.rows} 条）` : ""));
      }
    } catch (e) {
      kv.textContent = "读取失败：" + (e && e.message ? e.message : e);
    }
  }
  load();
}

/* ======================================================================== */
/* 面板构建                                                                  */
/* ======================================================================== */
function injectCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const link = document.createElement("link");
  link.id = "prompt-studio-style";
  link.rel = "stylesheet";
  link.href = new URL("./prompt_studio.css", import.meta.url).href + "?v=" + VERSION;
  document.head.appendChild(link);
}

function buildUI() {
  if (ui.overlay) return;

  /* ---------- header ---------- */
  const srcTabs = h("div", { class: "ps-src-tabs" });
  SOURCES.forEach((s) => {
    const tab = h("div", { class: "ps-src-tab" + (state.source === s.id ? " ps-on" : ""), dataset: { id: s.id } }, s.label);
    tab.addEventListener("click", () => setSource(s.id));
    srcTabs.appendChild(tab);
  });
  ui.srcTabs = srcTabs;

  const copyPos = h("b", { class: "ps-btn" }, "复制正向");
  copyPos.addEventListener("click", () => copyText(state.pos));
  const copyNeg = h("b", { class: "ps-btn" }, "复制反向");
  copyNeg.addEventListener("click", () => copyText(state.neg));
  const copyAll = h("b", { class: "ps-btn ps-primary" }, "复制全部");
  copyAll.addEventListener("click", () => copyText(buildAllText()));
  const statusBtn = h("b", { class: "ps-btn ps-icon", title: "状态 / 词库路径" }, "⚙");
  statusBtn.addEventListener("click", openStatusDialog);
  const closeBtn = h("b", { class: "ps-btn ps-icon", title: "关闭 (Esc)" }, "✕");
  closeBtn.addEventListener("click", () => closeStudio());

  const head = h(
    "div",
    { class: "ps-head" },
    h("div", { class: "ps-title" }, "🎨 提示词工作室", h("span", { class: "ps-sub" }, "Prompt Studio · 不写入节点，复制后粘贴")),
    srcTabs,
    h("div", { class: "ps-head-right" }, copyPos, copyNeg, copyAll, statusBtn, closeBtn)
  );

  /* ---------- prompt blocks ---------- */
  function buildPromptBlock(kind, title) {
    const input = h("textarea", {
      class: "ps-textarea",
      placeholder: kind === "pos" ? "正向提示词：masterpiece, best quality, 1girl, ..." : "反向提示词：lowres, bad anatomy, ...",
      spellcheck: "false",
    });
    input.value = kind === "pos" ? state.pos : state.neg;
    input.addEventListener("input", () => {
      if (kind === "pos") state.pos = input.value;
      else state.neg = input.value;
      schedulePromptRender(kind);
      saveState();
    });
    input.addEventListener("blur", () => renderPrompt(kind));
    input.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      e.stopPropagation();
      applyAttentionTo(kind, e.key === "ArrowUp");
    });

    const meta = h("span", { class: "ps-meta" }, "0 词条");
    const chips = h("div", { class: "ps-chips" });

    const actions = h("span", { class: "ps-actions" });
    const wMinus = h("b", { class: "ps-btn ps-sm", title: "降低权重 0.1（Ctrl+↓，选中文字或光标所在标签）" }, "权重−");
    wMinus.addEventListener("click", () => applyAttentionTo(kind, false));
    const wPlus = h("b", { class: "ps-btn ps-sm", title: "提高权重 0.1（Ctrl+↑，选中文字或光标所在标签）" }, "权重+");
    wPlus.addEventListener("click", () => applyAttentionTo(kind, true));
    actions.appendChild(wMinus);
    actions.appendChild(wPlus);

    const sortBtn = h("b", { class: "ps-btn ps-sm", title: "按词频从高到低排序" }, "排序");
    sortBtn.addEventListener("click", async () => {
      const tags = splitTags(kind === "pos" ? state.pos : state.neg);
      const bases = tags.map((t) => tokenWeight(t).base);
      const missing = bases.filter((b) => !tagMeta.has(b));
      if (missing.length) await fetchMeta(missing);
      tags.sort((a, b) => {
        const ca = (tagMeta.get(tokenWeight(a).base) || {}).count || 0;
        const cb = (tagMeta.get(tokenWeight(b).base) || {}).count || 0;
        return cb - ca;
      });
      setPrompt(kind, tags.join(", "));
    });
    const dedupeBtn = h("b", { class: "ps-btn ps-sm", title: "去重" }, "去重");
    dedupeBtn.addEventListener("click", () => {
      const tags = splitTags(kind === "pos" ? state.pos : state.neg);
      const seen = new Set();
      const out = tags.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
      setPrompt(kind, out.join(", "));
      toast(`已去重，移除 ${tags.length - out.length} 个重复项`);
    });
    const clearBtn = h("b", { class: "ps-btn ps-sm" }, "清空");
    clearBtn.addEventListener("click", () => {
      setPrompt(kind, "");
    });
    actions.appendChild(sortBtn);
    actions.appendChild(dedupeBtn);
    actions.appendChild(clearBtn);

    if (kind === "pos") {
      const readBtn = h("b", { class: "ps-btn ps-sm", title: "把当前打开的 CLIP 节点里的文本读进来" }, "读取节点");
      readBtn.addEventListener("click", readFromNode);
      actions.appendChild(readBtn);
      ui.readBtn = readBtn;
    }

    const block = h(
      "div",
      { class: "ps-block ps-prompt", dataset: { kind } },
      h("div", { class: "ps-block-head" }, h("b", null, title), meta, actions),
      input,
      chips
    );

    chips.addEventListener("dragover", (e) => {
      e.preventDefault();
      chips.classList.add("ps-drop-zone");
    });
    chips.addEventListener("dragleave", () => chips.classList.remove("ps-drop-zone"));
    chips.addEventListener("drop", (e) => {
      e.preventDefault();
      chips.classList.remove("ps-drop-zone");
      const text = readDrag(e);
      const tags = splitTags(kind === "pos" ? state.pos : state.neg);
      dropInto(kind, tags.length, text);
    });

    if (kind === "pos") {
      ui.posInput = input;
      ui.posChips = chips;
      ui.posMeta = meta;
    } else {
      ui.negInput = input;
      ui.negChips = chips;
      ui.negMeta = meta;
    }
    return block;
  }

  const posBlock = buildPromptBlock("pos", "正向提示词");
  const negBlock = buildPromptBlock("neg", "反向提示词");

  /* ---------- group panel ---------- */
  const groupFilter = h("input", {
    class: "ps-input",
    placeholder: "过滤分组标签（中/英）",
    style: { width: "150px", padding: "3px 8px", fontSize: "11.5px" },
  });
  groupFilter.addEventListener(
    "input",
    debounce(() => {
      state.groupFilter = groupFilter.value;
      renderGroupBody();
    }, 180)
  );
  const cnToggle = h("b", { class: "ps-btn ps-sm", title: "切换中文 / 英文显示" }, "中/EN");
  cnToggle.addEventListener("click", () => {
    state.cnLabels = !state.cnLabels;
    saveState();
    renderGroupBody();
    toast(state.cnLabels ? "分组标签显示中文" : "分组标签显示英文");
  });

  ui.gtabs = h("div", { class: "ps-gtabs" });
  ui.gbody = h("div", { class: "ps-gbody" });
  const groupBlock = h(
    "div",
    { class: "ps-block ps-group-panel" },
    h("div", { class: "ps-block-head" }, h("b", null, "提示词整合"), h("span", { class: "ps-meta" }, "单击加入正向 · 右键加入反向 · 可拖入上方提示词"), h("span", { class: "ps-actions" }, groupFilter, cnToggle)),
    ui.gtabs,
    ui.gbody
  );

  const main = h("div", { class: "ps-main" }, posBlock, negBlock, groupBlock);

  /* ---------- search ---------- */
  const searchInput = h("input", {
    class: "ps-search-input",
    placeholder: "搜索标签：银发 / long_hair / 1girl（↑↓ 选择，Enter 添加）",
    spellcheck: "false",
  });
  searchInput.addEventListener("input", runSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (!searchResults.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeResult = Math.min(searchResults.length - 1, activeResult + 1);
      highlightResult();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeResult = Math.max(0, activeResult - 1);
      highlightResult();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeResult < 0) activeResult = 0;
      const row = searchResults[activeResult];
      if (row) addTag(e.shiftKey ? "neg" : "pos", row[0]);
    } else if (e.key === "Escape") {
      searchInput.value = "";
      searchResults = [];
      renderResults();
    }
  });
  ui.searchInput = searchInput;
  ui.catFilters = h("div", { class: "ps-catfilters" });
  ui.results = h("div", { class: "ps-results" });
  ui.staging = h("div", { class: "ps-staging" });
  const searchBlock = h(
    "div",
    { class: "ps-block ps-search" },
    h("div", { class: "ps-block-head" }, h("b", null, "标签检索"), h("span", { class: "ps-meta" }, "Danbooru / e621 / 中文反查")),
    h("div", { class: "ps-search-body" }, searchInput, ui.catFilters, ui.results, ui.staging)
  );

  /* ---------- presets ---------- */
  ui.presetCount = h("span", { class: "ps-meta" }, "0 个");
  ui.presetList = h("div", { class: "ps-preset-list" });

  const newBtn = h("b", { class: "ps-btn ps-sm" }, "新建");
  newBtn.addEventListener("click", () => openPresetEditor(null));
  const saveCurBtn = h("b", { class: "ps-btn ps-sm ps-primary" }, "保存当前");
  saveCurBtn.addEventListener("click", () => {
    const name = window.prompt("预设名称（保存当前正负提示词）", "预设 " + (state.presets.length + 1));
    if (!name) return;
    state.presets.push({
      id: "p_" + Date.now().toString(36),
      name,
      prompt: state.pos,
      negative: state.neg,
    });
    persistPresets().then((ok) => {
      if (ok) {
        renderPresets();
        toast("已保存预设：" + name);
      }
    });
  });
  const refreshBtn = h("b", { class: "ps-btn ps-sm", title: "从后端重新读取" }, "刷新");
  refreshBtn.addEventListener("click", loadPresets);

  const applySelBtn = h("b", { class: "ps-btn ps-sm", title: "把勾选的预设依次应用到正向" }, "应用勾选");
  applySelBtn.addEventListener("click", () => {
    const picked = state.presets.filter((p) => state.presetChecked.has(p.id));
    if (!picked.length) {
      toast("先勾选预设");
      return;
    }
    picked.forEach((p) => applyPreset(p, "pos"));
    toast(`已应用 ${picked.length} 个预设`);
  });

  const presetFoot = h("div", { class: "ps-preset-foot" }, newBtn, saveCurBtn, refreshBtn, applySelBtn);

  const exportBtn = h("b", { class: "ps-btn ps-sm", title: "导出全部预设为 JSON" }, "导出");
  exportBtn.addEventListener("click", () => {
    try {
      const blob = new Blob([JSON.stringify({ version: 1, items: state.presets }, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "prompt_studio_presets.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast("已导出预设 JSON");
    } catch (e) {
      toast("导出失败");
    }
  });
  const importInput = h("input", { type: "file", accept: ".json,application/json", style: { display: "none" } });
  importInput.addEventListener("change", async () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const items = Array.isArray(data) ? data : data.items || [];
      let added = 0;
      for (const it of items) {
        if (!it || !it.name) continue;
        if (state.presets.some((p) => p.name === it.name)) continue;
        state.presets.push({
          id: "p_" + Date.now().toString(36) + "_" + added,
          name: String(it.name),
          prompt: String(it.prompt || ""),
          negative: String(it.negative || ""),
        });
        added++;
      }
      if (added && (await persistPresets())) {
        renderPresets();
        toast(`导入 ${added} 个预设`);
      } else if (!added) {
        toast("没有可导入的新预设（同名已跳过）");
      }
    } catch (e) {
      toast("导入失败：JSON 格式不对");
    }
    importInput.value = "";
  });
  const importBtn = h("b", { class: "ps-btn ps-sm", title: "从 JSON 导入预设" }, "导入");
  importBtn.addEventListener("click", () => importInput.click());
  presetFoot.appendChild(exportBtn);
  presetFoot.appendChild(importBtn);
  presetFoot.appendChild(importInput);
  const presetBlock = h(
    "div",
    { class: "ps-block ps-presets" },
    h("div", { class: "ps-block-head" }, h("b", null, "预设提示词"), ui.presetCount, h("span", { class: "ps-meta" }, "点名字应用 · 支持 {prompt}")),
    h("div", { class: "ps-preset-body" }, ui.presetList, presetFoot)
  );

  const side = h("div", { class: "ps-side" }, searchBlock, presetBlock);

  /* ---------- footer ---------- */
  ui.footNode = h("span", null, "未绑定节点");
  const foot = h(
    "div",
    { class: "ps-foot" },
    h("span", null, "提示：本面板不写入 CLIP 节点，编辑后点「复制全部」再粘贴到节点里。"),
    h("span", { class: "ps-dotsep" }, "|"),
    h("span", null, "节点："),
    ui.footNode,
    h("span", { class: "ps-dotsep" }, "|"),
    h("span", null, "Ctrl+↑/↓ 调权重 · Ctrl+Enter 复制全部 · Esc 关闭")
  );

  const frame = h("div", { class: "ps-frame" }, head, h("div", { class: "ps-cols" }, main, side), foot);
  const overlay = h("div", { class: "ps-overlay", tabindex: "-1", style: { display: "none" } }, frame);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeStudio();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (ui.dialog) closeDialog();
      else closeStudio();
      e.stopPropagation();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      copyText(buildAllText());
    }
    e.stopPropagation();
  });
  ui.overlay = overlay;
  ui.frame = frame;
  document.body.appendChild(overlay);

  renderPrompt("pos");
  renderPrompt("neg");
  renderCatFilters();
  renderStaging();
  renderResults();
  renderGroupTabs();
  renderPresets();
}

const schedulePromptRender = debounce((kind) => renderPrompt(kind, true), 140);

function buildAllText() {
  const pos = (state.pos || "").trim();
  const neg = (state.neg || "").trim();
  if (!neg) return pos;
  return `正向：${pos}\n反向：${neg}`;
}

/* ======================================================================== */
/* 打开 / 关闭                                                               */
/* ======================================================================== */
function readFromNode() {
  if (!currentNode) {
    toast("当前没有绑定 CLIP 节点");
    return;
  }
  const text = nodeText(currentNode);
  if (!text) {
    toast("该节点里没有可读取的文本");
    return;
  }
  setPrompt("pos", text);
  toast("已从节点读取文本到正向提示词");
}

function nodeText(node) {
  if (!node) return "";
  const widgets = node.widgets || [];
  for (const name of ["text", "prompt", "text_g", "positive"]) {
    const w = widgets.find((x) => x && x.name === name);
    if (w && typeof w.value === "string" && w.value.trim()) return w.value;
  }
  return "";
}

function openStudio(node) {
  injectCSS();
  buildUI();
  if (currentNode && node && currentNode !== node) syncNodeToggle(currentNode, false);
  currentNode = node || null;
  ui.footNode.textContent = node ? `${node.title || node.type || "节点"}` : "未绑定节点";
  if (ui.readBtn) ui.readBtn.style.display = node ? "" : "none";
  ui.overlay.style.display = "flex";
  state.opened = true;
  ui.overlay.focus();
  if (!bootstrapped) {
    bootstrapped = true;
    loadGroups();
    loadFavorites().then(() => renderGroupBody());
    loadPresets();
  }
  setTimeout(() => {
    if (ui.searchInput) ui.searchInput.focus();
  }, 60);
}

function closeStudio() {
  closeDialog();
  if (!ui.overlay) return;
  ui.overlay.style.display = "none";
  state.opened = false;
  if (currentNode) syncNodeToggle(currentNode, false);
}

function syncNodeToggle(node, on) {
  if (!node || !node.widgets) return;
  const w = node.widgets.find((x) => x && x.name === STUDIO_WIDGET_NAME);
  if (w && w.value !== on) {
    w.value = on;
    node.setDirtyCanvas?.(true, true);
  }
}

/* ======================================================================== */
/* 节点挂载：CLIP 文本编码节点上的开关                                        */
/* ======================================================================== */
const STUDIO_WIDGET_NAME = "🎨 提示词编辑";

function isTextEncodeNode(name) {
  if (!name) return false;
  if (/^(PreviewText|ShowText|Text|String|Note)$/i.test(name)) return false;
  return /clip.*(text|enc)|text.*enc|prompt.*enc/i.test(name);
}

function attachStudioWidget(node) {
  if (!node || !node.widgets) return;
  if (node.__psWidget) return;
  if (!isTextEncodeNode(node.type) && !isTextEncodeNode(node.comfyClass)) return;

  let widget = null;
  try {
    widget = node.addWidget(
      "toggle",
      STUDIO_WIDGET_NAME,
      false,
      (value) => {
        if (value) openStudio(node);
        else if (state.opened && currentNode === node) closeStudio();
      },
      { serialize: false }
    );
  } catch (e) {
    try {
      widget = node.addWidget("button", STUDIO_WIDGET_NAME, null, () => openStudio(node));
    } catch (err) {
      return;
    }
  }
  if (widget) {
    widget.serialize = false;
    widget.options = Object.assign({}, widget.options || {}, { serialize: false });
  }
  node.__psWidget = widget || true;
  node.setDirtyCanvas?.(true, true);
}

/* ======================================================================== */
/* 扩展注册                                                                  */
/* ======================================================================== */
app.registerExtension({
  name: "PromptStudio.Panel",
  async setup() {
    loadState();
    injectCSS();
  },
  async nodeCreated(node) {
    attachStudioWidget(node);
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!isTextEncodeNode(nodeData && nodeData.name)) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const res = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      attachStudioWidget(this);
      return res;
    };

    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function () {
      const res = getExtraMenuOptions ? getExtraMenuOptions.apply(this, arguments) : undefined;
      const options = arguments[1];
      if (Array.isArray(options)) {
        options.unshift({
          content: "🎨 打开提示词工作室",
          callback: () => openStudio(this),
        });
      }
      return res;
    };
  },
});

/* 调试入口：控制台执行 promptStudio.open() */
window.promptStudio = { open: openStudio, close: closeStudio, state, version: VERSION };

/* 调试用：地址栏带 ?ps=1 时自动打开面板 */
try {
  if (new URLSearchParams(location.search).has("ps")) {
    setTimeout(() => openStudio(null), 2600);
  }
} catch (e) {
  /* ignore */
}

/* 快捷键：Ctrl+Shift+P 打开 / 关闭 */
document.addEventListener(
  "keydown",
  (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "P" || e.key === "p")) {
      e.preventDefault();
      if (state.opened) closeStudio();
      else openStudio(null);
    }
  },
  true
);
