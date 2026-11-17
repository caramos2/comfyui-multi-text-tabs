/**
 * 多文本标签前端扩展的假 DOM 测试台。
 *
 *     node tests/frontend/check_extension.mjs
 *
 * 真正的扩展文件会在 node:vm 上下文里针对一个有边界的假 DOM 执行。
 * 不需要浏览器，不需要网络，也不需要 ComfyUI 运行时 —— 但被测代码就是
 * 发布出去的那个文件，而不是它的副本。
 *
 * 这里验证的内容：
 *   - 输入被重新声明为自定义控件类型；
 *   - 节点最终只带一个名为 "active_content" 的控件；
 *   - 控件值始终等于编辑器里的实时文本；
 *   - 输入、切换、新增、关闭、重命名和复制都能正常工作；
 *   - 标签集合能经得住一次保存 / 加载往返。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "..", "..", "web");
const statePath = resolve(webDir, "multi_text_tabs_state.js");
const extensionPath = resolve(webDir, "multi_text_tabs.js");

/* ------------------------------------------------------------------ */
/* 小型假 DOM                                                          */
/* ------------------------------------------------------------------ */

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseSelector(selector) {
    const match = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|\[[^\]]*\])*)$/.exec(String(selector).trim());
    if (!match) {
        return null;
    }
    const classes = [];
    const attrs = [];
    const rest = match[2] || "";
    const re = /\.([\w-]+)|\[([^\]]*)\]/g;
    let part;
    while ((part = re.exec(rest)) !== null) {
        if (part[1]) {
            classes.push(part[1]);
        } else {
            const body = part[2];
            const eq = body.indexOf("=");
            if (eq === -1) {
                attrs.push([body.trim(), null]);
            } else {
                let value = body.slice(eq + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                attrs.push([body.slice(0, eq).trim(), value]);
            }
        }
    }
    return { tag: match[1] ? match[1].toLowerCase() : null, classes, attrs };
}

function attrValue(el, name) {
    if (name.startsWith("data-")) {
        const value = el.dataset[camel(name.slice(5))];
        return value === undefined ? null : String(value);
    }
    return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null;
}

function matches(el, selector) {
    const parsed = parseSelector(selector);
    if (!parsed) {
        return false;
    }
    if (parsed.tag && el.tagName.toLowerCase() !== parsed.tag) {
        return false;
    }
    for (const cls of parsed.classes) {
        if (!el.classList.contains(cls)) {
            return false;
        }
    }
    for (const [name, value] of parsed.attrs) {
        const actual = attrValue(el, name);
        if (value === null) {
            if (actual === null) {
                return false;
            }
        } else if (actual !== value) {
            return false;
        }
    }
    return true;
}

class FakeClassList {
    constructor(element) {
        this.element = element;
        this.items = new Set();
    }
    add(...names) {
        names.forEach((name) => this.items.add(name));
        this.sync();
    }
    remove(...names) {
        names.forEach((name) => this.items.delete(name));
        this.sync();
    }
    contains(name) {
        return this.items.has(name);
    }
    sync() {
        this.element.attributes.class = Array.from(this.items).join(" ");
    }
}

