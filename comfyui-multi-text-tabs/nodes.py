"""Multi-Text Tabs - ComfyUI custom node (backend).

One node holds several texts ("待命文本"). Every text gets its own STRING
output on the right side of the node, so a workflow can send each text to a
different downstream node and it stays visible which string is which.

On top of that there is one more output, "主输出" (main output). It always
carries the text of the 待命文本 that is currently selected in the node, so a
downstream node can be wired once and the workflow can be switched between
texts by clicking a tab.

Slot layout. The backend cannot have a variable number of outputs and the
frontend maps the visible sockets to these slots by index (the backend only
looks at the slot number of a link, never at the socket name - see the P0
report, section 2.8). The layout therefore is:

    slot 0 .. MAX_TEXTS-1   the texts, in tab order
    slot MAX_TEXTS          the main output

The frontend shows one socket per text plus the main output, so the visible
main output sits at index len(texts). To make that work the backend returns
the active text in every slot from len(texts) upwards: whichever of those
slots the frontend points at carries the current text.

Responsibility split (see the technical blueprint, section 3.3):

  all texts + their titles -> node.properties   (frontend only, the copy in
                                               the workflow file)
  the texts for execution -> widget "texts"     (a JSON payload with the
                                               texts and the active index)
  node size / position    -> ComfyUI native node data

Consequence: because every text has its own output, all of them have to
reach the backend. The execution input therefore changes whenever any text
changes - that is the price of "one output per text".

The backend only parses the payload and hands the texts back unchanged -
no concatenation, no trimming, no prompt interpolation.
"""

import json
from typing import Any, Dict, List, Tuple

#: Name of the widget that carries every text of the node.
#: The frontend extension re-binds this widget to a DOM widget, but the name
#: (and therefore the workflow / prompt key) stays "texts".
TEXTS = "texts"

#: How many texts a node can hold. The frontend shows one output socket per
#: text, so this is the upper bound of sockets a node can have.
MAX_TEXTS = 16

#: Name of the output that carries the text of the currently selected text.
MAIN_OUTPUT = "主输出"


def parse_payload(raw) -> Tuple[List[str], int]:
    """Turn the widget value into the texts and the index of the active one.

    The frontend sends a JSON object:

        {"texts": ["first", "second"], "active": 1}

    Two older shapes are still accepted so that a hand written API prompt
    and a workflow saved by v1.2 keep working:

    * a plain JSON array  -> the texts, the first one is active
    * anything else       -> a single text

    The active index is clamped into range; an index that does not point at
    a text falls back to the first text.
    """
    if raw is None:
        return [], 0
    if not isinstance(raw, str):
        raw = str(raw)
    stripped = raw.strip()
    if not stripped:
        return [], 0

    if stripped.startswith("{"):
        try:
            data = json.loads(stripped)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, dict):
            items = _as_text_list(data.get("texts"))
            active = _as_index(data.get("active"), len(items))
            return items, active

    if stripped.startswith("["):
        try:
            data = json.loads(stripped)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, list):
            return _as_text_list(data), 0

    return [raw], 0


def _as_text_list(value: Any) -> List[str]:
    """Normalise a list of texts without changing a single character."""
    if not isinstance(value, list):
        return []
    texts: List[str] = []
    for item in value:
        if item is None:
            texts.append("")
        elif isinstance(item, str):
            texts.append(item)
        else:
            texts.append(str(item))
    return texts


def _as_index(value: Any, count: int) -> int:
    """Clamp an index into the range of the texts."""
    try:
        index = int(value)
    except (TypeError, ValueError):
        index = 0
    if index < 0 or index >= count:
        index = 0
    return index


class MultiTextTabsNode:
    """Hand every text of the node back on its own STRING output."""

    @classmethod
    def INPUT_TYPES(cls) -> Dict:
        return {
            "required": {
                TEXTS: (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        # Keep the text verbatim. dynamicPrompts=True would let
                        # ComfyUI interpolate {...} weights inside the text and
                        # silently change what the user typed.
                        "dynamicPrompts": False,
                    },
                ),
            },
        }

    RETURN_TYPES: Tuple[str, ...] = ("STRING",) * (MAX_TEXTS + 1)
    RETURN_NAMES: Tuple[str, ...] = tuple(
        "待命文本 %d" % (i + 1) for i in range(MAX_TEXTS)
    ) + (MAIN_OUTPUT,)
    FUNCTION: str = "get_texts"
    CATEGORY: str = "utils/text"
    DESCRIPTION: str = (
        "Holds several texts in one node. Every text gets its own STRING output "
        "on the right side, named after the text it carries. The last output "
        "(主输出) always carries the text of the currently selected text."
    )
    OUTPUT_NODE: bool = False

    def get_texts(self, texts: str) -> Tuple[str, ...]:
        """Return every text unchanged, one per output, plus the main output.

        The texts are passed through byte for byte: no trimming, no tag
        stripping, no interpolation. The main output carries the text of the
        currently selected text; the slots behind it repeat that text so that
        the main output can sit at the end of the visible sockets.
        """
        items, active = parse_payload(texts)
        count = len(items)
        active_text = items[active] if count else ""
        result = []
        for index in range(MAX_TEXTS + 1):
            if index < count:
                result.append(items[index])
            else:
                # The main output lives behind the texts.
                result.append(active_text)
        return tuple(result)
