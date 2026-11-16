/**
 * Multi-Text Tabs - ComfyUI frontend extension.
 *
 * Architecture (see the technical blueprint):
 *
 *   State Manager  -> multi_text_tabs_state.js (pure, unit tested)
 *   Widget Bridge  -> this file, keeps widget value and tab state in sync
 *   Tab UI         -> this file, plain DOM inside a DOM widget
 *
 * The node keeps exactly one widget, named "active_content". It is a DOM
 * widget so that the tab bar can sit above the editor and so that the editor
 * value we hand to the backend is always the live text of the active tab -
 * there is no "last keystroke lost on switch" race.
 *
 * The full tab collection is stored in node.properties.multi_text_tabs and is
 * therefore part of the workflow file, not part of the execution prompt.
 */

import { app } from "../../scripts/app.js";
import {
    STORAGE_KEY,
    cloneState,
    closeTab,
    duplicateTab,
    getActiveTab,
    getTab,
    normalizeState,
    readStateMarker,
    renameTab,
    renumberAutoTitles,
    setActiveTab,
    setActiveContent,
    tabTitles,
    addTab,
} from "./multi_text_tabs_state.js";

const NODE_TYPE = "MultiTextTabs";
const WIDGET_TYPE = "MULTI_TEXT_TABS_UI";
const INPUT_NAME = "texts";

/**
 * Upper bound of texts per node - the backend has one STRING output per text.
 * Must match MAX_TEXTS in nodes.py.
 */
const MAX_TEXTS = 16;

const UNDO_TIMEOUT_MS = 8000;