class FakeElement {
    constructor(tagName, registry) {
        this.tagName = String(tagName || "div").toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.dataset = {};
        this.style = {};
        this.listeners = new Map();
        this.classList = new FakeClassList(this);
        this.hidden = false;
        this.value = "";
        this.title = "";
        this.type = "";
        this.spellcheck = true;
        this.text = "";
        this.focused = false;
        this.registry = registry;
        if (registry) {
            registry.push(this);
        }
    }
    get className() {
        return Array.from(this.classList.items).join(" ");
    }
    set className(value) {
        this.classList.items = new Set(String(value).split(/\s+/).filter(Boolean));
        this.classList.sync();
    }
    get firstChild() {
        return this.children[0] || null;
    }
    get childNodes() {
        return this.children.slice();
    }
    get textContent() {
        if (this.children.length === 0) {
            return this.text;
        }
        return this.children.map((child) => child.textContent).join("");
    }
    set textContent(value) {
        this.children.slice().forEach((child) => child.remove());
        this.text = value === undefined || value === null ? "" : String(value);
    }
    appendChild(child) {
        if (child.parentNode) {
            child.parentNode.removeChild(child);
        }
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    insertBefore(child, reference) {
        if (child.parentNode) {
            child.parentNode.removeChild(child);
        }
        const index = reference ? this.children.indexOf(reference) : -1;
        if (index === -1) {
            this.children.push(child);
        } else {
            this.children.splice(index, 0, child);
        }
        child.parentNode = this;
        return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index !== -1) {
            this.children.splice(index, 1);
            child.parentNode = null;
        }
        return child;
    }
    remove() {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    }
    contains(node) {
        let current = node;
        while (current) {
            if (current === this) {
                return true;
            }
            current = current.parentNode;
        }
        return false;
    }
    descendants() {
        const out = [];
        const walk = (node) => {
            node.children.forEach((child) => {
                out.push(child);
                walk(child);
            });
        };
        walk(this);
        return out;
    }
    querySelectorAll(selector) {
        return this.descendants().filter((el) => matches(el, selector));
    }
    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }
    closest(selector) {
        let current = this;
        while (current) {
            if (current.matches && current.matches(selector)) {
                return current;
            }
            current = current.parentNode;
        }
        return null;
    }
    matches(selector) {
        return matches(this, selector);
    }
    setAttribute(name, value) {
        if (name.startsWith("data-")) {
            this.dataset[camel(name.slice(5))] = String(value);
        } else {
            this.attributes[name] = String(value);
        }
    }
    getAttribute(name) {
        return attrValue(this, name);
    }
    removeAttribute(name) {
        if (name.startsWith("data-")) {
            delete this.dataset[camel(name.slice(5))];
        } else {
            delete this.attributes[name];
        }
    }
    addEventListener(type, callback, capture) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, []);
        }
        this.listeners.get(type).push({ callback, capture: Boolean(capture) });
    }
    removeEventListener(type, callback) {
        const list = this.listeners.get(type) || [];
        const index = list.findIndex((entry) => entry.callback === callback);
        if (index !== -1) {
            list.splice(index, 1);
        }
    }
    dispatchEvent(event) {
        event.target = event.target || this;
        event.stopped = false;
        event.stopPropagation = () => {
            event.stopped = true;
        };
        event.preventDefault = () => {
            event.defaultPrevented = true;
        };
        const path = [];
        let current = this;
        while (current) {
            path.unshift(current);
            current = current.parentNode;
        }
        for (const node of path) {
            for (const entry of (node.listeners.get(event.type) || []).slice()) {
                if (!entry.capture) {
                    continue;
                }
                event.currentTarget = node;
                entry.callback.call(node, event);
                if (event.stopped) {
                    return true;
                }
            }
        }
        for (let i = path.length - 1; i >= 0; i -= 1) {
            const node = path[i];
            for (const entry of (node.listeners.get(event.type) || []).slice()) {
                if (entry.capture) {
                    continue;
                }
                event.currentTarget = node;
                entry.callback.call(node, event);
                if (event.stopped) {
                    return true;
                }
            }
        }
        return true;
    }
    click() {
        this.dispatchEvent({ type: "click" });
    }
    dblclick() {
        this.dispatchEvent({ type: "dblclick" });
    }
    focus() {
        this.focused = true;
    }
    select() {}
    blur() {
        this.focused = false;
        this.dispatchEvent({ type: "blur" });
    }
    scrollIntoView() {}
    getBoundingClientRect() {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
}

