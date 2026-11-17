"""Multi-Text Tabs - ComfyUI 自定义节点（后端）。

一个节点里收纳多份文本（"待命文本"）。每条文本在节点右侧各有一个 STRING
输出端点，因此工作流可以把每条文本送到不同的下游节点，而且一眼能看清
哪根线走的是哪串文本。

除此之外还有一个"主输出"端点。它**永远**携带节点中当前选中的那条待命文本，
所以下游只要接一次线，工作流就能靠点击标签在不同文本之间切换。

槽位布局。后端无法拥有可变数量的输出，而前端是按序号把可见端点映射到
这些槽位上的（后端只看连线的槽位序号，从不看端点名 —— 见 P0 报告 §2.8）。
因此布局是：

    槽位 0 .. MAX_TEXTS-1   全部文本，按标签顺序
    槽位 MAX_TEXTS          主输出

    前端每条文本显示一个端点再加上主输出，所以可见的主输出位于下标
    len(texts)。为了让这件事成立，后端从 len(texts) 往后的每一个槽位都返回
当前文本：前端指向其中哪一个槽位，拿到的都是当前文本。

职责划分（见技术蓝图 §3.3）：

  全部文本 + 它们的标题 -> node.properties   （仅前端，工作流文件里的副本）
  供执行使用的文本      -> widget "texts"     （一段 JSON 载荷，含全部文本
                                                与当前活动项下标）
  节点尺寸 / 位置       -> ComfyUI 原生节点数据
  
                                               由此带来的代价：因为每条文本都有自己的输出，**全部文本都必须送达后端**。
  于是只要任何一条文本发生变化，节点的执行输入就会变 —— 这就是"一条文本
                                               一个端点"必须付出的代价。
  
后端只负责解析载荷，并把文本原样送回：不拼接、不 trim、不做提示词插值。
"""

import json
from typing import Any, Dict, List, Tuple

#: 承载节点全部文本的 widget 名。
#: 前端扩展会把这个 widget 重新绑定成 DOM widget，但名字
#: （也就是工作流 / 提示词里的键名）始终是 "texts"。
TEXTS = "texts"

#: 一个节点最多能装多少条文本。前端每条文本显示一个输出端点，
#: 所以这也是节点端点数量的上限。
MAX_TEXTS = 16

#: 承载"当前选中文本"的输出端点名。
MAIN_OUTPUT = "主输出"


def parse_payload(raw) -> Tuple[List[str], int]:
    """把 widget 的值解析成文本列表和当前活动项的下标。

    前端送来的是一个 JSON 对象：

        {"texts": ["first", "second"], "active": 1}

    另外两种更早的写法仍然被接受，这样手写的 API 提示词和 v1.2 存下来的
    工作流还能继续用：

    * 纯 JSON 数组    -> 视为全部文本，第一条为当前活动项
    * 其它任意内容    -> 视为单条文本

    活动项下标会被夹到有效范围内；指不到任何文本的下标一律回落到第一条。
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
    """把文本列表规范化，但一个字符都不改。"""
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
    """把下标夹到文本的有效范围内。"""
    try:
        index = int(value)
    except (TypeError, ValueError):
        index = 0
    if index < 0 or index >= count:
        index = 0
    return index


class MultiTextTabsNode:
    """把节点的每条文本分别从一个 STRING 输出端点送回。"""

    @classmethod
    def INPUT_TYPES(cls) -> Dict:
        return {
            "required": {
                TEXTS: (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        # 文本逐字保留。dynamicPrompts=True 会让
                        # ComfyUI 对文本里的 {...} 权重做插值，
                        # 从而悄悄改掉用户写的内容。
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
        "在一个节点里收纳多份文本。每条文本在右侧各有一个 STRING 输出端点，"
        "端点名与它承载的文本同名。最后一个输出（主输出）永远携带当前选中的那条文本。"
        )
    OUTPUT_NODE: bool = False

    def get_texts(self, texts: str) -> Tuple[str, ...]:
        """把每条文本原样送回，一个端点一条，外加主输出。

        文本逐字节透传：不 trim、不剥标签、不做插值。主输出携带当前选中的
        那条文本；它后面的槽位重复同一个值，好让主输出能待在可见端点的末尾。
        """
        items, active = parse_payload(texts)
        count = len(items)
        active_text = items[active] if count else ""
        result = []
        for index in range(MAX_TEXTS + 1):
            if index < count:
                result.append(items[index])
            else:
                # 主输出排在全部文本之后。
                result.append(active_text)
        return tuple(result)
