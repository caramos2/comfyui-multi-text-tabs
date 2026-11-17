/**
 * Multi-Text Tabs - 标签状态管理器。
 *
 * 本模块刻意不依赖任何 DOM 或 ComfyUI 接口，因此可以用纯 Node 直接
 * 做单元测试（见 tests/frontend/）。
 *
 * 完整标签集合存放在单个节点属性里：
 *
 *   node.properties.multi_text_tabs = {
 *     version: 1,
 *     active_id: "tab_001",
 *     tabs: [ { id, title, content }, ... ]
 *   }
 *
 * 这里实现的规则（技术蓝图 §3.4、§6.3、§7）：
 *   - id 唯一且稳定；
 *   - 永远至少存在一个标签；
 *   - 正文永远是字符串；
 *   - 状态损坏或缺失时做修复，而不是抛异常。
 */

/** 标签集合在 node.properties 中的存放键名。 */
export const STORAGE_KEY = "multi_text_tabs";

/** 标签集合当前的数据结构版本号。 */
export const SCHEMA_VERSION = 1;

/** 自动生成标签标题时使用的前缀。 */
export const TITLE_PREFIX = "待命文本";

/** 数据中保留的标题最大长度（显示时还会进一步截断）。 */
export const MAX_TITLE_LENGTH = 120;

/**
 * 用于识别某一份状态实例的、不可枚举的标记名。
 *
 * 为什么需要它：ComfyUI 前端把 node.properties 放在 Vue reactive 对象里，
 * 所以读回来的是所写对象的 reactive *代理*，永远不是同一个对象。
 * 于是用 "===" 比较两个状态永远不成立，每次读取都像是一份全新的状态，
 * 而对先前取到的状态所做的任何修改，都会被写进一个节点早已不再引用的对象。
 *
 * 标记能穿透代理，因此它提供了稳定的身份标识。它不可枚举，
 * 所以绝不会出现在工作流文件里。
 */
export const STATE_MARKER = "__mtt_state_marker";

let markerCounter = 0;

/** 生成一个新的标记值。 */
export function createStateMarker() {
    markerCounter += 1;
    return "mtt-" + Date.now().toString(36) + "-" + markerCounter;
}

/**
 * 给状态对象挂上标记。
 *
 * @param {object} state        要打标记的状态
 * @param {string} [marker]     复用的标记；不传则新铸一个
 */
export function attachStateMarker(state, marker) {
    if (!state || typeof state !== "object") {
        return state;
    }
    Object.defineProperty(state, STATE_MARKER, {
        value: typeof marker === "string" && marker ? marker : createStateMarker(),
        enumerable: false,
        writable: true,
        configurable: true,
    });
    return state;
}

/** 取状态对象上的标记；没有则返回 null。 */
export function readStateMarker(state) {
    if (!state || typeof state !== "object") {
        return null;
    }
    const marker = state[STATE_MARKER];
    return typeof marker === "string" ? marker : null;
}

let idCounter = 0;

/**
 * 生成一个 usedIds 里没有的 id。
 * id 形如 "tab_001"，并在标签的整个生命周期内保持稳定。
 */
export function createTabId(usedIds) {
    const used = usedIds instanceof Set ? usedIds : new Set(usedIds || []);
    let candidate;
    do {
        idCounter += 1;
        candidate = "tab_" + String(idCounter).padStart(3, "0");
    } while (used.has(candidate));
    return candidate;
}

/**
 * 规范化用户给的标题：去空白，为空时回退，并限制长度上限。
 */
export function sanitizeTitle(raw, fallback) {
    let title = typeof raw === "string" ? raw.trim() : "";
    if (!title) {
        title = typeof fallback === "string" && fallback ? fallback : TITLE_PREFIX + " 1";
    }
    if (title.length > MAX_TITLE_LENGTH) {
        title = title.slice(0, MAX_TITLE_LENGTH);
    }
    return title;
}

/**
 * 下一个自动标题，例如 "Text 2"。
 * 从 tabs.length + 1 开始，并跳过已被占用的名字，
 * 这样用户已经见过的编号绝不会被悄悄重复使用。
 */
export function nextAutoTitle(titles) {
    const used = new Set((titles || []).map((t) => (typeof t === "string" ? t.trim() : "")));
    let n = (titles || []).length + 1;
    while (used.has(TITLE_PREFIX + " " + n)) {
        n += 1;
    }
    return TITLE_PREFIX + " " + n;
}