function makeFakeDocument(registry) {
    const documentListeners = new Map();
    const document = {
        head: new FakeElement("head", registry),
        body: new FakeElement("body", registry),
        createElement(tag) {
            return new FakeElement(tag, registry);
        },
        querySelector(selector) {
            for (const element of registry) {
                if (matches(element, selector)) {
                    return element;
                }
            }
            return null;
        },
        querySelectorAll(selector) {
            return registry.filter((element) => matches(element, selector));
        },
        addEventListener(type, callback, capture) {
            if (!documentListeners.has(type)) {
                documentListeners.set(type, []);
            }
            documentListeners.get(type).push({ callback, capture: Boolean(capture) });
        },
        removeEventListener(type, callback) {
            const list = documentListeners.get(type) || [];
            const index = list.findIndex((entry) => entry.callback === callback);
            if (index !== -1) {
                list.splice(index, 1);
            }
        },
        dispatchEvent(event) {
            for (const entry of (documentListeners.get(event.type) || []).slice()) {
                entry.callback.call(document, event);
            }
            return true;
        },
        listeners: documentListeners,
    };
    return document;
}

/* ------------------------------------------------------------------ */
/* 把发布版源码载入 vm 上下文                                         */
/* ------------------------------------------------------------------ */

const registry = [];
const fakeDocument = makeFakeDocument(registry);

const timers = new Map();
let timerId = 0;

const context = vm.createContext({
    console,
    URL,
    document: fakeDocument,
    window: {
        setTimeout(callback) {
            timerId += 1;
            timers.set(timerId, callback);
            return timerId;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
    },
    __MTT_IMPORTS__: {},
    __MTT_APP__: null,
});

// 状态模块：去掉 export 关键字，按 IIFE 求值。
const stateSource = readFileSync(statePath, "utf8");
const exportedNames = [];
const nameRe = /^export\s+(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm;
let nameMatch;
while ((nameMatch = nameRe.exec(stateSource)) !== null) {
    exportedNames.push(nameMatch[1]);
}
const stateBody = stateSource.replace(/^export\s+/gm, "");
const stateModule = vm.runInContext(
    "(() => {" + stateBody + "\nreturn {" + exportedNames.join(",") + "};})()",
    context,
    { filename: statePath }
);

// 扩展模块：去掉 import 语句和末尾的 export 列表。
let extensionSource = readFileSync(extensionPath, "utf8");
extensionSource = extensionSource.replace(
    /import\s*\{([\s\S]*?)\}\s*from\s*"[^"]*"\s*;?/g,
    (match, names) => "const {" + names + "} = __MTT_IMPORTS__;"
);
extensionSource = extensionSource.replace(
    /export\s*\{([^}]*)\}\s*;?/g,
    (match, names) => "globalThis.__MTT_EXPORTS__ = {" + names + "};"
);
extensionSource = extensionSource.replace(
    /import\.meta\.url/g,
    '"http://127.0.0.1:8188/extensions/comfyui-multi-text-tabs/multi_text_tabs.js"'
);

let extension = null;
const fakeApp = {
    registerExtension(value) {
        extension = value;
    },
    graph: { _nodes: [] },
};
context.__MTT_APP__ = fakeApp;
context.__MTT_IMPORTS__ = Object.assign({}, stateModule, { app: fakeApp });

vm.runInContext(extensionSource, context, { filename: extensionPath });

assert.ok(extension, "the extension must register itself");

/* ------------------------------------------------------------------ */
/* 假 ComfyUI 节点                                                     */
/* ------------------------------------------------------------------ */

/** 取出假图里的一条连接。 */
function linkOf(node, linkId) {
    const graph = node.graph;
    if (!graph || !graph.links) {
        return null;
    }
    if (typeof graph.links.get === "function") {
        return graph.links.get(linkId) || null;
    }
    return graph.links[linkId] || null;
}

/**
 * 把一条连接接到节点的某个端点上，做法与 LiteGraph 一致。
 *
 * 连接会记住自己源端的槽位编号 —— 后端就是靠它来判断
 * 该取节点的哪一个输出。
 */
