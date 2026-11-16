"""Multi-Text Tabs - ComfyUI custom node (backend).

One node holds several texts ("待命文本"). Every text gets its own STRING
output on the right side of the node, so a workflow can send each text to a
different downstream node and it stays visible which string is which.

Responsibility split (see the technical blueprint, section 3.3):

  all texts + their titles -> node.properties   (frontend only, the copy in
                                               the workflow file)
  the texts for execution -> widget "texts"     (a JSON array, one entry per
                                               待命文本, in tab order)
  node size / position    -> ComfyUI native node data

Consequence: because every text has its own output, all of them have to
reach the backend. The execution input therefore changes whenever any text
changes - that is the price of "one output per text".

The backend only parses the JSON array and hands the texts back unchanged -
no concatenation, no trimming, no prompt interpolation.
"""

import json
from typing import Dict, List, Tuple

#: Name of the widget that carries every text of the node.
#: The frontend extension re-binds this widget to a DOM widget, but the name
#: (and therefore the workflow / prompt key) stays "texts".
TEXTS = "texts"

#: How many texts a node can hold. The frontend shows one output socket per
#: text, so this is the upper bound of sockets a node can have.
MAX_TEXTS = 16


def parse_texts(raw) -> List[str]:
    """Turn the widget value into the list of texts.

    The frontend sends a JSON array. A value that is not valid JSON is taken
    as a single text, so a hand written API prompt still works.
    """
    if raw is None:
        return []
    if not isinstance(raw, str):
        raw = str(raw)
    stripped = raw.strip()
    if not stripped:
        return []
    if stripped.startswith("["):
        try:
            data = json.loads(stripped)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, list):
            texts = []
            for item in data:
                if item is None:
                    texts.append("")
                elif isinstance(item, str):
                    texts.append(item)
                else:
                    texts.append(str(item))
            return texts
    return [raw]


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

    RETURN_TYPES: Tuple[str, ...] = ("STRING",) * MAX_TEXTS
    RETURN_NAMES: Tuple[str, ...] = tuple("待命文本 %d" % (i + 1) for i in range(MAX_TEXTS))
    FUNCTION: str = "get_texts"
    CATEGORY: str = "utils/text"
    DESCRIPTION: str = (
        "Holds several texts in one node. Every text gets its own STRING output "
        "on the right side, named after the text it carries."
    )
    OUTPUT_NODE: bool = False

    def get_texts(self, texts: str) -> Tuple[str, ...]:
        """Return every text unchanged, one per output.

        The texts are passed through byte for byte: no trimming, no tag
        stripping, no interpolation. Outputs without a text are empty
        strings rather than errors.
        """
        items = parse_texts(texts)
        result = []
        for index in range(MAX_TEXTS):
            result.append(items[index] if index < len(items) else "")
        return tuple(result)