/**
 * 给标题加一个计数后缀使其唯一："Text 1"、"Text 1 (2)"、……
 */
export function uniqueTitle(base, titles) {
    const used = new Set((titles || []).map((t) => (typeof t === "string" ? t.trim() : "")));
    const root = typeof base === "string" && base.trim() ? base.trim() : TITLE_PREFIX;
    if (!used.has(root)) {
        return root;
    }
    let n = 2;
    while (used.has(root + " (" + n + ")")) {
        n += 1;
    }
    return root + " (" + n + ")";
}

/** 一份全新的状态，只含一个空标签。 */
export function defaultState(fallbackContent) {
    const content = typeof fallbackContent === "string" ? fallbackContent : "";
    return attachStateMarker({
        version: SCHEMA_VERSION,
        active_id: "tab_001",
        tabs: [{ id: "tab_001", title: TITLE_PREFIX + " 1", content }],
    });
}

/**
 * 把 node.properties 里现有的任何东西修复成一份有效状态。
 *
 * @param {*} raw            node.properties 里存的原始值
 * @param {string} fallbackContent  没有可用状态时使用的文本
 * @returns {{state: object, issues: string[]}} 修复后的状态，外加一份
 *          人类可读的问题清单，列出所有被修复的地方。
 */
export function normalizeState(raw, fallbackContent) {
    const issues = [];
    const fallback = typeof fallbackContent === "string" ? fallbackContent : "";

    if (raw === null || raw === undefined) {
        return { state: defaultState(fallback), issues: ["no stored state"] };
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        return { state: defaultState(fallback), issues: ["stored state is not an object"] };
    }
    if (typeof raw.version === "number" && raw.version > SCHEMA_VERSION) {
        issues.push("unknown schema version " + raw.version + ", kept readable fields");
    }
    if (!Array.isArray(raw.tabs)) {
        return { state: defaultState(fallback), issues: issues.concat(["tabs is not an array"]) };
    }
    if (raw.tabs.length === 0) {
        return { state: defaultState(fallback), issues: issues.concat(["tabs is empty"]) };
    }

    // 第一遍 —— id 必须存在，且必须唯一。
    const usedIds = new Set();
    const staged = raw.tabs.map((rawTab) => {
        const tab = rawTab && typeof rawTab === "object" ? rawTab : {};
        let id = typeof tab.id === "string" ? tab.id.trim() : "";
        if (!id) {
            id = createTabId(usedIds);
            issues.push("tab without id received id " + id);
        } else if (usedIds.has(id)) {
            const replacement = createTabId(usedIds);
            issues.push("duplicate id " + id + " was reassigned to " + replacement);
            id = replacement;
        }
        usedIds.add(id);
        return { id: id, title: tab.title, content: tab.content };
    });

    // 第二遍 —— 标题必须是非空字符串。
    const titles = [];
    staged.forEach((tab) => {
        const fallbackTitle = nextAutoTitle(titles);
        const title = sanitizeTitle(tab.title, fallbackTitle);
        titles.push(title);
        tab.title = title;
    });

    // 第三遍 —— 正文必须是字符串。
    staged.forEach((tab) => {
        if (typeof tab.content !== "string") {
            issues.push("tab " + tab.id + " had non string content, reset to empty");
            tab.content = "";
        }
    });

    const state = { version: SCHEMA_VERSION, active_id: "", tabs: staged };
    const wanted = typeof raw.active_id === "string" ? raw.active_id : "";
    if (staged.some((tab) => tab.id === wanted)) {
        state.active_id = wanted;
    } else {
        state.active_id = staged[0].id;
        if (wanted) {
            issues.push("active_id " + wanted + " does not exist, fell back to " + state.active_id);
        }
    }
    // 修复后的状态仍然是同一份状态，所以它保留自己的标记。
    return { state: attachStateMarker(state, readStateMarker(raw)), issues: issues };
}

/**
 * 给自动命名的文本重新编号，让编号保持连续。
 *
 * 只有看起来仍像 "待命文本 3" 的标题会被改动 —— 用户改过名的文本
 * 保留自己的名字。
 */
