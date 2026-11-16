# Multi-Text Tabs

A ComfyUI custom node that keeps several texts in one node.

```
┌────────────────────────────────────────────────────────────┐
│  Multi-Text Tabs     [Text 1] [Text 2] [Text 3]   [+]      │
├────────────────────────────────────────────────────────────┤
│  当前标签：Text 2                                          │
│  A cinematic close-up, soft rim light, detailed fabric...   │
│  ...                                                        │
└────────────────────────────────────────────────────────────┘
```

The node has **one** text output. It always carries the text of the tab that
is currently selected. The other tabs are kept inside the node and travel with
the workflow file.

## Features

- One editor, many texts: switch with the tab bar, the editor follows.
- The tab bar sits above the editor; the editor grows with the node.
- Add (＋), close (×), rename (double click) and duplicate (right click) tabs.
- Closing a non empty tab offers an undo instead of a blocking dialog.
- The tab bar scrolls horizontally, so a hundred tabs still fit in one node.
- Switching tabs never loses the last keystroke - the editor is the single
  source of truth and is committed before the active tab changes.
- Works with Chinese, English, emoji and long prompts; nothing is trimmed.

## Installation

Copy the folder into the ComfyUI `custom_nodes` directory and restart
ComfyUI:

```
ComfyUI/
└── custom_nodes/
    └── comfyui-multi-text-tabs/
        ├── __init__.py
        ├── nodes.py
        ├── web/
        │   ├── multi_text_tabs.js
        │   ├── multi_text_tabs_state.js
        │   └── multi_text_tabs.css
        └── tests/
```

There are no Python dependencies - the node uses the ComfyUI standard library
only.

After the restart the node appears under the category **utils / text** as
**Multi-Text Tabs**.

## Usage

| Action | Result |
|---|---|
| Click a tab | The current text is committed, then the selected text is loaded. |
| Click ＋ | Creates a new empty tab named `Text N` and switches to it. |
| Click × | Closes the tab. The last remaining tab is never closed. |
| Double click a tab | Renames it in place. |
| Right click a tab | Menu with rename / duplicate / close. |
| `Ctrl` + `Tab` | Next tab (only while the node has the focus). |
| `Ctrl` + `Shift` + `Tab` | Previous tab. |
| `Ctrl` + `N` | New tab. |

The output `text` can be connected to any node that accepts a STRING, for
example **Preview as Text** or **Save Text**.

## How it is stored

| Data | Where | Reaches the backend? |
|---|---|---|
| All tab titles and texts | `node.properties.multi_text_tabs` | no |
| The active tab id | `node.properties.multi_text_tabs` | no |
| The text of the active tab | widget `active_content` | yes |

Because only the active text reaches the backend, editing a tab that is not
active does not change the execution input and does not invalidate the
ComfyUI execution cache.

The workflow file is the only persistent storage. Nothing is kept in
`localStorage` or `sessionStorage`, so a workflow can be shared, versioned and
imported anywhere.

The tab collection carries an internal marker that identifies it as one state
instance. The marker is not enumerable, so it never shows up in the workflow
file. It exists for a concrete reason: the frontend keeps `node.properties`
inside a Vue reactive object, so reading a property back returns a proxy
instead of the object that was written. Object identity therefore cannot be
used to recognise "the same state", and without the marker every change would
be written into an object the node no longer references.

## Compatibility

| Item | Version |
|---|---|
| ComfyUI backend | tested with v0.45.0 |
| ComfyUI frontend | tested with 1.58.5 |

Tested end to end in a real browser: adding, switching, renaming (double
click), the right click menu, saving a workflow and loading it back, and a
`/prompt` round trip whose output matched the submitted text character by
character.

The frontend extension uses the documented extension API only:
`app.registerExtension`, `beforeRegisterNodeDef`, `getCustomWidgets`,
`nodeCreated` and `loadedGraphNode`. It never patches `LGraphNode.prototype`
or any other global object.

## Tests

The test suite needs neither a browser nor a running ComfyUI:

```
python tests/test_nodes.py                     #  8  backend contract
node tests/frontend/state.test.mjs             # 31  tab state manager
node tests/frontend/check_extension.mjs        # 25  extension against a fake DOM
```

`check_extension.mjs` loads the shipped `web/multi_text_tabs.js` into a
`node:vm` context with a bounded fake DOM, so the file that is tested is the
file that ships. It also reproduces the reactive `node.properties` of the real
frontend, which is where the state identity bug of v1.0 lived.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The node shows a plain textarea without a tab bar | The frontend extension did not load. Open the browser console and look for `multi_text_tabs.js` errors; a hard refresh (`Ctrl` + `Shift` + `R`) reloads extensions. |
| Tabs are gone after reopening a workflow | The workflow was saved by an older version that did not store `multi_text_tabs`. The node then falls back to a single `Text 1` holding the current text. |
| A tab shows an empty editor although it had text | The stored state was damaged; the node repairs it and logs the reason in the browser console. |

## License

MIT
