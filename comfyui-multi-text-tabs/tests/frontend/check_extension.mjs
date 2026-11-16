/**
 * Fake DOM harness for the Multi-Text Tabs frontend extension.
 *
 *     node tests/frontend/check_extension.mjs
 *
 * The real extension file is executed inside a node:vm context against a
 * bounded fake DOM. No browser, no network, no ComfyUI runtime - but the code
 * under test is the file that ships, not a copy of it.
 *
 * What is verified here:
 *   - the input is re-declared as the custom widget type;
 *   - the node ends up with exactly one widget, named "active_content";
 *   - the widget value always equals the live editor text;
 *   - typing, switching, adding, closing, renaming and duplicating behave;
 *   - the tab collection survives a save / load round trip.
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
/* tiny fake DOM                                                       */
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
/* load the shipped sources into a vm context                         */
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

// The state module: strip the export keywords and evaluate it as an IIFE.
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

// The extension: drop the import statements and the trailing export list.
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
/* fake ComfyUI node                                                   */
/* ------------------------------------------------------------------ */

function makeNode(comfyClass) {
    const node = {
        type: comfyClass || "MultiTextTabs",
        properties: {},
        widgets: [],
        size: [300, 200],
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
    return node;
}

/* ------------------------------------------------------------------ */
/* checks                                                              */
/* ------------------------------------------------------------------ */

const checks = [];
function check(name, fn) {
    checks.push([name, fn]);
}

check("the input is re-declared as the custom widget type", () => {
    const nodeData = {
        name: "MultiTextTabs",
        input: { required: { active_content: ["STRING", { default: "", multiline: true }] } },
    };
    const nodeType = function () {};
    extension.beforeRegisterNodeDef(nodeType, nodeData);
    assert.equal(nodeData.input.required.active_content[0], "MULTI_TEXT_TABS_UI");
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

check("the node owns exactly one widget named active_content", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    const result = widgets.MULTI_TEXT_TABS_UI(node);
    assert.ok(result.widget);
    assert.equal(result.widget.name, "active_content");
    assert.equal(node.widgets.length, 1);
    assert.notEqual(result.widget.serialize, false);
    assert.equal(result.widget.options.socketless, true);
});

check("the widget value is the live editor text", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    const { widget } = widgets.MULTI_TEXT_TABS_UI(node);
    const controller = node.__multiTextTabs;
    controller.editor.value = "hello world";
    assert.equal(widget.value, "hello world");
});

check("a fresh node starts with a single empty tab", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const state = node.properties.multi_text_tabs;
    assert.ok(state);
    assert.equal(state.tabs.length, 1);
    assert.equal(state.tabs[0].title, "Text 1");
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
    assert.equal(widget.value, "第一段\n第二段");
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

check("adding a tab names it Text N and activates it", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    const controller = node.__multiTextTabs;
    controller.addNewTab();
    controller.addNewTab();
    const state = node.properties.multi_text_tabs;
    assert.equal(state.tabs.length, 3);
    assert.equal(state.tabs[1].title, "Text 2");
    assert.equal(state.tabs[2].title, "Text 3");
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

    // What the frontend writes into the workflow file.
    const saved = {
        properties: JSON.parse(JSON.stringify(node.properties)),
        widgets_values: [node.widgets[0].value],
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
    assert.equal(widget.value, "second");
});

check("the widget restores its value from the workflow file", () => {
    const node = makeNode();
    const widgets = extension.getCustomWidgets();
    const { widget } = widgets.MULTI_TEXT_TABS_UI(node);
    extension.nodeCreated(node);
    widget.value = "from workflow";
    assert.equal(node.__multiTextTabs.editor.value, "from workflow");
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

/* ------------------------------------------------------------------ */
/* run                                                                 */
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
