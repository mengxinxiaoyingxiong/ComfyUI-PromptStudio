"""
Prompt Studio backend for ComfyUI.
- 提供 danbooru / e621 标签检索（复用 webui tagcomplete 的 CSV 词库）
- 提供中文翻译检索（复用 danbooru.zh_CN_SFW.csv）
- 提供提示词分组词库（复用 sd-webui-prompt-all-in-one 的 group_tags）
- 提供预设提示词 / 收藏夹的持久化

本模块只做“数据服务”，不参与任何采样、不修改 CLIP 节点、不注入提示词。
"""

from __future__ import annotations

import csv
import io
import json
import os
import sys
import threading
import time
import traceback

from aiohttp import web
import aiohttp
import asyncio

try:  # ComfyUI 运行时一定存在，独立测试时可能不存在
    import folder_paths  # type: ignore
except Exception:  # pragma: no cover
    folder_paths = None

try:
    from server import PromptServer  # type: ignore
except Exception:  # pragma: no cover
    PromptServer = None


PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(PLUGIN_DIR, "data")
WEB_DIR = os.path.join(PLUGIN_DIR, "web")
ROUTE_PREFIX = "/prompt_studio"

VERSION = "1.0.0"

CSV_NAMES = {
    "danbooru": ["danbooru.csv"],
    "e621": ["e621.csv"],
    "merged": ["danbooru_e621_merged.csv"],
    "zh": ["danbooru.zh_CN_SFW.csv", "danbooru.zh_CN.csv"],
}

# 一键下载词库用（与 a1111-sd-webui-tagcomplete 同源，MIT）
TAG_SOURCES = {
    "danbooru": "https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/main/tags/danbooru.csv",
    "e621": "https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/main/tags/e621.csv",
    "merged": "https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/main/tags/danbooru_e621_merged.csv",
}


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def _log(msg: str) -> None:
    print(f"[PromptStudio] {msg}", flush=True)


def _comfy_root() -> str:
    if folder_paths is not None:
        try:
            return os.path.abspath(folder_paths.base_path)
        except Exception:
            pass
    return os.path.abspath(os.path.join(PLUGIN_DIR, "..", ".."))


def _user_dir() -> str:
    if folder_paths is not None:
        for attr in ("get_user_directory", "get_user_dir"):
            fn = getattr(folder_paths, attr, None)
            if callable(fn):
                try:
                    d = fn()
                    if d:
                        return os.path.abspath(d)
                except Exception:
                    pass
    return os.path.join(_comfy_root(), "user")


STATE_DIR = os.path.join(_user_dir(), "default", "prompt_studio")
try:  # ComfyUI 习惯把扩展数据放在 user/default 下
    os.makedirs(STATE_DIR, exist_ok=True)
except Exception:
    STATE_DIR = os.path.join(_user_dir(), "prompt_studio")
GROUPS_DEFAULT = os.path.join(DATA_DIR, "groups_zh.json")
GROUPS_USER = os.path.join(STATE_DIR, "groups.json")
PRESETS_FILE = os.path.join(STATE_DIR, "presets.json")
FAVORITES_FILE = os.path.join(STATE_DIR, "favorites.json")
CONFIG_FILE = os.path.join(DATA_DIR, "tags_config.json")

_LOCK = threading.RLock()
_INDEX_CACHE: dict[str, "TagIndex"] = {}
_ZH_CACHE: dict | None = None
_LOOKUP_CACHE: dict[str, tuple] | None = None
_SEARCH_CACHE: dict[str, dict] = {}


def _ensure_state_dir() -> None:
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
    except Exception:
        pass


def reset_caches() -> None:
    global _ZH_CACHE, _LOOKUP_CACHE
    with _LOCK:
        _INDEX_CACHE.clear()
        _ZH_CACHE = None
        _LOOKUP_CACHE = None
        _SEARCH_CACHE.clear()


