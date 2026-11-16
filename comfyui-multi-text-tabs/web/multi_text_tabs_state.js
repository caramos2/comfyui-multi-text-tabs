/**
 * Multi-Text Tabs - tab state manager.
 *
 * This module is deliberately free of any DOM or ComfyUI dependency so that it
 * can be unit tested in plain Node (see tests/frontend/).
 *
 * The whole tab collection lives in a single node property:
 *
 *   node.properties.multi_text_tabs = {
 *     version: 1,
 *     active_id: "tab_001",
 *     tabs: [ { id, title, content }, ... ]
 *   }
 *
 * Rules implemented here (blueprint sections 3.4, 6.3, 7):
 *   - ids are unique and stable;
 *   - at least one tab always exists;
 *   - content is always a string;
 *   - a damaged or missing state is repaired instead of throwing.
 */

/** Key under which the tab collection is stored in node.properties. */
export const STORAGE_KEY = "multi_text_tabs";

/** Current schema version of the tab collection. */
export const SCHEMA_VERSION = 1;

/** Prefix used for automatically generated tab titles. */
export const TITLE_PREFIX = "待命文本";

/** Longest title that is kept in the data (display is truncated further). */
export const MAX_TITLE_LENGTH = 120;

/**
 * Name of the non enumerable marker that identifies one state instance.
 *
 * Why this exists: the ComfyUI frontend keeps node.properties inside a Vue
 * reactive object. Reading a property back therefore returns a reactive
 * *proxy* of the object that was written - never the same object. Comparing
 * two states with "===" therefore never matches, every read looks like a
 * brand new state and any change made to a state that was fetched earlier is
 * written into an object that is no longer referenced by the node.
 *
 * The marker survives the proxy, so it gives us a stable identity. It is not
 * enumerable, so it never appears in the workflow file.
 */
export const STATE_MARKER = "__mtt_state_marker";

let markerCounter = 0;

/** A fresh marker value. */
export function createStateMarker() {
    markerCounter += 1;
    return "mtt-" + Date.now().toString(36) + "-" + markerCounter;
}

/**
 * Attach a marker to a state object.
 *
 * @param {object} state        the state to mark
 * @param {string} [marker]     marker to reuse, a new one is minted otherwise
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

/** The marker of a state object, or null when it has none. */
export function readStateMarker(state) {
    if (!state || typeof state !== "object") {
        return null;
    }
    const marker = state[STATE_MARKER];
    return typeof marker === "string" ? marker : null;
}

let idCounter = 0;

/**
 * Build an id that is not present in usedIds.
 * Ids look like "tab_001" and stay stable for the lifetime of the tab.
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
 * Normalise a user supplied title: trim, fall back when empty, cap length.
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
 * The next automatic title, e.g. "Text 2".
 * Starts from tabs.length + 1 and skips names that are already taken, so a
 * number the user has already seen is never silently reused.
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
 * Make a title unique by appending a counter: "Text 1", "Text 1 (2)", ...
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

/** A pristine state holding a single empty tab. */
export function defaultState(fallbackContent) {
    const content = typeof fallbackContent === "string" ? fallbackContent : "";
    return attachStateMarker({
        version: SCHEMA_VERSION,
        active_id: "tab_001",
        tabs: [{ id: "tab_001", title: TITLE_PREFIX + " 1", content }],
    });
}

/**
 * Repair whatever we find in node.properties into a valid state.
 *
 * @param {*} raw            the raw value stored in node.properties
 * @param {string} fallbackContent  text to use when there is no usable state
 * @returns {{state: object, issues: string[]}} repaired state plus a list of
 *          human readable notes about everything that had to be repaired.
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

    // Pass 1 - ids must exist and must be unique.
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

    // Pass 2 - titles must be non empty strings.
    const titles = [];
    staged.forEach((tab) => {
        const fallbackTitle = nextAutoTitle(titles);
        const title = sanitizeTitle(tab.title, fallbackTitle);
        titles.push(title);
        tab.title = title;
    });

    // Pass 3 - content must be a string.
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
    // A repaired state is still the same state, so it keeps its marker.
    return { state: attachStateMarker(state, readStateMarker(raw)), issues: issues };
}

/**
 * Renumber the automatically named texts so that they stay consecutive.
 *
 * Only titles that still look like "待命文本 3" are touched - a text the user
 * renamed keeps its own name.
 */
export function renumberAutoTitles(state) {
    const pattern = new RegExp("^" + TITLE_PREFIX + "\\s+\\d+$");
    state.tabs.forEach((tab, index) => {
        if (typeof tab.title === "string" && pattern.test(tab.title.trim())) {
            // The n-th text of the list is called "待命文本 n".
            const wanted = TITLE_PREFIX + " " + (index + 1);
            if (tab.title.trim() !== wanted) {
                tab.title = wanted;
            }
        }
    });
    return state;
}

/** Deep copy of a state (used when a node is copied). */
export function cloneState(state) {
    // A copy is an independent state, so it gets its own marker.
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

/** Find a tab by id. */
export function getTab(state, id) {
    if (!state || !Array.isArray(state.tabs)) {
        return null;
    }
    return state.tabs.find((tab) => tab.id === id) || null;
}

/** The tab whose text is currently being edited. */
export function getActiveTab(state) {
    return getTab(state, state && state.active_id);
}

/** Switch the active tab. Returns false when the id is unknown. */
export function setActiveTab(state, id) {
    if (!getTab(state, id)) {
        return false;
    }
    state.active_id = id;
    return true;
}

/**
 * Create a new tab.
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

/** Rename a tab. The text content is never touched. */
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
 * Duplicate a tab: same title pattern and same content, new id.
 * The copy becomes the active tab.
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
 * Close a tab. The last remaining tab is never removed.
 * When the active tab is closed the next tab becomes active (or the previous
 * one when the closed tab was the last).
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
    // The original position is reported so that an undo can put the tab back
    // where the user had it.
    return { closed: true, removed: removed, activated: activated, index: index };
}

/** Store new text in the active tab. */
export function setActiveContent(state, content) {
    const tab = getActiveTab(state);
    if (!tab) {
        return false;
    }
    tab.content = typeof content === "string" ? content : "";
    return true;
}

/** Titles of all tabs, in display order. */
export function tabTitles(state) {
    return state.tabs.map((tab) => tab.title);
}
