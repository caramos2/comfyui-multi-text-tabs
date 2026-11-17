"""Multi-Text Tabs - ComfyUI 自定义节点包。

对外导出节点类映射、显示名映射和前端目录，
让 ComfyUI 能从 custom_nodes/comfyui-multi-text-tabs/web/ 提供前端扩展。
"""

from .nodes import MultiTextTabsNode

NODE_CLASS_MAPPINGS = {
    "MultiTextTabs": MultiTextTabsNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiTextTabs": "Multi-Text Tabs",
}

#: ComfyUI 会在 /extensions/comfyui-multi-text-tabs/ 下提供这个目录。
WEB_DIRECTORY = "./web"

#: 1.3 - 新增「主输出」端点，永远输出当前选中的待命文本
__version__ = "1.3"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]