function attachLink(node, outputIndex, linkId) {
    const link = {
        id: linkId,
        origin_id: node.id,
        origin_slot: outputIndex,
        target_id: "2",
        target_slot: 0,
        type: "STRING",
    };
    node.graph.links.set(linkId, link);
    return link;
}

/**
 * 输出端点，它的 "links" 由连接登记表推导而来。
 *
 * 真实前端就是这么做的：槽位编号保存在连接里，端点只显示登记在
 * 它当前位置上的那些连接。因此端点移动时，只有连接也跟着移动，
 * 它才会带着自己的连接一起走。
 */
function makeOutput(node, name, type) {
    const output = { name, type, node };
    Object.defineProperty(output, "links", {
        get() {
            const index = this.node.outputs.indexOf(this);
            return index < 0 ? [] : this.node.linksForSlot(index);
        },
    });
    return output;
}

function makeNode(comfyClass) {
    const node = {
        type: comfyClass || "MultiTextTabs",
        properties: {},
        widgets: [],
        outputs: [],
        id: "1",
        size: [300, 200],
        graph: {
            // 真实前端把连接存在 Map 里，并没有 getLinkById ——
            // 假实现必须长得一模一样，否则连接查找坏掉时
            // 在这里根本看不出来。
            links: new Map(),
            beforeChange() {},
            afterChange() {},
        },
        linksForSlot(index) {
            const ids = [];
            for (const link of this.graph.links.values()) {
                if (link.origin_id === this.id && link.origin_slot === index) {
                    ids.push(link.id);
                }
            }
            return ids;
        },
        addOutput(name, type) {
            const output = makeOutput(this, name, type);
            this.outputs.push(output);
            return output;
        },
        removeOutput(index) {
            // LiteGraph 会断开被移除端点上的连接，
            // 并把它后面端点的连接整体往前挪一个槽位。
            for (const linkId of this.linksForSlot(index)) {
                this.graph.links.delete(linkId);
            }
            this.outputs.splice(index, 1);
            for (const link of this.graph.links.values()) {
                if (link.origin_id === this.id && link.origin_slot > index) {
                    link.origin_slot -= 1;
                }
            }
        },
        constructor: { comfyClass: comfyClass || "MultiTextTabs" },
        setSize(size) {
            this.size = size;
        },
        addDOMWidget(name, type, element, options) {
            const widget = {
                node: this,
                name,
                type,
                element,
                options: Object.assign({ hideOnZoom: true }, options),
                callback: null,
            };
            Object.defineProperty(widget, "value", {
                get() {
                    return this.options.getValue ? this.options.getValue() : "";
                },
                set(next) {
                    if (this.options.setValue) {
                        this.options.setValue(next);
                    }
                    if (this.callback) {
                        this.callback(this.value);
                    }
                },
            });
            this.widgets.push(widget);
            return widget;
        },
    };
    node.outputs.push(makeOutput(node, "text", "STRING"));
    return node;
}

/**
 * 前端给 node.properties 用的 Vue 响应式对象的最小替身：
 * 读取属性拿到的永远是所存对象的代理，而不是当初写进去的那个对象。
 *
 * 这正是插件在真实前端里坏掉的原因 —— 按对象是否同一个来比较状态
 * 永远不可能成功，于是每次改动都被写进了节点早已不再引用的对象里。
 */
function makeReactive(target, cache = new WeakMap()) {
    return new Proxy(target, {
        get(t, key, receiver) {
            const value = Reflect.get(t, key, receiver);
            if (value && typeof value === "object") {
                if (!cache.has(value)) {
                    cache.set(value, makeReactive(value, cache));
                }
                return cache.get(value);
            }
            return value;
        },
    });
}

/* ------------------------------------------------------------------ */
/* 检查项                                                              */
/* ------------------------------------------------------------------ */

const checks = [];
function check(name, fn) {
    checks.push([name, fn]);
}

