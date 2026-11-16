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

#: 1.1 - 真机验收修复：状态身份判定、事件阶段、变更通知（后端与工作流格式未变）
__version__ = "1.1"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]