/** Inject the stylesheet once. */
function ensureStylesheet() {
    const href = new URL("./multi_text_tabs.css", import.meta.url).href;
    if (document.querySelector('link[data-multi-text-tabs="1"]')) {
        return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-multi-text-tabs", "1");
    document.head.appendChild(link);
}

/**
 * The UI of one node: tab bar + editor + status line.
 *
 * The controller is created together with the DOM widget (see
 * getCustomWidgets) because the widget's value contract is defined by the
 * textarea that lives inside it.
 */
class MultiTextTabsController {
    constructor(node) {
        this.node = node;
        this.widget = null;
        this.undoTimer = null;
        this.undoPayload = null;
        // The state object this controller owns. node.properties holds the
        // very same object, the frontend only reads it through a proxy.
        this.canonical = null;

        this.root = document.createElement("div");
        this.root.className = "mtt-root";
        this.root.setAttribute("data-multi-text-tabs", "root");

        this.bar = document.createElement("div");
        this.bar.className = "mtt-bar";

        this.tabsRow = document.createElement("div");
        this.tabsRow.className = "mtt-tabs";
        this.tabsRow.setAttribute("role", "tablist");

        this.addButton = document.createElement("button");
        this.addButton.type = "button";
        this.addButton.className = "mtt-add";
        this.addButton.textContent = "+";
        this.addButton.title = "新建标签";
        this.addButton.setAttribute("aria-label", "新建标签");

        this.bar.appendChild(this.tabsRow);
        this.bar.appendChild(this.addButton);

        this.status = document.createElement("div");
        this.status.className = "mtt-status";

        this.editor = document.createElement("textarea");
        this.editor.className = "mtt-editor";
        this.editor.spellcheck = false;
        this.editor.setAttribute("aria-label", "当前标签文本");

        this.notice = document.createElement("div");
        this.notice.className = "mtt-notice";
        this.notice.hidden = true;

        this.root.appendChild(this.bar);
        this.root.appendChild(this.status);
        this.root.appendChild(this.editor);
        this.root.appendChild(this.notice);

        this.menu = null;
        this.renameInput = null;

        this.attachEvents();
    }

    /* ------------------------------------------------------------------ */
    /* state                                                               */
    /* ------------------------------------------------------------------ */

    /**
     * The tab collection of this node.
     *
     * node.properties is the single source of truth. It is repaired lazily so
     * that a node created by the frontend, restored from a workflow or cloned
     * from another node all end up with a valid state.
     */
    state() {
        const stored = this.node.properties ? this.node.properties[STORAGE_KEY] : undefined;
        // The frontend keeps node.properties inside a Vue reactive object, so
        // reading it back gives a proxy instead of the object we wrote. Object
        // identity therefore never matches and the state has to be identified
        // by its marker instead.
        if (this.canonical) {
            const storedMarker = readStateMarker(stored);
            if (storedMarker && storedMarker === readStateMarker(this.canonical)) {
                return this.canonical;
            }
            if (!stored) {
                // The property was removed - put our state back.
                this.writeState(this.canonical);
                return this.canonical;
            }
            // The state was replaced from the outside (workflow load, copy or
            // undo): adopt the new one.
            this.canonical = null;
        }
        const result = normalizeState(stored, this.editor.value);
        this.canonical = result.state;
        this.writeState(this.canonical);
        // "no stored state" is the normal start of a fresh node, not a repair.
        const notes = result.issues.filter((issue) => issue !== "no stored state");
        if (notes.length) {
            console.warn("[Multi-Text Tabs] repaired tab state:", notes.join("; "));
        }
        return this.canonical;
    }

    /**
     * Store the state in node.properties, which stays the single source of
     * truth. The object that is written is the one this controller owns, so
     * every change that is made to it is visible in the workflow file.
     */
    writeState(state) {
        if (!this.node.properties) {
            this.node.properties = {};
        }
        this.node.properties[STORAGE_KEY] = state;
    }

    /** Copy the live editor text into the active tab. */
    flushActive() {
        const state = this.state();
        const active = getActiveTab(state);
        if (!active) {
            return;
        }
        if (active.content !== this.editor.value) {
            active.content = this.editor.value;
        }
    }

    /* ------------------------------------------------------------------ */
    /* rendering                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Paint the tab bar and the status line.
     *
     * This never writes the editor text back into the state: on a workflow
     * load the editor is empty while the restored state already holds the
     * text, and flushing here would wipe it.
     */
    render() {
        const state = this.state();
        this.renderTabs(state);
        this.renderStatus(state);
        this.syncOutputs();
    }

    renderTabs(state) {
        const row = this.tabsRow;
        // Rebuild the row: tab count is small and this keeps the DOM in sync
        // with the state without any diffing logic.
        while (row.firstChild) {
            row.removeChild(row.firstChild);
        }
        state.tabs.forEach((tab) => {
            row.appendChild(this.buildTab(tab, tab.id === state.active_id));
        });
    }

    buildTab(tab, isActive) {
        const item = document.createElement("div");
        item.className = isActive ? "mtt-tab mtt-active" : "mtt-tab";
        item.setAttribute("role", "tab");
        item.setAttribute("tabindex", "0");
        item.dataset.tabId = tab.id;
        item.title = tab.title;

        const title = document.createElement("span");
        title.className = "mtt-tab-title";
        // textContent, never innerHTML: tab titles are user input.
        title.textContent = tab.title;
        item.appendChild(title);

        const close = document.createElement("span");
        close.className = "mtt-tab-close";
        close.textContent = "\u00d7";
        close.title = "关闭标签";
        close.dataset.closeId = tab.id;
        item.appendChild(close);

        return item;
    }

    /**
     * Make the output sockets match the texts.
     *
     * One socket per 待命文本, named after it, so the wiring on the right side
     * tells which string goes where. The socket order is the tab order, which
     * is the order the backend returns the texts in.
     */
    syncOutputs() {
        const state = this.state();
        const titles = state.tabs.map((tab) => tab.title);
        const node = this.node;
        while (node.outputs.length > titles.length) {
            node.removeOutput(node.outputs.length - 1);
        }
        titles.forEach((title, index) => {
            if (index >= node.outputs.length) {
                node.addOutput(title, "STRING");
            } else {
                const output = node.outputs[index];
                if (output.name !== title) {
                    output.name = title;
                }
                if (output.type !== "STRING") {
                    output.type = "STRING";
                }
            }
        });
        // The sockets need room of their own.
        const wanted = Math.max(320, 200 + titles.length * 20);
        if (!node.size || node.size[1] < wanted) {
            node.setSize([node.size ? node.size[0] : 420, wanted]);
        }
        node.setDirtyCanvas?.(true, true);
    }

    renderStatus(state) {
        const active = getActiveTab(state);
        this.status.textContent = "";
        if (!active) {
            return;
        }
        const label = document.createElement("span");
        label.className = "mtt-status-label";
        label.textContent = "当前待命文本：";
        const name = document.createElement("span");
        name.className = "mtt-status-name";
        name.textContent = active.title;
        this.status.appendChild(label);
        this.status.appendChild(name);
    }

    /** Put the text of the active tab into the editor. */
    loadActiveIntoEditor() {
        const state = this.state();
        const active = getActiveTab(state);
        const text = active ? active.content : "";
        if (this.editor.value !== text) {
            this.editor.value = text;
        }
    }

    /* ------------------------------------------------------------------ */
    /* actions                                                             */
    /* ------------------------------------------------------------------ */

    switchTo(id) {
        const state = this.state();
        if (!getTab(state, id) || state.active_id === id) {
            return;
        }
        this.withChangeTracking(() => {
            // Commit whatever is in the editor before the active tab changes.
            this.flushActive();
            setActiveTab(state, id);
            this.loadActiveIntoEditor();
            this.render();
            this.scrollActiveIntoView();
        });
        this.notifyWidgetChanged();
    }

    addNewTab() {
        const state = this.state();
        if (state.tabs.length >= MAX_TEXTS) {
            this.flash("最多 " + MAX_TEXTS + " 条待命文本");
            return;
        }
        this.withChangeTracking(() => {
            this.flushActive();
            const tab = addTab(state, {});
            this.editor.value = tab.content;
            this.render();
            this.scrollActiveIntoView();
        });
        this.focusEditor();
        this.notifyWidgetChanged();
    }

    closeTabById(id) {
        const state = this.state();
        const target = getTab(state, id);
        if (!target) {
            return;
        }
        let result = null;
        this.withChangeTracking(() => {
            // Capture a pending edit of the tab that is about to disappear.
            this.flushActive();
            result = closeTab(state, id);
            if (!result.closed) {
                return;
            }
            // The automatically named texts stay consecutive.
            renumberAutoTitles(state);
            if (result.activated) {
                this.loadActiveIntoEditor();
            }
            this.render();
        });
        if (!result || !result.closed) {
            if (result && result.reason === "last tab is kept") {
                this.flash("至少保留一个标签");
            }
            return;
        }
        if (target.content.length > 0) {
            // Non empty tab: offer an undo instead of a blocking dialog.
            this.undoPayload = { tab: result.removed, index: result.index };
            this.showNotice("已关闭 \u300c" + target.title + "\u300d", "撤销");
        }
        this.notifyWidgetChanged();
    }

    undoClose() {
        if (!this.undoPayload) {
            return;
        }
        const state = this.state();
        const { tab, index } = this.undoPayload;
        this.undoPayload = null;
        this.withChangeTracking(() => {
            const at = Math.min(index, state.tabs.length);
            state.tabs.splice(at, 0, { id: tab.id, title: tab.title, content: tab.content });
            state.active_id = tab.id;
            this.loadActiveIntoEditor();
            this.render();
        });
        this.hideNotice();
        this.notifyWidgetChanged();
    }

    duplicateTabById(id) {
        const state = this.state();
        let copy = null;
        this.withChangeTracking(() => {
            this.flushActive();
            copy = duplicateTab(state, id);
            if (!copy) {
                return;
            }
            this.loadActiveIntoEditor();
            this.render();
            this.scrollActiveIntoView();
        });
        if (copy) {
            this.notifyWidgetChanged();
        }
    }

    renameTabById(id, title) {
        const state = this.state();
        let renamed = null;
        this.withChangeTracking(() => {
            renamed = renameTab(state, id, title);
            if (renamed) {
                this.render();
            }
        });
        if (renamed) {
            this.notifyWidgetChanged();
        }
    }

    /* ------------------------------------------------------------------ */
    /* notice / menu                                                       */
    /* ------------------------------------------------------------------ */

    showNotice(message, actionLabel) {
        this.clearUndoTimer();
        this.notice.textContent = "";
        this.notice.hidden = false;
        const text = document.createElement("span");
        text.className = "mtt-notice-text";
        text.textContent = message;
        this.notice.appendChild(text);
        if (actionLabel) {
            const action = document.createElement("button");
            action.type = "button";
            action.className = "mtt-notice-action";
            action.textContent = actionLabel;
            action.addEventListener("click", (event) => {
                event.stopPropagation();
                this.undoClose();
            });
            this.notice.appendChild(action);
        }
        this.undoTimer = window.setTimeout(() => {
            this.hideNotice();
        }, UNDO_TIMEOUT_MS);
    }

    hideNotice() {
        this.clearUndoTimer();
        this.undoPayload = null;
        this.notice.hidden = true;
        this.notice.textContent = "";
    }

    clearUndoTimer() {
        if (this.undoTimer) {
            window.clearTimeout(this.undoTimer);
            this.undoTimer = null;
        }
    }

    flash(message) {
        this.showNotice(message, null);
    }

    openMenu(id, anchor) {
        this.closeMenu();
        const menu = document.createElement("div");
        menu.className = "mtt-menu";
        const entries = [
            { label: "重命名", run: () => this.startRename(id) },
            { label: "复制标签", run: () => this.duplicateTabById(id) },
            { label: "关闭标签", run: () => this.closeTabById(id) },
        ];
        entries.forEach((entry) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "mtt-menu-item";
            item.textContent = entry.label;
            item.addEventListener("click", (event) => {
                event.stopPropagation();
                this.closeMenu();
                entry.run();
            });
            menu.appendChild(item);
        });
        document.body.appendChild(menu);
        const rect = anchor.getBoundingClientRect();
        menu.style.left = Math.round(rect.left) + "px";
        menu.style.top = Math.round(rect.bottom + 4) + "px";
        this.menu = menu;
    }

    closeMenu() {
        if (this.menu && this.menu.parentNode) {
            this.menu.parentNode.removeChild(this.menu);
        }
        this.menu = null;
    }

    /* ------------------------------------------------------------------ */
    /* rename                                                              */
    /* ------------------------------------------------------------------ */

    startRename(id) {
        const state = this.state();
        const tab = getTab(state, id);
        if (!tab) {
            return;
        }
        const item = this.tabsRow.querySelector('.mtt-tab[data-tab-id="' + id + '"]');
        if (!item) {
            return;
        }
        const title = item.querySelector(".mtt-tab-title");
        if (!title) {
            return;
        }
        const input = document.createElement("input");
        input.type = "text";
        input.className = "mtt-rename-input";
        input.value = tab.title;
        title.hidden = true;
        item.insertBefore(input, title);
        input.focus();
        input.select();

        let done = false;
        const finish = (commit) => {
            if (done) {
                return;
            }
            done = true;
            const value = input.value;
            if (input.parentNode) {
                input.parentNode.removeChild(input);
            }
            title.hidden = false;
            if (commit) {
                this.renameTabById(id, value);
            } else {
                this.render();
            }
        };
        input.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
                event.preventDefault();
                finish(true);
            } else if (event.key === "Escape") {
                event.preventDefault();
                finish(false);
            }
        });
        input.addEventListener("blur", () => finish(true));
        input.addEventListener("click", (event) => event.stopPropagation());
        input.addEventListener("dblclick", (event) => event.stopPropagation());
    }

    /* ------------------------------------------------------------------ */
    /* events                                                              */
    /* ------------------------------------------------------------------ */

    attachEvents() {
        // Capture phase: keep the canvas from starting a node drag or a graph
        // zoom while the user works inside the widget.
        const stop = (event) => event.stopPropagation();
        ["pointerdown", "mousedown", "wheel"].forEach((name) => {
            this.root.addEventListener(name, stop, true);
        });
        // Bubble phase: the handlers of the tab bar have to run first (double
        // click renames, right click opens the menu). Stopping the event here
        // keeps it away from the canvas afterwards.
        ["dblclick", "contextmenu"].forEach((name) => {
            this.root.addEventListener(name, stop);
        });

        this.editor.addEventListener("input", () => {
            this.flushActive();
            this.notifyWidgetChanged();
        });
        this.editor.addEventListener("keydown", (event) => this.onKeyDown(event));

        this.addButton.addEventListener("click", (event) => {
            event.stopPropagation();
            this.addNewTab();
        });

        this.tabsRow.addEventListener("click", (event) => {
            const close = event.target.closest("[data-close-id]");
            if (close) {
                event.stopPropagation();
                this.closeTabById(close.dataset.closeId);
                return;
            }
            const item = event.target.closest("[data-tab-id]");
            if (item) {
                event.stopPropagation();
                this.switchTo(item.dataset.tabId);
            }
        });

        this.tabsRow.addEventListener("dblclick", (event) => {
            const item = event.target.closest("[data-tab-id]");
            if (item && !event.target.closest("[data-close-id]")) {
                event.stopPropagation();
                this.startRename(item.dataset.tabId);
            }
        });

        this.tabsRow.addEventListener("contextmenu", (event) => {
            const item = event.target.closest("[data-tab-id]");
            if (!item) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            this.openMenu(item.dataset.tabId, item);
        });

        this.tabsRow.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                const item = event.target.closest("[data-tab-id]");
                if (item) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.switchTo(item.dataset.tabId);
                }
            }
        });

        document.addEventListener("pointerdown", this.onDocumentPointerDown = () => {
            this.closeMenu();
        }, true);
    }

    onDocumentPointerDown(event) {
        if (this.menu && this.menu.contains(event.target)) {
            return;
        }
        this.closeMenu();
    }

    onKeyDown(event) {
        if (!event.ctrlKey) {
            return;
        }
        const key = event.key.toLowerCase();
        if (key === "tab") {
            event.preventDefault();
            this.step(event.shiftKey ? -1 : 1);
        } else if (key === "n") {
            event.preventDefault();
            this.addNewTab();
        }
    }

    step(direction) {
        const state = this.state();
        if (state.tabs.length === 0) {
            return;
        }
        const index = state.tabs.findIndex((tab) => tab.id === state.active_id);
        const next = (index + direction + state.tabs.length) % state.tabs.length;
        this.switchTo(state.tabs[next].id);
    }

    scrollActiveIntoView() {
        const state = this.state();
        const item = this.tabsRow.querySelector('.mtt-tab[data-tab-id="' + state.active_id + '"]');
        if (item && typeof item.scrollIntoView === "function") {
            item.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
    }

    focusEditor() {
        if (typeof this.editor.focus === "function") {
            this.editor.focus();
        }
    }

    /** Tell ComfyUI that the widget value changed. */
    notifyWidgetChanged() {
        if (this.widget) {
            try {
                // Assigning the value runs options.setValue and the widget
                // callback, which is how the frontend is told about the
                // change. The value is derived from the tab state.
                this.widget.value = this.getTextsJson();
            } catch (error) {
                console.warn("[Multi-Text Tabs] widget callback failed", error);
            }
        }
        if (this.node && typeof this.node.setDirtyCanvas === "function") {
            this.node.setDirtyCanvas(true, true);
        }
    }

    /**
     * Run a mutation and report the change to the frontend.
     *
     * The pattern is the one the frontend itself uses for structural node
     * changes: before the change the canvas state is captured, after it the
     * change is committed. Every step is optional, so the plugin also works
     * in a frontend that does not know these hooks.
     */
    withChangeTracking(mutation) {
        const graph = this.node ? this.node.graph : null;
        const emit = (name) => {
            if (graph && typeof graph.canvasAction === "function") {
                graph.canvasAction((canvas) => {
                    if (canvas && typeof canvas[name] === "function") {
                        canvas[name]();
                    }
                });
            }
        };
        if (graph && typeof graph.beforeChange === "function") {
            graph.beforeChange();
        }
        emit("emitBeforeChange");
        try {
            mutation();
        } finally {
            if (graph && typeof graph.afterChange === "function") {
                graph.afterChange();
            }
            emit("emitAfterChange");
            if (this.node && typeof this.node.setDirtyCanvas === "function") {
                this.node.setDirtyCanvas(true, true);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* widget bridge                                                       */
    /* ------------------------------------------------------------------ */

    /** The text of the active tab - what the editor shows. */
    getText() {
        return this.editor.value;
    }

    /**
     * Every text of the node as a JSON array.
     *
     * This is the value that goes to the backend: one entry per 待命文本, in
     * tab order, so output i carries text i.
     */
    getTextsJson() {
        const state = this.state();
        return JSON.stringify(state.tabs.map((tab) => tab.content));
    }

    /**
     * The widget value is derived from the tab state, so restoring it must
     * never touch the editor - the editor follows the tab state instead.
     */
    setText() {
        // intentionally empty
    }

    dispose() {
        this.clearUndoTimer();
        this.closeMenu();
        document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    }
}

/** Find the controller of a node, if it has one. */
function controllerOf(node) {
    return node && node.__multiTextTabs ? node.__multiTextTabs : null;
}

ensureStylesheet();

app.registerExtension({
    name: "comfyui-multi-text-tabs",

    /**
     * Re-declare the input as a custom widget type so that the node owns a
     * single DOM widget (tab bar + editor) instead of a native textarea plus
     * a second widget. The input keeps its name, so the workflow file and the
     * execution prompt still use "active_content".
     */
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!nodeData || nodeData.name !== NODE_TYPE) {
            return;
        }
        const required = nodeData.input && nodeData.input.required;
        if (!required || !required[INPUT_NAME]) {
            return;
        }
        required[INPUT_NAME] = [WIDGET_TYPE, { default: "" }];
    },

    /**
     * Provide the DOM widget for the custom input type.
     * The returned widget is the only widget of the node, so the text is
     * saved in the workflow file and sent to the backend by name.
     */
    getCustomWidgets() {
        return {
            [WIDGET_TYPE](node) {
                const controller = new MultiTextTabsController(node);
                node.__multiTextTabs = controller;

                const widget = node.addDOMWidget(INPUT_NAME, "multiTextTabs", controller.root, {
                    socketless: true,
                    // options.serialize decides whether the value goes into the
                    // execution request - it must.
                    serialize: true,
                    hideOnZoom: false,
                    getValue: () => controller.getTextsJson(),
                    setValue: (value) => controller.setText(value),
                    getMinHeight: () => 140,
                });
                // widget.serialize decides whether the value goes into the
                // workflow file. The texts live in node.properties, so the
                // widget must not write them a second time.
                widget.serialize = false;
                controller.widget = widget;
                return { widget };
            },
        };
    },

    /** A node was created - give it a valid state and paint it. */
    nodeCreated(node) {
        if (!node || node.constructor?.comfyClass !== NODE_TYPE) {
            return;
        }
        const controller = controllerOf(node);
        if (!controller) {
            return;
        }
        controller.state();
        controller.loadActiveIntoEditor();
        controller.render();
        const size = node.size || [0, 0];
        const width = Math.max(size[0] || 0, 420);
        const height = Math.max(size[1] || 0, 320);
        if (width !== size[0] || height !== size[1]) {
            node.setSize([width, height]);
        }
    },

    /** A workflow was loaded - repaint from the restored properties. */
    loadedGraphNode(node) {
        const controller = controllerOf(node);
        if (!controller) {
            return;
        }
        controller.state();
        controller.loadActiveIntoEditor();
        controller.render();
    },

    /** Graph level fallback for the load hook. */
    afterConfigureGraph() {
        const graph = app.graph;
        if (!graph || !graph._nodes) {
            return;
        }
        graph._nodes.forEach((node) => {
            const controller = controllerOf(node);
            if (!controller) {
                return;
            }
            controller.state();
            controller.loadActiveIntoEditor();
            controller.render();
        });
    },
});

export { MultiTextTabsController, cloneState, setActiveContent, tabTitles };
