"""Multi-Text Tabs - ComfyUI custom node (backend).

The backend is deliberately tiny, because the interesting part of this node
lives in the frontend.

Responsibility split (see the technical blueprint, section 3.3):

  all tab titles + texts   -> node.properties      (never reaches backend)
  active tab id            -> node.properties      (never reaches backend)
  text of the active tab   -> widget active_content (reaches backend)
  node size / position     -> ComfyUI native node data

Consequence: editing an *inactive* tab never changes the backend execution
input, so it never invalidates the execution cache. Only switching to another
tab (or typing in the active one) produces a new execution input.

The backend therefore receives exactly one STRING and returns it unchanged -
no concatenation, no trimming, no prompt interpolation.
"""

from typing import Dict, Tuple

#: Name of the widget that carries the text of the currently active tab.
#: The frontend extension re-binds this widget to a DOM widget, but the name
#: (and therefore the workflow / prompt key) stays "active_content".
ACTIVE_CONTENT = "active_content"


class MultiTextTabsNode:
    """Echo the text of the active tab back on a single STRING output."""

    @classmethod
    def INPUT_TYPES(cls) -> Dict:
        return {
            "required": {
                ACTIVE_CONTENT: (
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

    RETURN_TYPES: Tuple[str, ...] = ("STRING",)
    RETURN_NAMES: Tuple[str, ...] = ("text",)
    FUNCTION: str = "get_text"
    CATEGORY: str = "utils/text"
    DESCRIPTION: str = (
        "Holds several texts in one node. Switch between them with the tab bar "
        "above the editor; the output always carries the text of the active tab."
    )
    OUTPUT_NODE: bool = False

    def get_text(self, active_content: str) -> Tuple[str]:
        """Return the active tab's text unchanged.

        The text is passed through byte for byte: no trimming, no tag
        stripping, no interpolation. An empty tab yields an empty string
        rather than an error.
        """
        if active_content is None:
            return ("",)
        if not isinstance(active_content, str):
            return (str(active_content),)
        return (active_content,)