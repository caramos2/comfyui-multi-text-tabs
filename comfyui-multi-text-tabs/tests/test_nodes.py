"""Backend tests for the Multi-Text Tabs node.

The backend module deliberately has no ComfyUI dependency, so the tests run
with a plain Python interpreter:

    python tests/test_nodes.py

They also run under pytest:

    python -m pytest tests/test_nodes.py -q
"""

import importlib
import json
import os
import sys

_PACKAGE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PACKAGE_DIR)
# The package directory name contains dashes, so its parent has to be
# importable as well to import the package itself.
sys.path.insert(0, os.path.dirname(_PACKAGE_DIR))

from nodes import MAX_TEXTS, TEXTS, MultiTextTabsNode  # noqa: E402


def test_input_shape():
    inputs = MultiTextTabsNode.INPUT_TYPES()
    assert set(inputs.keys()) == {"required"}
    required = inputs["required"]
    assert list(required.keys()) == [TEXTS]
    spec_type, spec_options = required[TEXTS]
    assert spec_type == "STRING"
    assert spec_options["multiline"] is True
    # The text must reach the backend exactly as typed.
    assert spec_options["dynamicPrompts"] is False
    assert spec_options["default"] == ""


def test_output_shape():
    assert MultiTextTabsNode.RETURN_TYPES == ("STRING",) * MAX_TEXTS
    assert MultiTextTabsNode.RETURN_NAMES == tuple(
        "待命文本 %d" % (i + 1) for i in range(MAX_TEXTS)
    )
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
    payload = json.dumps(samples, ensure_ascii=False)
    result = node.get_texts(payload)
    assert list(result[: len(samples)]) == samples


def test_empty_is_valid():
    node = MultiTextTabsNode()
    assert node.get_texts("") == ("",) * MAX_TEXTS
    assert node.get_texts("[]") == ("",) * MAX_TEXTS


def test_none_becomes_empty_strings():
    node = MultiTextTabsNode()
    assert node.get_texts(None) == ("",) * MAX_TEXTS


def test_malformed_json_is_taken_as_one_text():
    node = MultiTextTabsNode()
    result = node.get_texts("[not json")
    assert result[0] == "[not json"
    assert result[1] == ""


def test_plain_text_is_taken_as_one_text():
    node = MultiTextTabsNode()
    result = node.get_texts("just a prompt")
    assert result[0] == "just a prompt"
    assert result[1] == ""


def test_non_string_items_are_stringified():
    node = MultiTextTabsNode()
    result = node.get_texts(json.dumps([123, None, True]))
    assert list(result[:3]) == ["123", "", "True"]


def test_one_slot_per_output():
    node = MultiTextTabsNode()
    result = node.get_texts(json.dumps(["a", "b"]))
    assert isinstance(result, tuple)
    assert len(result) == MAX_TEXTS
    assert list(result[:4]) == ["a", "b", "", ""]


def test_package_exports():
    # The package directory name contains dashes; importlib resolves such
    # names through the path finder just fine.
    package = importlib.import_module("comfyui-multi-text-tabs")
    node_class = package.NODE_CLASS_MAPPINGS["MultiTextTabs"]
    assert node_class.__name__ == "MultiTextTabsNode"
    # The package imports its own copy of the module, so compare behaviour
    # rather than object identity.
    assert node_class.INPUT_TYPES() == MultiTextTabsNode.INPUT_TYPES()
    assert node_class.RETURN_TYPES == MultiTextTabsNode.RETURN_TYPES
    assert package.NODE_DISPLAY_NAME_MAPPINGS["MultiTextTabs"] == "Multi-Text Tabs"
    assert package.WEB_DIRECTORY == "./web"
    web_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web"
    )
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
