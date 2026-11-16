/**
 * Unit tests for the pure tab state manager.
 *
 *     node tests/frontend/state.test.mjs
 *
 * No framework, no browser, no ComfyUI - the module under test has no
 * dependencies at all.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stateUrl = pathToFileURL(resolve(here, "..", "..", "web", "multi_text_tabs_state.js")).href;
const S = await import(stateUrl);

const tests = [];
function test(name, fn) {
    tests.push([name, fn]);
}

/* ---------------------------------------------------------------- default */

test("defaultState holds one empty tab", () => {
    const state = S.defaultState();
    assert.equal(state.version, S.SCHEMA_VERSION);
    assert.equal(state.tabs.length, 1);
    assert.equal(state.tabs[0].title, "待命文本 1");
    assert.equal(state.tabs[0].content, "");
    assert.equal(state.active_id, state.tabs[0].id);
});

test("defaultState can adopt the fallback content", () => {
    const state = S.defaultState("kept text");
    assert.equal(state.tabs[0].content, "kept text");
});

/* -------------------------------------------------------------- normalize */

test("normalizeState repairs a missing state", () => {
    const { state, issues } = S.normalizeState(undefined, "fallback");
    assert.equal(state.tabs.length, 1);
    assert.equal(state.tabs[0].content, "fallback");
    assert.ok(issues.length > 0);
});

test("normalizeState repairs a non object state", () => {
    const { state } = S.normalizeState("nonsense", "");
    assert.equal(state.tabs.length, 1);
});

test("normalizeState repairs a non array tabs field", () => {
    const { state, issues } = S.normalizeState({ version: 1, tabs: {} }, "");
    assert.equal(state.tabs.length, 1);
    assert.ok(issues.some((i) => i.includes("tabs")));
});

test("normalizeState repairs an empty tab list", () => {
    const { state } = S.normalizeState({ version: 1, active_id: "x", tabs: [] }, "");
    assert.equal(state.tabs.length, 1);
    assert.equal(state.active_id, state.tabs[0].id);
});

test("normalizeState reassigns duplicate ids without merging content", () => {
    const { state, issues } = S.normalizeState({
        version: 1,
        active_id: "tab_1",
        tabs: [
            { id: "tab_1", title: "A", content: "first" },
            { id: "tab_1", title: "B", content: "second" },
        ],
    }, "");
    assert.equal(state.tabs.length, 2);
    assert.notEqual(state.tabs[0].id, state.tabs[1].id);
    assert.equal(state.tabs[0].content, "first");
    assert.equal(state.tabs[1].content, "second");
    assert.ok(issues.some((i) => i.includes("duplicate")));
});

test("normalizeState falls back to the first tab for an unknown active id", () => {
    const { state, issues } = S.normalizeState({
        version: 1,
        active_id: "ghost",
        tabs: [{ id: "a", title: "A", content: "" }],
    }, "");
    assert.equal(state.active_id, "a");
    assert.ok(issues.some((i) => i.includes("active_id")));
});

test("normalizeState resets non string content", () => {
    const { state, issues } = S.normalizeState({
        version: 1,
        tabs: [{ id: "a", title: "A", content: 42 }],
    }, "");
    assert.equal(state.tabs[0].content, "");
    assert.ok(issues.some((i) => i.includes("non string")));
});

test("normalizeState keeps readable fields of an unknown version", () => {
    const { state, issues } = S.normalizeState({
        version: 99,
        active_id: "a",
        tabs: [{ id: "a", title: "Kept", content: "text" }],
    }, "");
    assert.equal(state.tabs[0].title, "Kept");
    assert.equal(state.tabs[0].content, "text");
    assert.ok(issues.some((i) => i.includes("version")));
});

test("normalizeState trims titles and fills empty ones", () => {
    const { state } = S.normalizeState({
        version: 1,
        tabs: [{ id: "a", title: "  Spaced  ", content: "" }, { id: "b", title: "   ", content: "" }],
    }, "");
    assert.equal(state.tabs[0].title, "Spaced");
    assert.equal(state.tabs[1].title, "待命文本 2");
});

test("normalizeState gives a tab without id a new one", () => {
    const { state } = S.normalizeState({
        version: 1,
        tabs: [{ title: "No id", content: "x" }],
    }, "");
    assert.ok(state.tabs[0].id);
});

/* --------------------------------------------------------------- editing */

test("addTab creates a unique id and activates the tab", () => {
    const state = S.defaultState();
    const tab = S.addTab(state, {});
    assert.equal(state.tabs.length, 2);
    assert.equal(state.active_id, tab.id);
    assert.equal(tab.title, "待命文本 2");
    assert.equal(tab.content, "");
    assert.notEqual(state.tabs[0].id, state.tabs[1].id);
});

test("addTab does not steal the focus when asked not to", () => {
    const state = S.defaultState();
    const before = state.active_id;
    S.addTab(state, { activate: false });
    assert.equal(state.active_id, before);
});

test("setActiveTab switches and rejects unknown ids", () => {
    const state = S.defaultState();
    const second = S.addTab(state, {});
    assert.equal(S.setActiveTab(state, second.id), true);
    assert.equal(state.active_id, second.id);
    assert.equal(S.setActiveTab(state, "nope"), false);
    assert.equal(state.active_id, second.id);
});

test("renameTab trims, falls back and keeps content", () => {
    const state = S.defaultState();
    state.tabs[0].content = "body";
    const renamed = S.renameTab(state, state.tabs[0].id, "  Character sheet  ");
    assert.equal(renamed.title, "Character sheet");
    assert.equal(renamed.content, "body");
});