check("the input is re-declared as the custom widget type", () => {
    const nodeData = {
        name: "MultiTextTabs",
        input: { required: { texts: ["STRING", { default: "", multiline: true }] } },
    };
    const nodeType = function () {};
    extension.beforeRegisterNodeDef(nodeType, nodeData);
    assert.equal(nodeData.input.required.texts[0], "MULTI_TEXT_TABS_UI");
});

check("other nodes are not touched", () => {
    const nodeData = {
        name: "KSampler",
        input: { required: { seed: ["INT", {}] } },
    };
    const before = JSON.stringify(nodeData);
    extension.beforeRegisterNodeDef(function () {}, nodeData);
    assert.equal(JSON.stringify(nodeData), before);
});

check("the node owns exactly one widget named texts", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    const result = widgets.MULTI_TEXT_TABS_UI(node);
    assert.ok(result.widget);
    assert.equal(result.widget.name, "texts");
    assert.equal(node.widgets.length, 1);
    // 待命文本存放在 node.properties 里，所以控件值不能写进
    // 工作流文件 —— 但它必须能送达后端。
    assert.equal(result.widget.serialize, false);
    assert.equal(result.widget.options.serialize, true);
    assert.equal(result.widget.options.socketless, true);
});

check("the widget value carries every text as json", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    const { widget } = widgets.MULTI_TEXT_TABS_UI(node);
    const controller = node.__multiTextTabs;
    controller.editor.value = "hello world";
    controller.editor.dispatchEvent({ type: "input" });
    controller.addNewTab();
    controller.editor.value = "second";
    controller.editor.dispatchEvent({ type: "input" });
    assert.deepEqual(JSON.parse(widget.value), { texts: ["hello world", "second"], active: 1 });
});

check("a fresh node starts with a single empty tab", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const state = node.properties.multi_text_tabs;
    assert.ok(state);
    assert.equal(state.tabs.length, 1);
    assert.equal(state.tabs[0].title, "待命文本 1");
    assert.equal(state.tabs[0].content, "");
    assert.equal(state.active_id, state.tabs[0].id);
});

check("typing updates the active tab and the widget value", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    const { widget } = widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    controller.editor.value = "第一段\n第二段";
    controller.editor.dispatchEvent({ type: "input" });
    assert.equal(node.properties.multi_text_tabs.tabs[0].content, "第一段\n第二段");
    assert.deepEqual(JSON.parse(widget.value), { texts: ["第一段\n第二段"], active: 0 });
});

check("switching tabs flushes the editor and loads the other text", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;

    controller.editor.value = "first tab text";
    controller.editor.dispatchEvent({ type: "input" });
    controller.addNewTab();
    controller.editor.value = "second tab text";
    controller.editor.dispatchEvent({ type: "input" });

    const state = node.properties.multi_text_tabs;
    assert.equal(state.tabs.length, 2);
    assert.equal(state.tabs[0].content, "first tab text");
    assert.equal(state.tabs[1].content, "second tab text");

    controller.switchTo(state.tabs[0].id);
    assert.equal(controller.editor.value, "first tab text");

    controller.switchTo(state.tabs[1].id);
    assert.equal(controller.editor.value, "second tab text");
});

check("switching away without an input event still keeps the last characters", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;

    controller.editor.value = "typed but not dispatched";
    controller.addNewTab();
    const state = node.properties.multi_text_tabs;
    assert.equal(state.tabs[0].content, "typed but not dispatched");
    controller.switchTo(state.tabs[0].id);
    assert.equal(controller.editor.value, "typed but not dispatched");
});

check("adding a text names it 待命文本 N and activates it", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    controller.addNewTab();
    controller.addNewTab();
    const state = node.properties.multi_text_tabs;
    assert.equal(state.tabs.length, 3);
    assert.equal(state.tabs[1].title, "待命文本 2");
    assert.equal(state.tabs[2].title, "待命文本 3");
    assert.equal(state.active_id, state.tabs[2].id);
});

