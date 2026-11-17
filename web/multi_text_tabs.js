/**
 * Multi-Text Tabs - ComfyUI 前端扩展。
 *
 * 架构分层（见技术蓝图）：
 *
 *   状态管理器  -> multi_text_tabs_state.js（纯逻辑，可独立单测）
 *   widget 桥接 -> 本文件，保持 widget 值与标签状态同步
 *   标签 UI     -> 本文件，在 DOM widget 内部用原生 DOM 实现
 *
 * 节点只保留一个名为 "texts" 的 widget。它是 DOM widget，这样标签栏能放在
 * 编辑区上方，而且交给后端的编辑区值永远是当前标签的实时文本 —— 不存在
 * "切换时丢掉最后一次输入"的竞态。
 *
 * widget 值是一段 JSON 载荷，含全部文本和当前活动项的下标，后端据此把
 * 当前选中的待命文本填进主输出。
 *
 * 完整标签集合存放在 node.properties.multi_text_tabs，因此属于工作流文件，
 * 而不属于执行提示词。
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
 * 每个节点的文本条数上限 —— 后端每条文本对应一个 STRING 输出。
 * 必须与 nodes.py 中的 MAX_TEXTS 一致。
 */
const MAX_TEXTS = 16;

/**
 * 承载"当前选中文本"的输出端点名。
 * 它固定排在所有文本输出之后，这样新增或关闭文本时，
 * 文本输出的槽位序号一个都不会错位。
 */
const MAIN_OUTPUT = "主输出";

const UNDO_TIMEOUT_MS = 8000;

/** 样式表只注入一次。 */
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
 * 单个节点的 UI：标签栏 + 编辑区 + 状态行。
 *
 * 控制器与 DOM widget 一起创建（见 getCustomWidgets），
 * 因为 widget 的取值约定是由其中的 textarea 决定的。
 */
