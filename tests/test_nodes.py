"""多文本标签节点的后端测试。

后端模块刻意不依赖 ComfyUI，因此这些测试用纯 Python 解释器即可运行：

    python tests/test_nodes.py

在 pytest 下同样可以运行：

    python -m pytest tests/test_nodes.py -q
"""

import importlib
import importlib.util
import json
import os
import sys

_PACKAGE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PACKAGE_DIR)
# 插件包目录名里带有连字符，因此它的上级目录也必须可导入，
# 才能把插件包本身导入进来。
sys.path.insert(0, os.path.dirname(_PACKAGE_DIR))

from nodes import MAIN_OUTPUT, MAX_TEXTS, TEXTS, MultiTextTabsNode  # noqa: E402


def payload(texts, active=0):
    """前端发过来的控件值。"""
    return json.dumps({"texts": texts, "active": active}, ensure_ascii=False)


def test_input_shape():
    inputs = MultiTextTabsNode.INPUT_TYPES()
    assert set(inputs.keys()) == {"required"}
    required = inputs["required"]
    assert list(required.keys()) == [TEXTS]
    spec_type, spec_options = required[TEXTS]
    assert spec_type == "STRING"
    assert spec_options["multiline"] is True
    # 文本必须原样送达后端，不做任何加工。
    assert spec_options["dynamicPrompts"] is False
    assert spec_options["default"] == ""


def test_output_shape():
    # 16 个待命文本槽位，外加主输出。
    assert MultiTextTabsNode.RETURN_TYPES == ("STRING",) * (MAX_TEXTS + 1)
    assert MultiTextTabsNode.RETURN_NAMES == tuple(
        "待命文本 %d" % (i + 1) for i in range(MAX_TEXTS)
    ) + (MAIN_OUTPUT,)
    assert MultiTextTabsNode.FUNCTION == "get_texts"
    assert MultiTextTabsNode.CATEGORY == "utils/text"
    assert hasattr(MultiTextTabsNode, "get_texts")


def test_texts_are_returned_verbatim():
    node = MultiTextTabsNode()
    samples = [
        "",
        "hello",
        "  leading and trailing  ",
        "line one\nline two\n",
        "emoji \U0001f3ac and CJK \u4e2d\u6587",
        "brace {weight:1.5} stays literal",
        "tabs\tand\r\nwindows newlines",
    ]
    result = node.get_texts(payload(samples))
    assert list(result[: len(samples)]) == samples


def test_empty_is_valid():
    node = MultiTextTabsNode()
    assert node.get_texts("") == ("",) * (MAX_TEXTS + 1)
    assert node.get_texts("[]") == ("",) * (MAX_TEXTS + 1)
    assert node.get_texts(payload([])) == ("",) * (MAX_TEXTS + 1)


def test_none_becomes_empty_strings():
    node = MultiTextTabsNode()
    assert node.get_texts(None) == ("",) * (MAX_TEXTS + 1)


def test_malformed_json_is_taken_as_one_text():
    node = MultiTextTabsNode()
    result = node.get_texts("[not json")
    assert result[0] == "[not json"
    # 只有一段文本 -> 主输出（槽位 1）承载的也是同一段文本。
    assert result[1] == "[not json"


def test_plain_text_is_taken_as_one_text():
    node = MultiTextTabsNode()
    result = node.get_texts("just a prompt")
    assert result[0] == "just a prompt"
    # 只有一段文本 -> 主输出（槽位 1）承载的也是同一段文本。
    assert result[1] == "just a prompt"


def test_non_string_items_are_stringified():
    node = MultiTextTabsNode()
    result = node.get_texts(payload([123, None, True]))
    assert list(result[:3]) == ["123", "", "True"]


def test_one_slot_per_output():
    node = MultiTextTabsNode()
    result = node.get_texts(payload(["a", "b"]))
    assert isinstance(result, tuple)
    assert len(result) == MAX_TEXTS + 1
    assert list(result[:4]) == ["a", "b", "a", "a"]


def test_main_output_carries_the_active_text():
    """主输出排在所有待命文本之后，位于槽位 len(texts)。"""
    node = MultiTextTabsNode()
    result = node.get_texts(payload(["a", "b", "c"], active=2))
    assert result[0] == "a"
    assert result[1] == "b"
    assert result[2] == "c"
    # 槽位 3 是主输出（三段文本），它后面的槽位都重复它。
    assert result[3] == "c"
    assert set(result[3:]) == {"c"}


def test_main_output_follows_the_active_index():
    node = MultiTextTabsNode()
    assert node.get_texts(payload(["a", "b", "c"], active=0))[3] == "a"
    assert node.get_texts(payload(["a", "b", "c"], active=1))[3] == "b"
    assert node.get_texts(payload(["a", "b", "c"], active=2))[3] == "c"


def test_main_output_is_the_only_repeated_slot():
    node = MultiTextTabsNode()
    result = node.get_texts(payload(["a", "b"], active=1))
    assert result[0] == "a"
    assert result[1] == "b"
    assert result[2] == "b"


def test_legacy_array_payload_still_works():
    """v1.2 写出的负载没有活动索引。"""
    node = MultiTextTabsNode()
    result = node.get_texts(json.dumps(["a", "b"]))
    assert result[0] == "a"
    assert result[1] == "b"
    # 没有索引时，第一段文本就是活动文本。
    assert result[2] == "a"


def test_active_index_out_of_range_falls_back():
    node = MultiTextTabsNode()
    assert node.get_texts(payload(["a", "b"], active=99))[2] == "a"
    assert node.get_texts(payload(["a", "b"], active=-1))[2] == "a"
    assert node.get_texts(payload(["a", "b"], active="x"))[2] == "a"


def test_package_exports():
    # 仓库根目录就是自定义节点包：ComfyUI 会加载它被克隆到的那个目录下的
    # __init__.py。
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    spec = importlib.util.spec_from_file_location(
        "mtt_package",
        os.path.join(root, "__init__.py"),
        submodule_search_locations=[root],
    )
    package = importlib.util.module_from_spec(spec)
    sys.modules["mtt_package"] = package
    spec.loader.exec_module(package)
    node_class = package.NODE_CLASS_MAPPINGS["MultiTextTabs"]
    assert node_class.__name__ == "MultiTextTabsNode"
    # 插件包会导入自己那份模块副本，因此这里比较的是行为，
    # 而不是对象是否同一个。
    assert node_class.INPUT_TYPES() == MultiTextTabsNode.INPUT_TYPES()
    assert node_class.RETURN_TYPES == MultiTextTabsNode.RETURN_TYPES
    assert package.NODE_DISPLAY_NAME_MAPPINGS["MultiTextTabs"] == "Multi-Text Tabs"
    assert package.WEB_DIRECTORY == "./web"
    assert package.__version__ == "1.3"
    web_dir = os.path.join(root, "web")
    assert os.path.isfile(os.path.join(web_dir, "multi_text_tabs.js"))
    assert os.path.isfile(os.path.join(web_dir, "multi_text_tabs.css"))
    assert os.path.isfile(os.path.join(web_dir, "multi_text_tabs_state.js"))


def main():
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = []
    for test in tests:
        try:
            test()
            print("PASS %s" % test.__name__)
        except Exception as error:  # noqa: BLE001
            failures.append((test.__name__, error))
            print("FAIL %s: %s" % (test.__name__, error))
    print("\n%d passed, %d failed" % (len(tests) - len(failures), len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