check("closing a tab switches to a neighbour and keeps one tab", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    controller.addNewTab();
    const state = node.properties.multi_text_tabs;
    const second = state.tabs[1].id;

    controller.closeTabById(second);
    assert.equal(state.tabs.length, 1);
    assert.equal(state.active_id, state.tabs[0].id);

    controller.closeTabById(state.tabs[0].id);
    assert.equal(state.tabs.length, 1, "the last tab must never be removed");
});

check("closing a non empty tab offers an undo that restores it", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    controller.editor.value = "important";
    controller.editor.dispatchEvent({ type: "input" });
    controller.addNewTab();
    const state = node.properties.multi_text_tabs;
    const first = state.tabs[0].id;

    controller.closeTabById(first);
    assert.equal(state.tabs.length, 1);
    assert.ok(controller.undoPayload, "an undo must be offered");

    controller.undoClose();
    assert.equal(state.tabs.length, 2);
    assert.equal(state.tabs[0].content, "important");
    assert.equal(state.active_id, first);
});

check("renaming through the inline input works", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    const state = node.properties.multi_text_tabs;
    const id = state.tabs[0].id;

    controller.startRename(id);
    const input = controller.tabsRow.querySelector("input.mtt-rename-input");
    assert.ok(input, "the rename input must be in the DOM");
    input.value = " 角色设定 ";
    input.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {}, stopPropagation() {} });
    assert.equal(state.tabs[0].title, "角色设定");
});

check("duplicating a tab copies the text and activates the copy", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    controller.editor.value = "copy me";
    controller.editor.dispatchEvent({ type: "input" });
    const state = node.properties.multi_text_tabs;
    const source = state.tabs[0].id;

    controller.duplicateTabById(source);
    assert.equal(state.tabs.length, 2);
    assert.equal(state.tabs[1].content, "copy me");
    assert.notEqual(state.tabs[1].id, source);
    assert.equal(state.active_id, state.tabs[1].id);
    assert.equal(state.tabs[0].content, "copy me");
});

check("a damaged state is repaired instead of breaking the node", () => {
    const node = makeNode();
    node.properties.multi_text_tabs = {
        version: 1,
        active_id: "ghost",
        tabs: [
            { id: "dup", title: "A", content: "one" },
            { id: "dup", title: "", content: 5 },
        ],
    };
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const state = node.properties.multi_text_tabs;
    assert.equal(state.tabs.length, 2);
    assert.notEqual(state.tabs[0].id, state.tabs[1].id);
    assert.equal(state.tabs[0].content, "one");
    assert.equal(state.tabs[1].content, "");
    assert.ok(state.tabs.some((tab) => tab.id === state.active_id));
});

check("the state survives a save and load round trip", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    controller.editor.value = "persisted";
    controller.editor.dispatchEvent({ type: "input" });
    controller.addNewTab();
    controller.editor.value = "second";
    controller.editor.dispatchEvent({ type: "input" });

    // 前端写进工作流文件的内容。待命文本存放在 properties 里 ——
    // 控件值不会被写第二遍。
    const saved = {
        properties: JSON.parse(JSON.stringify(node.properties)),
        widgets_values: [],
    };

    const restored = makeNode();
    restored.properties = JSON.parse(JSON.stringify(saved.properties));
    const restoredWidgets = extension.getCustomWidgets();
    const { widget } = restoredWidgets.MULTI_TEXT_TABS_UI(restored);
    extension.nodeCreated(restored);
    extension.loadedGraphNode(restored);

    const state = restored.properties.multi_text_tabs;
    assert.equal(state.tabs.length, 2);
    assert.equal(state.tabs[0].content, "persisted");
    assert.equal(state.tabs[1].content, "second");
    assert.equal(restored.__multiTextTabs.editor.value, "second");
    assert.deepEqual(JSON.parse(widget.value), { texts: ["persisted", "second"], active: 1 });
});

check("the widget value is derived and never overwrites the editor", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    const { widget } = widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    controller.editor.value = "typed";
    controller.editor.dispatchEvent({ type: "input" });
    widget.value = "from workflow";
    assert.equal(controller.editor.value, "typed");
    assert.deepEqual(JSON.parse(widget.value), { texts: ["typed"], active: 0 });
});