test("renameTab rejects an empty name by keeping the old one", () => {
    const state = S.defaultState();
    const renamed = S.renameTab(state, state.tabs[0].id, "   ");
    assert.equal(renamed.title, "待命文本 1");
});

test("renameTab makes the name unique", () => {
    const state = S.defaultState();
    const second = S.addTab(state, {});
    S.renameTab(state, second.id, "待命文本 1");
    assert.notEqual(state.tabs[1].title, state.tabs[0].title);
});

test("duplicateTab copies title and content with a new id and activates", () => {
    const state = S.defaultState();
    state.tabs[0].title = "角色设定";
    state.tabs[0].content = "设定内容";
    const copy = S.duplicateTab(state, state.tabs[0].id);
    assert.equal(state.tabs.length, 2);
    assert.notEqual(copy.id, state.tabs[0].id);
    assert.equal(copy.content, "设定内容");
    assert.ok(copy.title.includes("Copy"));
    assert.equal(state.active_id, copy.id);
});

test("duplicateTab does not change the original tab", () => {
    const state = S.defaultState();
    state.tabs[0].content = "original";
    S.duplicateTab(state, state.tabs[0].id);
    assert.equal(state.tabs[0].content, "original");
});

test("closeTab keeps the last tab", () => {
    const state = S.defaultState();
    const result = S.closeTab(state, state.tabs[0].id);
    assert.equal(result.closed, false);
    assert.equal(state.tabs.length, 1);
});

test("closeTab activates the next tab when the active one is closed", () => {
    const state = S.defaultState();
    const second = S.addTab(state, {});
    const third = S.addTab(state, {});
    const result = S.closeTab(state, second.id);
    assert.equal(result.closed, true);
    assert.equal(state.active_id, third.id);
    assert.equal(state.tabs.length, 2);
});

test("closeTab falls back to the previous tab when the last one is closed", () => {
    const state = S.defaultState();
    S.addTab(state, {});
    const last = state.active_id;
    const result = S.closeTab(state, last);
    assert.equal(result.closed, true);
    assert.equal(result.activated, state.tabs[0].id);
    assert.equal(state.active_id, state.tabs[0].id);
});

test("closing an inactive tab keeps the active tab", () => {
    const state = S.defaultState();
    const second = S.addTab(state, {});
    S.setActiveTab(state, second.id);
    const result = S.closeTab(state, state.tabs[0].id);
    assert.equal(result.closed, true);
    assert.equal(state.active_id, second.id);
});

test("setActiveContent writes into the active tab only", () => {
    const state = S.defaultState();
    const second = S.addTab(state, {});
    S.setActiveContent(state, "for second");
    assert.equal(state.tabs[1].content, "for second");
    assert.equal(state.tabs[0].content, "");
    assert.equal(state.active_id, second.id);
});

/* ----------------------------------------------------------------- clone */

test("cloneState is a deep copy", () => {
    const state = S.defaultState();
    state.tabs[0].content = "text";
    const copy = S.cloneState(state);
    copy.tabs[0].content = "changed";
    copy.tabs[0].title = "Renamed";
    assert.equal(state.tabs[0].content, "text");
    assert.equal(state.tabs[0].title, "待命文本 1");
    assert.equal(copy.tabs[0].id, state.tabs[0].id);
});

/* ---------------------------------------------------------------- marker */

test("defaultState carries a marker", () => {
    const state = S.defaultState();
    assert.ok(S.readStateMarker(state));
});

test("the marker never reaches the workflow file", () => {
    const state = S.defaultState();
    const saved = JSON.parse(JSON.stringify(state));
    assert.ok(!(S.STATE_MARKER in saved));
});

test("normalizeState keeps the marker of the state it repairs", () => {
    const original = S.defaultState();
    const { state } = S.normalizeState(original, "");
    assert.equal(S.readStateMarker(state), S.readStateMarker(original));
});

test("normalizeState mints a marker for a state without one", () => {
    const { state } = S.normalizeState({
        version: 1,
        tabs: [{ id: "a", title: "A", content: "" }],
    }, "");
    assert.ok(S.readStateMarker(state));
});

test("cloneState is an independent state with its own marker", () => {
    const state = S.defaultState();
    const copy = S.cloneState(state);
    assert.ok(S.readStateMarker(copy));
    assert.notEqual(S.readStateMarker(copy), S.readStateMarker(state));
});

/* ------------------------------------------------------------- renumber */

test("closing a text renumbers the automatically named ones", () => {
    const state = S.defaultState();
    const second = S.addTab(state, {});
    S.addTab(state, {});
    assert.equal(state.tabs[2].title, "待命文本 3");
    S.closeTab(state, second.id);
    S.renumberAutoTitles(state);
    assert.equal(state.tabs[0].title, "待命文本 1");
    assert.equal(state.tabs[1].title, "待命文本 2");
});

test("a text the user renamed keeps its own name", () => {
    const state = S.defaultState();
    S.addTab(state, {});
    S.renameTab(state, state.tabs[1].id, "镜头描述");
    S.closeTab(state, state.tabs[0].id);
    S.renumberAutoTitles(state);
    assert.equal(state.tabs[0].title, "镜头描述");
});

test("renumbering does not touch a text the user renamed", () => {
    const state = S.defaultState();
    S.addTab(state, {});
    S.renameTab(state, state.tabs[0].id, "角色设定");
    S.renumberAutoTitles(state);
    assert.equal(state.tabs[0].title, "角色设定");
    assert.equal(state.tabs[1].title, "待命文本 2");
});

/* ------------------------------------------------------------------ run */

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log("PASS " + name);
    } catch (error) {
        failed += 1;
        console.log("FAIL " + name + ": " + error.message);
    }
}
console.log("\n" + (tests.length - failed) + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
