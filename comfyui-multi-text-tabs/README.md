# Multi-Text Tabs

A ComfyUI custom node that keeps several texts ("待命文本") in one node and
gives **each text its own STRING output socket** on the right side, so you can
always see which string is which. One extra socket - **主输出** - carries the
text of the 待命文本 that is currently selected.

```
┌────────────────────────────────────────────────────────────┐
│  Multi-Text Tabs   [待命文本 1] [待命文本 2] [待命文本 3]  [+]│
├────────────────────────────────────────────────────────────┤
│  当前待命文本（主输出）：待命文本 2                            │
│  A cinematic close-up, soft rim light, detailed fabric...   │
│  ...                                                        │
└────────────────────────────────────────────────────────────┘
     ● 待命文本 1   ● 待命文本 2   ● 待命文本 3   ● 主输出
```

## Features

- **One socket per text.** The number of output sockets always equals the
  number of 待命文本, and every socket is named after the text it carries
  (`待命文本 1`, `待命文本 2`, or your own name). Nothing is concatenated,
  nothing is hidden behind a single "current" output.
- **One more socket: 主输出 (main output).** It always carries the text of the
  待命文本 that is currently selected. Wire a downstream node to it once and
  switching tabs switches the content that is sent - no rewiring, no
  juggling with slot numbers.
- Add (＋) a new empty 待命文本 and type into it right away.
- The tab bar sits above the editor; the editor grows with the node.
- Close (×), rename (double click) and duplicate (right click) a text.
- Closing a non empty text offers an undo instead of a blocking dialog.
- The tab bar scrolls horizontally, so many texts still fit in one node.
- Switching texts never loses the last keystroke - the editor is the single
  source of truth and is committed before the active text changes.
- Works with Chinese, English, emoji and long prompts; nothing is trimmed and
  `{weight:1.5}` style braces are never interpolated.

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
| Click a 待命文本 | The current text is committed, then the selected text is loaded. The 主输出 now carries that text. |
| Click ＋ | Creates a new empty 待命文本 named `待命文本 N` and switches to it. |
| Click × | Closes the text. The last remaining text is never closed. |
| Double click a text | Renames it in place. The output socket is renamed with it. |
| Right click a text | Menu with rename / duplicate / close. |
| `Ctrl` + `Tab` | Next text (only while the node has the focus). |
| `Ctrl` + `Shift` + `Tab` | Previous text. |
| `Ctrl` + `N` | New text. |

Each socket is a standard STRING output and can be connected to any node that
accepts a STRING, for example **Preview as Text** or **Save Text**. Wire
`待命文本 1` into one consumer and `待命文本 2` into another and both texts
travel down their own path.

The **主输出** socket is the one to use when a downstream node should always
receive "whatever text is selected right now": connect it once, then click a
different 待命文本 and the next run sends that text. The node shows the current
selection in its status line ("当前待命文本（主输出）：…").

### Naming

- A text you never renamed is called `待命文本 N`, where N is its position.
  Deleting a text renumbers the remaining automatic names, so the list always
  reads `待命文本 1`, `待命文本 2`, `待命文本 3`.
- A text you renamed keeps that name, and its output socket carries the same
  name.

## How it is stored

| Data | Where | Reaches the backend? |
|---|---|---|
| All text titles and bodies | `node.properties.multi_text_tabs` | yes, as one JSON payload |
| The active text id | `node.properties.multi_text_tabs` | yes, as part of that payload |
| The widget value | widget `texts` (JSON payload) | yes |

The payload looks like this:

```
{"texts": ["first text", "second text"], "active": 1}
```

`texts` are all texts in tab order, `active` is the index of the text that is
currently selected - the backend needs it to fill the 主输出.

Two different serialisation switches are used on purpose:

- `widget.serialize = false` → the JSON array does **not** go into the
  workflow file; the bodies live once, in `node.properties`.
- `widget.options.serialize = true` → the JSON array **does** go into the
  execution request, so every text is available to the backend.

**Consequence worth knowing:** because every text has its own output, all
texts have to reach the backend. Editing *any* text therefore changes the
execution input of the node and invalidates the ComfyUI execution cache for
it. In v1.1 only the active text was sent, so editing an inactive text left
the cache alone. That is the price of "one output per text".

The workflow file is the only persistent storage. Nothing is kept in
`localStorage` or `sessionStorage`, so a workflow can be shared, versioned and
imported anywhere.

The text collection carries an internal marker that identifies it as one state
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
`/prompt` round trip whose outputs matched the submitted texts character by
character.

The frontend extension uses the documented extension API only:
`app.registerExtension`, `beforeRegisterNodeDef`, `getCustomWidgets`,
`nodeCreated` and `loadedGraphNode`. It never patches `LGraphNode.prototype`
or any other global object.

## Tests

The test suite needs neither a browser nor a running ComfyUI:

```
python tests/test_nodes.py                     # 15  backend contract
node tests/frontend/state.test.mjs             # 34  text state manager
node tests/frontend/check_extension.mjs        # 31  extension against a fake DOM
```

`check_extension.mjs` loads the shipped `web/multi_text_tabs.js` into a
`node:vm` context with a bounded fake DOM, so the file that is tested is the
file that ships. It also reproduces the reactive `node.properties` of the real
frontend, which is where the state identity bug of v1.0 lived, and it fakes
the output socket API of the real frontend - including the way it registers
links by slot number - so the "one socket per text plus 主输出" behaviour and
the link bookkeeping are covered.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The node shows a plain textarea without a tab bar | The frontend extension did not load. Open the browser console and look for `multi_text_tabs.js` errors; a hard refresh (`Ctrl` + `Shift` + `R`) reloads extensions. |
| No output sockets appear | The node definition was not reloaded. Restart ComfyUI after installing, then hard refresh the browser. |
| The 主输出 sends the wrong text | The browser still runs the extension of an older version - hard refresh (Ctrl + Shift + R) and check the status line. |
| Sockets are gone after reopening a workflow | The workflow was saved by v1.0/v1.1, which used a single `text` output. The texts are still there - add the sockets again in the new version. |
| A text shows an empty editor although it had text | The stored state was damaged; the node repairs it and logs the reason in the browser console. |

## License

MIT