check("removing the node cleans up the document listener", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    const before = fakeDocument.listeners.get("pointerdown").length;
    controller.dispose();
    assert.equal(fakeDocument.listeners.get("pointerdown").length, before - 1);
    controller.dispose();
    assert.equal(fakeDocument.listeners.get("pointerdown").length, before - 1);
});

check("tab titles are inserted as text, never as html", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    controller.renameTabById(controller.state().tabs[0].id, "<img src=x onerror=alert(1)>");
    const title = controller.tabsRow.querySelector(".mtt-tab-title");
    assert.equal(title.textContent, "<img src=x onerror=alert(1)>");
    assert.equal(title.children.length, 0, "no html nodes may be created from user text");
});

check("a reactive properties object does not lose tab changes", () => {
    const node = makeNode();
    node.properties = makeReactive(node.properties);
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;

    controller.editor.value = "first";
    controller.editor.dispatchEvent({ type: "input" });
    controller.addNewTab();
    controller.editor.value = "second";
    controller.editor.dispatchEvent({ type: "input" });

    const state = node.properties.multi_text_tabs;
    assert.equal(state.tabs.length, 2, "the new tab must reach node.properties");
    assert.equal(state.tabs[0].content, "first");
    assert.equal(state.tabs[1].content, "second");
    assert.equal(controller.tabsRow.querySelectorAll(".mtt-tab").length, 2);
    assert.equal(controller.editor.value, "second");
});

check("a reactive properties object keeps a renamed tab", () => {
    const node = makeNode();
    node.properties = makeReactive(node.properties);
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    const id = controller.state().tabs[0].id;

    controller.renameTabById(id, " 角色设定 ");
    assert.equal(node.properties.multi_text_tabs.tabs[0].title, "角色设定");
});

check("a reactive properties object keeps a closed tab closed", () => {
    const node = makeNode();
    node.properties = makeReactive(node.properties);
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;

    controller.addNewTab();
    controller.addNewTab();
    assert.equal(node.properties.multi_text_tabs.tabs.length, 3);
    const id = node.properties.multi_text_tabs.tabs[1].id;
    controller.closeTabById(id);
    assert.equal(node.properties.multi_text_tabs.tabs.length, 2);
});

check("a double click on a tab opens the inline rename input", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;

    controller.tabsRow.querySelector(".mtt-tab").dblclick();
    assert.ok(
        controller.tabsRow.querySelector("input.mtt-rename-input"),
        "the rename input must open on a double click"
    );
});

check("a right click on a tab opens the context menu", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;

    controller.tabsRow.querySelector(".mtt-tab").dispatchEvent({ type: "contextmenu" });
    const menu = fakeDocument.body.querySelector(".mtt-menu");
    assert.ok(menu, "the context menu must open on a right click");
    assert.equal(menu.querySelectorAll(".mtt-menu-item").length, 3);
    controller.closeMenu();
});

check("the state marker stays out of the workflow file", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    controller.addNewTab();

    const saved = JSON.parse(JSON.stringify(node.properties));
    assert.ok(saved.multi_text_tabs, "the tabs must be saved");
    assert.ok(
        !(stateModule.STATE_MARKER in saved.multi_text_tabs),
        "the internal marker must not be written to the workflow"
    );
    assert.equal(Object.keys(saved.multi_text_tabs).length, 3);
});

check("a change is reported to the frontend", () => {
    const node = makeNode();
    const calls = [];
    node.graph = {
        beforeChange() { calls.push("before"); },
        afterChange() { calls.push("after"); },
        canvasAction(callback) {
            callback({
                emitBeforeChange() { calls.push("emitBefore"); },
                emitAfterChange() { calls.push("emitAfter"); },
            });
        },
    };
    node.setDirtyCanvas = function () { calls.push("dirty"); };
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);

    node.__multiTextTabs.addNewTab();
    assert.ok(calls.includes("before"), "the change must be announced");
    assert.ok(calls.includes("after"), "the change must be committed");
    assert.ok(calls.includes("dirty"), "the canvas must be marked dirty");
});