def _read_text_any(path: str) -> str:
    """词库来源很杂（整合包里的 CSV 可能混入 GBK / Shift-JIS 字节），先严格 UTF-8，再按损坏率判断。"""
    try:
        with open(path, "r", encoding="utf-8-sig", newline="") as fh:
            return fh.read()
    except UnicodeDecodeError:
        pass
    except OSError:
        return ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as fh:
            text = fh.read()
        # 少量坏字节：UTF-8 容错解码即可，避免把整份文件误判成 GBK
        if text.count("\ufffd") <= max(8, len(text) // 4000):
            return text
    except OSError:
        return ""
    for enc in ("gb18030", "cp932", "big5"):
        try:
            with open(path, "r", encoding=enc, newline="") as fh:
                return fh.read()
        except UnicodeDecodeError:
            continue
        except OSError:
            return ""
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read()


def _csv_rows(path: str):
    return csv.reader(io.StringIO(_read_text_any(path)))


def _read_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            return json.load(fh)
    except Exception:
        return default


def _write_json(path: str, payload) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# 词库路径解析
# --------------------------------------------------------------------------- #
def _default_config() -> dict:
    return {
        "_comment": "自动探测 ComfyUI / WebUI 的 tagcomplete 词库目录；也可以把 CSV 放进 data/tags/，"
                    "或设置环境变量 PROMPT_STUDIO_TAG_DIR 指向你自己的目录。改完重启 ComfyUI。",
        "search_dirs": _candidate_tag_dirs(),
        "files": CSV_NAMES,
        "tag_sources": TAG_SOURCES,
    }


def _candidate_tag_dirs() -> list:
    """跨平台探测常见位置，不写死任何人的盘符。"""
    root = _comfy_root()
    dirs = [os.path.join(DATA_DIR, "tags")]

    env = os.environ.get("PROMPT_STUDIO_TAG_DIR")
    if env:
        dirs.append(env)

    bases = [root]
    base = root
    for _ in range(3):  # 向上找 3 层，覆盖 ComfyUI 与 WebUI 整合包同级的情况
        nxt = os.path.dirname(base)
        if not nxt or nxt == base:
            break
        base = nxt
        bases.append(base)

    rels = (
        os.path.join("extensions", "a1111-sd-webui-tagcomplete", "tags"),
        os.path.join("extensions", "sd-webui-tagcomplete", "tags"),
        os.path.join("extensions-builtin", "sd-webui-tagcomplete", "tags"),
        os.path.join("web", "extensions", "a1111-sd-webui-tagcomplete", "tags"),
        os.path.join("custom_nodes", "a1111-sd-webui-tagcomplete", "tags"),
    )

    # 先找标准 tagcomplete 词库目录（14 万条的完整版），再退回散落的 danbooru.csv
    for b in bases:
        for r in rels:
            dirs.append(os.path.join(b, r))

    # 同级目录里的 WebUI / Forge（例如 ComfyUI-aki 与 sd-forge-aki 并排）
    for b in bases:
        drive_tail = os.path.splitdrive(b)[1].strip("\\/")
        if not drive_tail:  # 盘符根目录不扫，避免无谓的 listdir
            continue
        try:
            entries = list(os.scandir(b))
        except OSError:
            continue
        for e in entries:
            if not e.is_dir() or e.name in ("node_modules", "__pycache__", "Windows", "System32"):
                continue
            for r in rels:
                dirs.append(os.path.join(e.path, r))

    for b in bases:
        dirs.append(b)

    dirs.append(os.path.join(os.path.expanduser("~"), "sd-webui", "extensions",
                             "a1111-sd-webui-tagcomplete", "tags"))

    seen, out = set(), []
    for d in dirs:
        key = os.path.normcase(os.path.abspath(d))
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def load_config() -> dict:
    cfg = _read_json(CONFIG_FILE, None)
    if not isinstance(cfg, dict) or not cfg.get("search_dirs"):
        cfg = _default_config()
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            _write_json(CONFIG_FILE, cfg)
        except Exception:
            pass
    return cfg


def resolve_tag_files() -> dict:
    """返回 {key: 绝对路径}，找不到的键不出现。"""
    cfg = load_config()
    found: dict[str, str] = {}
    dirs = [d for d in cfg.get("search_dirs", []) if isinstance(d, str)]
    names = dict(CSV_NAMES)
    names.update({k: v for k, v in (cfg.get("files") or {}).items() if k in CSV_NAMES})

    for key, wanted in names.items():
        if not isinstance(wanted, (list, tuple)):
            wanted = [wanted]
        done = False
        for d in dirs:
            if done:
                break
            # 目录型入口
            if d.lower().endswith(".csv"):
                base_dir, base_name = os.path.dirname(d), os.path.basename(d)
                for w in wanted:
                    if os.path.basename(str(w)).lower() == base_name.lower() and os.path.isfile(d):
                        found[key] = d
                        done = True
                        break
                continue
            for w in wanted:
                for cand in (
                    os.path.join(d, str(w)),
                    os.path.join(d, "tags", str(w)),
                ):
                    if os.path.isfile(cand):
                        found[key] = cand
                        done = True
                        break
                if done:
                    break
    return found


# --------------------------------------------------------------------------- #
# 索引
# --------------------------------------------------------------------------- #
class TagIndex:
    """一条 CSV 对应一个索引，内存里存平行数组，检索时线性扫描。"""

    __slots__ = ("path", "source", "names", "cats", "counts", "hay", "lower", "loaded_ms")

    def __init__(self, path: str, source: str):
        self.path = path
        self.source = source
        self.names: list[str] = []
        self.cats: list[int] = []
        self.counts: list[int] = []
        self.hay: list[str] = []
        self.lower: list[str] = []
        self.loaded_ms = 0
        self._load()

    def _load(self) -> None:
        t0 = time.time()
        names, cats, counts, hay, lower = [], [], [], [], []
        reader = _csv_rows(self.path)
        for row in reader:
            if not row:
                continue
            name = row[0].strip()
            if not name:
                continue
            try:
                cat = int(row[1]) if len(row) > 1 and row[1] != "" else 0
            except Exception:
                cat = 0
            try:
                cnt = int(row[2]) if len(row) > 2 and row[2] != "" else 0
            except Exception:
                cnt = 0
            alias = row[3] if len(row) > 3 else ""
            low = name.lower()
            names.append(name)
            cats.append(cat)
            counts.append(cnt)
            lower.append(low)
            hay.append(low + "\x00" + alias.lower() if alias else low)
        self.names = names
        self.cats = cats
        self.counts = counts
        self.hay = hay
        self.lower = lower
        self.loaded_ms = int((time.time() - t0) * 1000)
        _log(f"索引 {os.path.basename(self.path)} 载入 {len(names)} 条 / {self.loaded_ms} ms")

    def search(self, q: str, cats: set[int] | None, limit: int):
        ql = q.lower().strip()
        if not ql:
            return []
        hits: list[tuple] = []
        append = hits.append
        lower = self.lower
        for i, h in enumerate(self.hay):
            if ql in h:
                nl = lower[i]
                if nl == ql:
                    score = 4
                elif nl.startswith(ql):
                    score = 3
                elif ql in nl:
                    score = 2
                else:
                    score = 1
                append((score, self.counts[i], i))
                if len(hits) >= 4000:
                    break
        strong = [x for x in hits if x[0] >= 2]
        pool = strong if len(strong) >= limit else hits
        pool.sort(key=lambda t: (t[0], t[1]), reverse=True)
        out = []
        for score, cnt, i in pool:
            if cats and self.cats[i] not in cats:
                continue
            out.append((self.names[i], self.cats[i], cnt))
            if len(out) >= limit:
                break
        return out


def get_index(key: str) -> TagIndex | None:
    files = resolve_tag_files()
    path = files.get(key)
    if not path:
        return None
    with _LOCK:
        idx = _INDEX_CACHE.get(path)
        if idx is None:
            try:
                idx = TagIndex(path, key)
            except Exception:
                _log("载入失败: " + traceback.format_exc())
                return None
            _INDEX_CACHE[path] = idx
        return idx


def get_zh_map() -> dict:
    global _ZH_CACHE
    with _LOCK:
        if _ZH_CACHE is not None:
            return _ZH_CACHE
        files = resolve_tag_files()
        path = files.get("zh")
        mapping: dict[str, str] = {}
        if path:
            try:
                reader = _csv_rows(path)
                for row in reader:
                    if len(row) >= 2 and row[0].strip():
                        mapping[row[0].strip()] = row[1].strip()
                _log(f"中文对照载入 {len(mapping)} 条")
            except Exception:
                _log("中文对照载入失败: " + traceback.format_exc())
        _ZH_CACHE = mapping
        return _ZH_CACHE


def get_lookup() -> dict:
    """name -> (cat, count)，用于给提示词标签上色。"""
    global _LOOKUP_CACHE
    with _LOCK:
        if _LOOKUP_CACHE is not None:
            return _LOOKUP_CACHE
        table: dict[str, tuple] = {}
        for key in ("danbooru", "e621", "merged"):
            idx = get_index(key)
            if idx is None:
                continue
            for i, n in enumerate(idx.names):
                if n not in table:
                    table[n] = (idx.cats[i], idx.counts[i])
        _LOOKUP_CACHE = table
        return table


# --------------------------------------------------------------------------- #
# 中文检索
# --------------------------------------------------------------------------- #
def search_zh(q: str, limit: int):
    zh = get_zh_map()
    lookup = get_lookup()
    q = q.strip()
    hits = []
    for tag, cn in zh.items():
        if q in cn or q in tag:
            if cn == q:
                score = 4
            elif cn.startswith(q):
                score = 3
            elif q in cn:
                score = 2
            else:
                score = 1
            hits.append((score, lookup.get(tag, (0, 0))[1], tag, cn))
            if len(hits) >= 4000:
                break
    hits.sort(key=lambda t: (t[0], t[1]), reverse=True)
    out = []
    for score, cnt, tag, cn in hits:
        cat = lookup.get(tag, (0, 0))[0]
        out.append((tag, cat, cnt, cn))
        if len(out) >= limit:
            break
    return out


# --------------------------------------------------------------------------- #
# 检索入口
# --------------------------------------------------------------------------- #
def do_search(q: str, source: str, cats: set[int] | None, limit: int) -> dict:
    key = f"{source}|{q}|{','.join(map(str, sorted(cats or [])))}|{limit}"
    cached = _SEARCH_CACHE.get(key)
    if cached is not None:
        return cached

    t0 = time.time()
    zh = get_zh_map()
    rows: list[list] = []
    total = 0

    if source in ("danbooru", "e621"):
        idx = get_index(source)
        if idx is not None:
            got = idx.search(q, cats, limit)
            total = len(got)
            rows = [[n, c, p, zh.get(n, ""), source] for n, c, p in got]
    else:  # both：两个词库分别检索后合并，保留各自来源与分类编号
        d = get_index("danbooru")
        e = get_index("e621")
        if d is None and e is None:
            merged = get_index("merged")
            if merged is not None:
                for n, c, p in merged.search(q, cats, limit):
                    rows.append([n, c, p, zh.get(n, ""), "danbooru"])
                total = len(rows)
        else:
            pool: dict[str, list] = {}
            for idx, src in ((d, "danbooru"), (e, "e621")):
                if idx is None:
                    continue
                for n, c, p in idx.search(q, cats, limit):
                    old = pool.get(n)
                    if old is None:
                        pool[n] = [n, c, p, zh.get(n, ""), src]
                    elif p > old[2]:
                        old[1], old[2] = c, p
            rows = sorted(pool.values(), key=lambda r: r[2], reverse=True)[:limit]
            total = len(rows)

    if _is_cjk(q):
        seen = {r[0] for r in rows}
        for n, c, p, cn in search_zh(q, limit):
            if n in seen:
                continue
            rows.append([n, c, p, cn, "zh"])
            if len(rows) >= limit:
                break

    payload = {"q": q, "source": source, "total": len(rows), "tags": rows,
               "ms": int((time.time() - t0) * 1000)}
    if len(_SEARCH_CACHE) > 400:
        _SEARCH_CACHE.clear()
    _SEARCH_CACHE[key] = payload
    return payload


_E621_HINT = ("anthro", "feral", "genital", "penis", "vagina", "yiff", "furry",
              "dick", "pussy", "cum", "knot", "sheath", "cloaca", "taur")


def _looks_like_e621(name: str) -> bool:
    n = name.lower()
    return any(h in n for h in _E621_HINT)


def _is_cjk(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in text)


# --------------------------------------------------------------------------- #
# 状态 / 预设 / 收藏
# --------------------------------------------------------------------------- #
def _default_presets() -> dict:
    seed_path = os.path.join(DATA_DIR, "presets.default.json")
    seed = _read_json(seed_path, None)
    if isinstance(seed, dict) and seed.get("items"):
        return seed
    return {"version": 1, "items": [
        {"id": "p_base", "name": "基础起手式",
         "prompt": "masterpiece, best quality,",
         "negative": "lowres, bad anatomy, bad hands, text, error, missing fingers, "
                     "extra digit, fewer digits, cropped, worst quality, low quality, "
                     "normal quality, jpeg artifacts, signature, watermark, username, blurry"},
    ]}


def load_presets() -> dict:
    _ensure_state_dir()
    data = _read_json(PRESETS_FILE, None)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        data = _default_presets()
        try:
            _write_json(PRESETS_FILE, data)
        except Exception:
            pass
    return data


def load_favorites() -> list:
    _ensure_state_dir()
    data = _read_json(FAVORITES_FILE, None)
    if isinstance(data, dict) and isinstance(data.get("tags"), list):
        return data["tags"]
    if isinstance(data, list):
        return data
    return []


def stats() -> dict:
    files = resolve_tag_files()
    rows = {}
    for key, path in files.items():
        try:
            idx = get_index(key) if key != "zh" else None
            rows[key] = {"path": path, "rows": len(idx.names) if idx else None}
        except Exception:
            rows[key] = {"path": path, "rows": None}
    return {
        "version": VERSION,
        "plugin_dir": PLUGIN_DIR,
        "state_dir": STATE_DIR,
        "comfy_root": _comfy_root(),
        "tag_files": rows,
        "zh_rows": len(get_zh_map()),
        "groups_default": os.path.isfile(GROUPS_DEFAULT),
        "groups_user": os.path.isfile(GROUPS_USER),
        "presets": len(load_presets().get("items", [])),
        "favorites": len(load_favorites()),
        "python": sys.version.split()[0],
    }


# --------------------------------------------------------------------------- #
# HTTP 路由
# --------------------------------------------------------------------------- #
def _json(data, status: int = 200):
    return web.json_response(data, status=status, dumps=lambda o: json.dumps(o, ensure_ascii=False))


async def api_status(request: web.Request):
    try:
        return _json({"ok": True, "data": stats()})
    except Exception:
        return _json({"ok": False, "error": traceback.format_exc()}, 500)


async def api_tags(request: web.Request):
    try:
        q = (request.query.get("q") or "").strip()
        source = (request.query.get("source") or "danbooru").lower()
        if source not in ("danbooru", "e621", "both"):
            source = "danbooru"
        try:
            limit = max(1, min(300, int(request.query.get("limit") or 80)))
        except Exception:
            limit = 80
        cats_raw = (request.query.get("cats") or "").strip()
        cats = None
        if cats_raw:
            try:
                cats = {int(x) for x in cats_raw.split(",") if x != ""}
            except Exception:
                cats = None
        if not q:
            return _json({"q": "", "source": source, "total": 0, "tags": [], "ms": 0})
        return _json({"ok": True, **do_search(q, source, cats, limit)})
    except Exception:
        return _json({"ok": False, "error": traceback.format_exc()}, 500)


async def api_lookup(request: web.Request):
    try:
        names = (request.query.get("names") or "").split(",")
        lookup = get_lookup()
        zh = get_zh_map()
        out = {}
        for raw in names[:400]:
            n = raw.strip()
            if not n:
                continue
            hit = lookup.get(n)
            out[n] = {
                "cat": hit[0] if hit else -1,
                "count": hit[1] if hit else 0,
                "zh": zh.get(n, ""),
            }
        return _json({"ok": True, "tags": out})
    except Exception:
        return _json({"ok": False, "error": traceback.format_exc()}, 500)


async def api_groups_get(request: web.Request):
    try:
        if os.path.isfile(GROUPS_USER):
            data = _read_json(GROUPS_USER, None)
            if isinstance(data, dict) and data.get("groups"):
                data.setdefault("source", "user")
                return _json({"ok": True, "data": data})
        data = _read_json(GROUPS_DEFAULT, {"groups": []})
        return _json({"ok": True, "data": data})
    except Exception:
        return _json({"ok": False, "error": traceback.format_exc()}, 500)


async def api_groups_post(request: web.Request):
    try:
        body = await request.json()
        groups = body.get("groups")
        if not isinstance(groups, list):
            return _json({"ok": False, "error": "groups 必须是数组"}, 400)
        _ensure_state_dir()
        _write_json(GROUPS_USER, {"source": "user", "version": 1, "groups": groups})
        return _json({"ok": True, "count": len(groups)})
    except Exception:
        return _json({"ok": False, "error": traceback.format_exc()}, 500)


async def api_groups_reset(request: web.Request):
    try:
        if os.path.isfile(GROUPS_USER):
            os.remove(GROUPS_USER)
        return _json({"ok": True})
    except Exception:
        return _json({"ok": False, "error": traceback.format_exc()}, 500)


async def api_presets_get(request: web.Request):
    try:
        return _json({"ok": True, "data": load_presets()})
    except Exception:
        return _json({"ok": False, "error": traceback.format_exc()}, 500)


async def api_presets_post(request: web.Request):
    try:
        body = await request.json()
        items = body.get("items")
        if not isinstance(items, list):
            return _json({"ok": False, "error": "items 必须是数组"}, 400)
        clean = []
        for it in items:
            if not isinstance(it, dict):
                continue
            name = str(it.get("name") or "").strip()
            if not name:
                continue
            clean.append({
                "id": str(it.get("id") or f"p_{int(time.time() * 1000)}_{len(clean)}"),
                "name": name,
                "prompt": str(it.get("prompt") or ""),
                "negative": str(it.get("negative") or ""),
            })
        _ensure_state_dir()
        _write_json(PRESETS_FILE, {"version": 1, "items": clean})
        return _json({"ok": True, "count": len(clean)})
    except Exception:
        return _json({"ok": False, "error": traceback.format_exc()}, 500)


async def api_favorites_get(request: web.Request):
    try:
        return _json({"ok": True, "tags": load_favorites()})
    except Exception:
        return _json({"ok": False, "error": traceback.format_exc()}, 500)


async def api_favorites_post(request: web.Request):
    try:
        body = await request.json()
        tags = body.get("tags")
        if not isinstance(tags, list):
            return _json({"ok": False, "error": "tags 必须是数组"}, 400)
        clean = []
        for t in tags:
            s = str(t).strip()
            if s and s not in clean:
                clean.append(s)
        _ensure_state_dir()
        _write_json(FAVORITES_FILE, {"tags": clean[:3000]})
        return _json({"ok": True, "count": len(clean)})
    except Exception:
        return _json({"ok": False, "error": traceback.format_exc()}, 500)


async def _download_one(session: aiohttp.ClientSession, key: str, url: str) -> dict:
    name = os.path.basename(url.split("?")[0]) or f"{key}.csv"
    dest = os.path.join(DATA_DIR, "tags", name)
    try:
        _log(f"开始下载词库 {key}: {url}")
        async with session.get(url) as resp:
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
            data = await resp.read()
        if len(data) < 20000:
            raise RuntimeError(f"下载内容过小（{len(data)} 字节）")
        if "," not in data[:400].decode("utf-8", errors="replace"):
            raise RuntimeError("返回内容不像 CSV")
        tmp = dest + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, dest)
        _log(f"词库已下载 {name} ({len(data)} 字节)")
        return {"ok": True, "path": dest, "bytes": len(data)}
    except Exception as exc:
        _log(f"词库下载失败 {key}: {exc}")
        return {"ok": False, "error": str(exc), "url": url}


