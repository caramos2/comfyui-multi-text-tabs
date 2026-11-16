"""Multi-Text Tabs - ComfyUI custom node package.

Exports the node class mapping, the display-name mapping and the web
directory so that ComfyUI serves the frontend extension from
custom_nodes/comfyui-multi-text-tabs/web/.
"""

from .nodes import MultiTextTabsNode

NODE_CLASS_MAPPINGS = {
    "MultiTextTabs": MultiTextTabsNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiTextTabs": "Multi-Text Tabs",
}

#: ComfyUI serves this directory at /extensions/comfyui-multi-text-tabs/
WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]