export function renumberAutoTitles(state) {
    const pattern = new RegExp("^" + TITLE_PREFIX + "\\s+\\d+$");
    state.tabs.forEach((tab, index) => {
        if (typeof tab.title === "string" && pattern.test(tab.title.trim())) {
            // 列表里第 n 条文本就叫 "待命文本 n"。
            const wanted = TITLE_PREFIX + " " + (index + 1);
            if (tab.title.trim() !== wanted) {
                tab.title = wanted;
            }
        }
    });
    return state;
}

/** 状态的深拷贝（节点被复制时使用）。 */
export function cloneState(state) {
    // 副本是一份独立的状态，所以它有自己的标记。
    return attachStateMarker({
        version: state.version,
        active_id: state.active_id,
        tabs: state.tabs.map((tab) => ({
            id: tab.id,
            title: tab.title,
            content: tab.content,
        })),
    });
}

/** 按 id 查找标签。 */
export function getTab(state, id) {
    if (!state || !Array.isArray(state.tabs)) {
        return null;
    }
    return state.tabs.find((tab) => tab.id === id) || null;
}

/** 当前正在编辑正文的那个标签。 */
export function getActiveTab(state) {
    return getTab(state, state && state.active_id);
}

/** 切换活动标签。id 未知时返回 false。 */
export function setActiveTab(state, id) {
    if (!getTab(state, id)) {
        return false;
    }
    state.active_id = id;
    return true;
}

/**
 * 新建一个标签。
 *
 * @param {object} state
 * @param {{title?: string, content?: string, activate?: boolean}} options
 */
export function addTab(state, options) {
    const opts = options || {};
    const usedIds = new Set(state.tabs.map((tab) => tab.id));
    const id = createTabId(usedIds);
    const titles = state.tabs.map((tab) => tab.title);
    const title = opts.title
        ? sanitizeTitle(opts.title, nextAutoTitle(titles))
        : nextAutoTitle(titles);
    const tab = {
        id: id,
        title: title,
        content: typeof opts.content === "string" ? opts.content : "",
    };
    state.tabs.push(tab);
    if (opts.activate !== false) {
        state.active_id = id;
    }
    return tab;
}

/** 重命名标签。正文内容永远不动。 */
export function renameTab(state, id, title) {
    const tab = getTab(state, id);
    if (!tab) {
        return null;
    }
    const others = state.tabs.filter((t) => t.id !== id).map((t) => t.title);
    tab.title = uniqueTitle(sanitizeTitle(title, tab.title), others);
    return tab;
}

/**
 * 复制一个标签：标题沿用同样的命名方式，正文相同，id 是新的。
 * 副本会成为当前活动标签。
 */
export function duplicateTab(state, id) {
    const source = getTab(state, id);
    if (!source) {
        return null;
    }
    const usedIds = new Set(state.tabs.map((tab) => tab.id));
    const newId = createTabId(usedIds);
    const titles = state.tabs.map((tab) => tab.title);
    const copy = {
        id: newId,
        title: uniqueTitle(sanitizeTitle(source.title + " Copy", source.title), titles),
        content: source.content,
    };
    const index = state.tabs.findIndex((tab) => tab.id === id);
    state.tabs.splice(index + 1, 0, copy);
    state.active_id = newId;
    return copy;
}

/**
 * 关闭一个标签。最后剩下的那一个永远不会被关掉。
 * 关掉的是活动标签时，下一个标签成为活动项（若关掉的是最后一个，
 * 则由上一个接管）。
 */
export function closeTab(state, id) {
    const index = state.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
        return { closed: false, reason: "unknown tab" };
    }
    if (state.tabs.length === 1) {
        return { closed: false, reason: "last tab is kept" };
    }
    const removed = state.tabs.splice(index, 1)[0];
    let activated = null;
    if (state.active_id === id) {
        const next = state.tabs[index] || state.tabs[index - 1] || state.tabs[0];
        state.active_id = next.id;
        activated = next.id;
    }
    // 回报原始位置，这样撤销时能把标签放回用户原来摆的地方。
    return { closed: true, removed: removed, activated: activated, index: index };
}

/** 把新文本存进当前活动标签。 */
export function setActiveContent(state, content) {
    const tab = getActiveTab(state);
    if (!tab) {
        return false;
    }
    tab.content = typeof content === "string" ? content : "";
    return true;
}

/** 全部标签的标题，按显示顺序排列。 */
export function tabTitles(state) {
    return state.tabs.map((tab) => tab.title);
}