async def api_download_tags(request: web.Request):
    """从 tagcomplete 仓库下载 danbooru / e621 词库到 data/tags/。"""
    try:
        try:
            body = await request.json()
        except Exception:
            body = {}
        cfg = load_config()
        sources = dict(TAG_SOURCES)
        if isinstance(cfg.get("tag_sources"), dict):
            sources.update({k: v for k, v in cfg["tag_sources"].items()
                            if isinstance(v, str) and v.strip()})
        keys = body.get("keys") or ["danbooru", "e621"]
        if not isinstance(keys, list):
            return _json({"ok": False, "error": "keys 必须是数组"}, 400)
        keys = [str(k) for k in keys if str(k) in sources]
        if not keys:
            return _json({"ok": False, "error": "没有可下载的词库，请在 tags_config.json 里配置 tag_sources"}, 400)

        os.makedirs(os.path.join(DATA_DIR, "tags"), exist_ok=True)
        timeout = aiohttp.ClientTimeout(total=240, connect=20, sock_read=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            results = await asyncio.gather(*[_download_one(session, key, sources[key]) for key in keys])
        reset_caches()
        warmup_async()
        return _json({"ok": True, "results": dict(zip(keys, results))})
    except Exception:
        return _json({"ok": False, "error": traceback.format_exc()}, 500)


def register_routes() -> bool:
    if PromptServer is None or getattr(PromptServer, "instance", None) is None:
        _log("未找到 PromptServer，跳过路由注册（独立模式）")
        return False
    routes = PromptServer.instance.routes
    routes.get(ROUTE_PREFIX + "/status")(api_status)
    routes.get(ROUTE_PREFIX + "/tags")(api_tags)
    routes.get(ROUTE_PREFIX + "/lookup")(api_lookup)
    routes.get(ROUTE_PREFIX + "/groups")(api_groups_get)
    routes.post(ROUTE_PREFIX + "/groups")(api_groups_post)
    routes.post(ROUTE_PREFIX + "/groups/reset")(api_groups_reset)
    routes.get(ROUTE_PREFIX + "/presets")(api_presets_get)
    routes.post(ROUTE_PREFIX + "/presets")(api_presets_post)
    routes.get(ROUTE_PREFIX + "/favorites")(api_favorites_get)
    routes.post(ROUTE_PREFIX + "/favorites")(api_favorites_post)
    routes.post(ROUTE_PREFIX + "/download_tags")(api_download_tags)
    _log(f"路由已注册 {ROUTE_PREFIX}/* v{VERSION}")
    return True


def warmup_async() -> None:
    """后台预热，避免第一次检索卡住 UI。"""

    def _run():
        try:
            files = resolve_tag_files()
            _log("词库: " + json.dumps({k: os.path.basename(v) for k, v in files.items()}, ensure_ascii=False))
            get_zh_map()
            for key in ("danbooru", "e621"):
                if key in files:
                    get_index(key)
            get_lookup()
            load_presets()
        except Exception:
            _log("预热失败: " + traceback.format_exc())

    threading.Thread(target=_run, name="PromptStudioWarmup", daemon=True).start()


register_routes()