class MultiTextTabsController {
    constructor(node) {
        this.node = node;
        this.widget = null;
        this.undoTimer = null;
        this.undoPayload = null;
        // 本控制器所拥有的状态对象。node.properties 里放的就是同一个对象，
        // 前端只是通过一层代理去读它。
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
/* 状态                                                                */
/* ------------------------------------------------------------------ */

/**
     * 本节点的标签集合。
     *
     * node.properties 是唯一权威来源。它采用惰性修复，因此前端新建的节点、
     * 从工作流还原的节点、以及从别的节点克隆出来的节点，最终都会拿到
     * 一份有效状态。
     */
    state() {
        const stored = this.node.properties ? this.node.properties[STORAGE_KEY] : undefined;
        // 前端把 node.properties 放在 Vue reactive 对象里，所以读回来的是
        // 代理而不是我们写入的那个对象。对象身份因此永远对不上，
        // 状态只能改用它内部的标记来识别。
        if (this.canonical) {
            const storedMarker = readStateMarker(stored);
            if (storedMarker && storedMarker === readStateMarker(this.canonical)) {
                return this.canonical;
            }
            if (!stored) {
                // 属性被删掉了 —— 把我们的状态放回去。
                this.writeState(this.canonical);
                return this.canonical;
            }
            // 状态被外部换掉了（载入工作流、复制或撤销）：接管新的那一个。
            this.canonical = null;
        }
        const result = normalizeState(stored, this.editor.value);
        this.canonical = result.state;
        this.writeState(this.canonical);
        // 「没有存状态」是新节点的正常起点，不属于需要修复的损坏。
        const notes = result.issues.filter((issue) => issue !== "no stored state");
        if (notes.length) {
            console.warn("[Multi-Text Tabs] repaired tab state:", notes.join("; "));
        }
        return this.canonical;
    }

/**
     * 把状态存进 node.properties —— 它始终是唯一权威来源。
     * 写进去的对象正是本控制器所拥有的那一个，因此对它做的任何改动
     * 都会体现在工作流文件里。
     */
    writeState(state) {
        if (!this.node.properties) {
            this.node.properties = {};
        }
        this.node.properties[STORAGE_KEY] = state;
    }

    /** 把编辑区里的实时文本写回当前标签。 */
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
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/**
     * 绘制标签栏与状态行。
     *
     * 这里绝不把编辑区文本写回状态：载入工作流时编辑区是空的，
     * 而还原出来的状态里已经带着文本，在这里回写会把内容抹掉。
     */
    render() {
        const state = this.state();
        this.renderTabs(state);
        this.renderStatus(state);
        this.syncOutputs();
    }

    renderTabs(state) {
        const row = this.tabsRow;
        // 整行重建：标签数量不大，这样不用任何差异比对逻辑
        // 就能让 DOM 与状态保持一致。
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
        // 只用 textContent，绝不用 innerHTML：标签标题是用户输入的内容。
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
     * 让输出端点与文本一一对应。
     *
     * 每条待命文本一个端点，名字与文本同名，这样右侧的接线一眼能看出
     * 哪根线走的是哪串文本。端点顺序就是标签顺序，也就是后端返回文本的顺序。
     *
     * 文本端点之后还有一个端点，就是主输出。它承载当前选中的那条待命文本，
     * 于是下游节点只要接一次线，靠点击标签就能切换。
     *
     * 主输出始终留在末尾。这样文本输出的槽位序号保持稳定：
     * 后端是靠槽位序号把连线映射到输出的，从不靠名字。
     */
    syncOutputs() {
        const state = this.state();
        const titles = state.tabs.map((tab) => tab.title);
        const node = this.node;

        // 主输出永远存在。
        if (node.outputs.length === 0) {
            node.addOutput(MAIN_OUTPUT, "STRING");
        }

        // 移除已经不存在的文本端点。它们紧挨在主输出前面，
        // 而主输出自己不在其中。
        while (node.outputs.length > titles.length + 1) {
            // LiteGraph 会自己把被移除端点之后的那些连线的槽位序号
            // 挪到新位置。
            node.removeOutput(titles.length);
        }

        titles.forEach((title, index) => {
            if (index === node.outputs.length - 1) {
                // 只剩主输出：把文本端点插到它前面。
                this.insertOutput(index, title);
                return;
            }
            const output = node.outputs[index];
            if (output.name !== title) {
                output.name = title;
            }
            if (output.type !== "STRING") {
                output.type = "STRING";
            }
        });

        const main = node.outputs[node.outputs.length - 1];
        if (main.name !== MAIN_OUTPUT) {
            main.name = MAIN_OUTPUT;
        }
        if (main.type !== "STRING") {
            main.type = "STRING";
        }

        // 端点需要自己的空间。
        const wanted = Math.max(320, 200 + titles.length * 20);
        if (!node.size || node.size[1] < wanted) {
            node.setSize([node.size ? node.size[0] : 420, wanted]);
        }
        node.setDirtyCanvas?.(true, true);
    }

/**
     * 在指定位置插入一个输出端点。
     *
     * LiteGraph 只会追加新输出，所以这个端点得手工挪到位。
     * 本节点中起点在该位置之后的连线必须跟着一起移动 —— 否则主输出会留在
     * 旧槽位上，送出错误的文本。
     */
    insertOutput(index, name) {
        const node = this.node;
        node.addOutput(name, "STRING");
        const fresh = node.outputs.pop();
        node.outputs.splice(index, 0, fresh);
        this.shiftLinks(index, 1);
    }

/**
     * 把本节点中起点位于槽位 "from" 的连线整体移动 "delta"。
     *
     * 前端把连线的槽位序号存在连线对象内部，端点的 "links" 是由它推导出来的，
     * 所以端点移动时这个序号必须同步修正。
     */
    shiftLinks(from, delta) {
        const node = this.node;
        for (const link of allLinks(node.graph)) {
            if (!link || typeof link.origin_slot !== "number") {
                continue;
            }
            if (!belongsToNode(link, node)) {
                continue;
            }
            if (link.origin_slot >= from) {
                link.origin_slot += delta;
            }
        }
    }

    renderStatus(state) {
        const active = getActiveTab(state);
        this.status.textContent = "";
        if (!active) {
            return;
        }
        const label = document.createElement("span");
        label.className = "mtt-status-label";
        label.textContent = "当前待命文本（主输出）：";
        const name = document.createElement("span");
        name.className = "mtt-status-name";
        name.textContent = active.title;
        this.status.appendChild(label);
        this.status.appendChild(name);
    }

    /** 把当前标签的文本放进编辑区。 */
    loadActiveIntoEditor() {
        const state = this.state();
        const active = getActiveTab(state);
        const text = active ? active.content : "";
        if (this.editor.value !== text) {
            this.editor.value = text;
        }
    }

/* ------------------------------------------------------------------ */
/* 操作                                                                */
/* ------------------------------------------------------------------ */

    switchTo(id) {
        const state = this.state();
        if (!getTab(state, id) || state.active_id === id) {
            return;
        }
        this.withChangeTracking(() => {
            // 活动标签切换之前，先把编辑区里的内容写回。
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
            // 把即将消失的标签上还没提交的编辑先存下来。
            this.flushActive();
            result = closeTab(state, id);
            if (!result.closed) {
                return;
            }
            // 自动命名的文本保持编号连续。
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
            // 标签非空：给一次撤销的机会，而不是弹一个阻塞式对话框。
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
/* 提示条 / 右键菜单                                                   */
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
/* 重命名                                                              */
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
/* 事件                                                                */
/* ------------------------------------------------------------------ */

    attachEvents() {
        // 捕获阶段：用户还在 widget 里操作时，别让画布开始拖动节点
        // 或缩放画布。
        const stop = (event) => event.stopPropagation();
        ["pointerdown", "mousedown", "wheel"].forEach((name) => {
            this.root.addEventListener(name, stop, true);
        });
        // 冒泡阶段：标签栏自己的处理器必须先跑完（双击重命名、
        // 右键打开菜单）。在这里拦下事件，之后它就到不了画布那里。
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

    /** 告诉 ComfyUI：widget 的值变了。 */
    notifyWidgetChanged() {
        if (this.widget) {
            try {
                // 给 widget 赋值会触发 options.setValue 和 widget 的 callback，
                // 前端就是这样得知变化的。这个值由标签状态推导而来。
                this.widget.value = this.getTextsPayload();
            } catch (error) {
                console.warn("[Multi-Text Tabs] widget callback failed", error);
            }
        }
        if (this.node && typeof this.node.setDirtyCanvas === "function") {
            this.node.setDirtyCanvas(true, true);
        }
    }

/**
     * 执行一次改动，并把变更上报给前端。
     *
     * 用的是前端自己做结构性节点变更时的那套模式：改动前先捕获画布状态，
     * 改动后再提交变更。每一步都是可选的，所以插件在不认识这些钩子的
     * 前端里同样能正常工作。
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
/* widget 桥接                                                         */
/* ------------------------------------------------------------------ */

    /** 当前标签的文本 —— 编辑区里显示的就是它。 */
    getText() {
        return this.editor.value;
    }

/**
     * 节点的全部文本，加上当前活动项的下标。
     *
     * 这就是送往后端的值：每条待命文本一项，按标签顺序排列，
     * 于是第 i 个输出就带第 i 条文本。活动项下标告诉后端
     * 主输出该携带哪一条文本。
     */
    getTextsPayload() {
        const state = this.state();
        const texts = state.tabs.map((tab) => tab.content);
        const active = state.tabs.findIndex((tab) => tab.id === state.active_id);
        return JSON.stringify({ texts, active: active < 0 ? 0 : active });
    }

/**
     * widget 值由标签状态推导而来，所以还原它的时候绝不能碰编辑区 ——
     * 应当是编辑区跟随标签状态。
     */
    setText() {
        // 故意留空
    }

    dispose() {
        this.clearUndoTimer();
        this.closeMenu();
        document.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    }
}

/**
 * 取出一个图里的全部连线。
 *
 * 前端把连线存在 Map 里，而较旧的构建用的是普通数组 —— 两种都得能用。
 */
function allLinks(graph) {
    const links = graph && graph.links;
    if (!links) {
        return [];
    }
    if (typeof links.values === "function") {
        return Array.from(links.values());
    }
    if (Array.isArray(links)) {
        return links.slice();
    }
    return Object.keys(links).map((key) => links[key]).filter(Boolean);
}

    /** 这条连线是不是从指定节点出发的？ */
function belongsToNode(link, node) {
    const origin = link.origin_id;
    if (!origin || !node) {
        return false;
    }
    if (origin === node || origin === node.id) {
        return true;
    }
    return origin.id !== undefined && origin.id === node.id;
}

    /** 找出某个节点的控制器（如果它有的话）。 */
function controllerOf(node) {
    return node && node.__multiTextTabs ? node.__multiTextTabs : null;
}

ensureStylesheet();

app.registerExtension({
    name: "comfyui-multi-text-tabs",

/**
     * 把这个输入重新声明为自定义 widget 类型，让节点只持有一个 DOM widget
     *（标签栏 + 编辑区），而不是原生 textarea 再加一个 widget。
     * 输入名保持不变，所以工作流文件和执行提示词里仍然是 "active_content"。
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
     * 为这个自定义输入类型提供 DOM widget。
     * 返回的 widget 是节点唯一的 widget，因此文本既会存进工作流文件，
     * 也会按名字发给后端。
     */
    getCustomWidgets() {
        return {
            [WIDGET_TYPE](node) {
                const controller = new MultiTextTabsController(node);
                node.__multiTextTabs = controller;

                const widget = node.addDOMWidget(INPUT_NAME, "multiTextTabs", controller.root, {
                    socketless: true,
                    // options.serialize 决定这个值是否进入执行请求 —— 必须进。
                    serialize: true,
                    hideOnZoom: false,
                    getValue: () => controller.getTextsPayload(),
                    setValue: (value) => controller.setText(value),
                    getMinHeight: () => 140,
                });
                // widget.serialize 决定这个值是否进入工作流文件。
                // 文本住在 node.properties 里，widget 不该再写第二遍。
                widget.serialize = false;
                controller.widget = widget;
                return { widget };
            },
        };
    },

    /** 节点被创建 —— 给它一份有效状态并绘制出来。 */
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

    /** 工作流被载入 —— 按还原出来的 properties 重新绘制。 */
    loadedGraphNode(node) {
        const controller = controllerOf(node);
        if (!controller) {
            return;
        }
        controller.state();
        controller.loadActiveIntoEditor();
        controller.render();
    },

    /** 载入钩子在图这一级的兜底处理。 */
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