check("the node has one output socket per text plus the main output", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;

    assert.equal(node.outputs.length, 2);
    assert.equal(node.outputs[0].name, "待命文本 1");
    assert.equal(node.outputs[1].name, "主输出");

    controller.addNewTab();
    assert.equal(node.outputs.length, 3);
    assert.equal(node.outputs[1].name, "待命文本 2");
    assert.equal(node.outputs[1].type, "STRING");
    assert.equal(node.outputs[2].name, "主输出");

    controller.renameTabById(controller.state().tabs[1].id, "镜头描述");
    assert.equal(node.outputs[1].name, "镜头描述");
    assert.equal(node.outputs[2].name, "主输出");

    controller.closeTabById(controller.state().tabs[1].id);
    assert.equal(node.outputs.length, 2);
    assert.equal(node.outputs[0].name, "待命文本 1");
    assert.equal(node.outputs[1].name, "主输出");
});

check("the main output keeps its link when a text is added", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;

    controller.addNewTab();
    assert.equal(node.outputs.length, 3);
    assert.equal(node.outputs[2].name, "主输出");

    // 主输出已经连到下游节点上。
    const link = attachLink(node, 2, 7);
    assert.equal(link.origin_slot, 2);

    controller.addNewTab();
    assert.equal(node.outputs.length, 4);
    assert.equal(node.outputs[2].name, "待命文本 3");
    assert.equal(node.outputs[3].name, "主输出");
    // 连接必须跟着主输出一起挪到新槽位，否则它送出去的就是
    // 待命文本 3 的内容，而不是当前文本。
    assert.equal(link.origin_slot, 3);
    assert.deepEqual(node.outputs[3].links, [7]);
});

check("closing a text removes only its own socket", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;

    controller.addNewTab();
    const link = attachLink(node, 2, 9);

    controller.closeTabById(controller.state().tabs[1].id);
    assert.equal(node.outputs.length, 2);
    assert.equal(node.outputs[0].name, "待命文本 1");
    assert.equal(node.outputs[1].name, "主输出");
    assert.equal(link.origin_slot, 1);
    assert.deepEqual(node.outputs[1].links, [9]);
});

check("the payload tells the backend which text is active", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    const { widget } = widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;

    controller.editor.value = "first";
    controller.editor.dispatchEvent({ type: "input" });
    controller.addNewTab();
    controller.editor.value = "second";
    controller.editor.dispatchEvent({ type: "input" });
    assert.deepEqual(JSON.parse(widget.value), { texts: ["first", "second"], active: 1 });

    // 切换标签会改变主输出所承载的文本。
    controller.switchTo(controller.state().tabs[0].id);
    assert.deepEqual(JSON.parse(widget.value), { texts: ["first", "second"], active: 0 });
});

check("the widget value is not written into the workflow file", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    const { widget } = widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    assert.equal(widget.serialize, false, "the texts live in the properties only");
    assert.equal(widget.options.serialize, true, "the value must reach the backend");
});

check("the node refuses more texts than the backend has outputs", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    for (let i = 0; i < 20; i += 1) {
        controller.addNewTab();
    }
    assert.equal(controller.state().tabs.length, 16);
    // 16 段待命文本，外加主输出。
    assert.equal(node.outputs.length, 17);
    assert.equal(node.outputs[16].name, "主输出");
});

/* ------------------------------------------------------------------ */
/* 运行                                                                */
/* ------------------------------------------------------------------ */

let failed = 0;
for (const [name, fn] of checks) {
    try {
        fn();
        console.log("PASS " + name);
    } catch (error) {
        failed += 1;
        console.log("FAIL " + name + ": " + error.message);
    }
}
console.log("\n" + (checks.length - failed) + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
