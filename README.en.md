# Multi-Text Tabs

> 中文版：[README.md](README.md) ｜ This is the English version.

A ComfyUI custom node that keeps several texts ("待命文本") in one node and gives **each text its own STRING output socket** on the right side, so you can always see which string is which. One extra socket - **主输出** (main output) - carries the text of the text that is currently selected.

```
┌────────────────────────────────────────────────────────────┐
│  Multi-Text Tabs   [待命文本 1] [待命文本 2] [待命文本 3]  [+]│
├────────────────────────────────────────────────────────────┤
│  当前待命文本（主输出）：待命文本 2                           │
│  A cinematic close-up, soft rim light, detailed fabric...   │
│  ...                                                        │
└────────────────────────────────────────────────────────────┘
     ● 待命文本 1   ● 待命文本 2   ● 待命文本 3   ● 主输出
```

## Features

- **One socket per text.** The number of output sockets always equals the number of texts, and every socket is named after the text it carries. Nothing is concatenated, nothing is hidden behind a single "current" output.
- **One more socket: 主输出 (main output).** It always carries the text of the currently selected text. Wire a downstream node to it once and switching tabs switches the content that is sent - no rewiring, no juggling with slot numbers.
- Add (＋) a new empty text and type into it right away.
- The tab bar sits above the editor; the editor grows with the node.
- Close (×), rename (double click) and duplicate (right click) a text.
- Closing a non empty text offers an undo instead of a blocking dialog.
- The tab bar scrolls horizontally, so many texts still fit in one node.
- Switching texts never loses the last keystroke - the editor is the single source of truth and is committed before the active text changes.
- Works with Chinese, English, emoji and long prompts; nothing is trimmed and `{weight:1.5}` style braces are never interpolated.

## Requirements

| Item | Requirement |
|---|---|
| ComfyUI backend | tested with v0.45.0 |
| ComfyUI frontend | tested with 1.58.5 (Vue 3) |
| Python dependencies | **none** (standard library only) |

## Installation

Clone or download this repository into the ComfyUI `custom_nodes` directory and restart ComfyUI:

```
ComfyUI/
└── custom_nodes/
    └── ComfyUI_MultiTextTabs/      ← the repository root IS the plugin package
        ├── __init__.py
        ├── nodes.py
        ├── web/
        │   ├── multi_text_tabs.js
        │   ├── multi_text_tabs_state.js
        │   └── multi_text_tabs.css
        └── tests/
```

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/caramos/comfyui-multi-text-tabs.git
```

After the restart the node appears under the category **utils / text** as **Multi-Text Tabs**.

## Quick start

1. Add a **Multi-Text Tabs** node to the canvas.
2. Click **＋** to create several texts and fill them with different content.
3. Connect **主输出** to a downstream node (for example **Preview as Text** or **Save Text**).
4. Click a different tab and hit run - that is the text that gets sent.

To pin one specific text, connect its own socket (`待命文本 1`, `待命文本 2`, ...) instead; each one travels down its own path.

## Usage

| Action | Result |
|---|---|
| Click a text | The current text is committed, then the selected text is loaded. The main output now carries that text. |
| Click ＋ | Creates a new empty text named `待命文本 N` and switches to it. |
| Click × | Closes the text. The last remaining text is never closed. |
| Double click a text | Renames it in place. The output socket is renamed with it. |
| Right click a text | Menu with rename / duplicate / close. |
| `Ctrl` + `Tab` | Next text (only while the node has the focus). |
| `Ctrl` + `Shift` + `Tab` | Previous text. |
| `Ctrl` + `N` | New text. |

Every socket is a standard STRING output and can be connected to any node that accepts a STRING.

### How it is stored

| Data | Where | Reaches the backend? |
|---|---|---|
| All text titles and bodies | `node.properties.multi_text_tabs` | yes, as one JSON payload |
| The active text index | same | yes, as part of that payload |
| The widget value | widget `texts` (JSON payload) | yes |

```json
{"texts": ["first text", "second text"], "active": 1}
```

Two different serialisation switches are used on purpose:

- `widget.serialize = false` → the JSON array does **not** go into the workflow file; the bodies live once, in `node.properties`.
- `widget.options.serialize = true` → the JSON array **does** go into the execution request, so every text is available to the backend.

**A consequence worth knowing:** because every text has its own output, all texts have to reach the backend. Editing *any* text therefore changes the execution input of the node and invalidates the ComfyUI execution cache for it. That is the price of "one output per text".

The workflow file is the only persistent storage. Nothing is kept in `localStorage` or `sessionStorage`.

## Project layout

```
.
├── __init__.py              node class mapping, display-name mapping, web directory
├── nodes.py                 backend: parses the payload and hands the texts back
├── web/
│   ├── multi_text_tabs.js        frontend extension (DOM widget + tab bar + sockets)
│   ├── multi_text_tabs_state.js  pure state manager (no DOM dependency)
│   └── multi_text_tabs.css       node styles, all scoped under .mtt-*
├── tests/
│   ├── test_nodes.py             backend contract (15 tests)
│   └── frontend/
│       ├── state.test.mjs        state manager (34 tests)
│       └── check_extension.mjs   fake DOM end to end (31 tests)
└── docs/                        technical documentation (Chinese)
```

### Why the main output sits at the end

The ComfyUI backend resolves a link to an output by its **slot number only**, never by the socket name (`received_type = RETURN_TYPES[val[1]]` in `execution.py`). Keeping the main output at the end means **the slot numbers of the text outputs never shift**, so existing workflows keep working.

## Tests

Neither a browser nor a running ComfyUI is needed:

```
python tests/test_nodes.py                     # 15  backend contract
node tests/frontend/state.test.mjs             # 34  text state manager
node tests/frontend/check_extension.mjs        # 31  extension against a fake DOM
```

`check_extension.mjs` loads the shipped `web/multi_text_tabs.js` into a `node:vm` context with a bounded fake DOM, so the file that is tested is the file that ships.

## Roadmap

Planned, not implemented yet - issues and PRs are welcome:

- Raise the per-node text limit (currently 16).
- Text search / quick jump to a specific tab.
- Import and export of texts as standalone plain-text snippets.

## FAQ

**Q: The node shows a plain textarea without a tab bar?**
The frontend extension did not load. Open the browser console and look for `multi_text_tabs.js` errors; a hard refresh (`Ctrl` + `Shift` + `R`) reloads extensions.

**Q: No output sockets appear?**
The node definition was not reloaded. Restart ComfyUI after installing, then hard refresh the browser.

**Q: The main output sends the wrong text?**
The browser still runs the extension of an older version - hard refresh (Ctrl + Shift + R) and check the status line.

**Q: Sockets are gone after reopening a workflow?**
The workflow was saved by v1.0/v1.1, which used a single `text` output. The texts are still there - add the sockets again in the new version.

**Q: A text shows an empty editor although it had text?**
The stored state was damaged; the node repairs it and logs the reason in the browser console.

**Q: `Ctrl` + `Tab` does nothing?**
Some browsers claim that shortcut. Use `Ctrl` + `N` or click the tab instead.

## Contributing

Issues and PRs are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Security

Please do not open a public issue for a security problem - see [SECURITY.md](SECURITY.md).

## Acknowledgements

- Thanks to the **ComfyUI** project for its stable extension API (`app.registerExtension`, `beforeRegisterNodeDef`, `getCustomWidgets`, `nodeCreated`, `loadedGraphNode`).
- Thanks to **LiteGraph** for the canvas and node model.

This project **contains no third-party code**. The frontend extension uses only the documented extension API and never patches `LGraphNode.prototype` or any other global; all styles are scoped under `.mtt-*`.

## License

[MIT](LICENSE) © 2026 caramos

The project is licensed under the MIT License, including the standard "AS IS" warranty disclaimer: the software is provided as is, without warranty of any kind, and the authors are not liable for any claim, damages or other liability arising from the use of the software.
