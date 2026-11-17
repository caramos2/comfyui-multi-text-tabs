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

from nodes import MAIN_OUTPUT, MAX_TEXTS, TEXTS, MultiTextTabsNode  # noqa: E402


def payload(texts, active=0):
    """The widget value the frontend sends."""
    return json.dumps({"texts": texts, "active": active}, ensure_ascii=False)


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
    # 16 text slots plus the main output.
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
    # One text -> the main output (slot 1) carries that same text.
    assert result[1] == "[not json"


def test_plain_text_is_taken_as_one_text():
    node = MultiTextTabsNode()
    result = node.get_texts("just a prompt")
    assert result[0] == "just a prompt"
    # One text -> the main output (slot 1) carries that same text.
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
    """The main output sits behind the texts, at slot len(texts)."""
    node = MultiTextTabsNode()
    result = node.get_texts(payload(["a", "b", "c"], active=2))
    assert result[0] == "a"
    assert result[1] == "b"
    assert result[2] == "c"
    # Slot 3 is the main output (three texts), the slots behind it repeat it.
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
    """A payload written by v1.2 has no active index."""
    node = MultiTextTabsNode()
    result = node.get_texts(json.dumps(["a", "b"]))
    assert result[0] == "a"
    assert result[1] == "b"
    # Without an index the first text is the active one.
    assert result[2] == "a"


def test_active_index_out_of_range_falls_back():
    node = MultiTextTabsNode()
    assert node.get_texts(payload(["a", "b"], active=99))[2] == "a"
    assert node.get_texts(payload(["a", "b"], active=-1))[2] == "a"
    assert node.get_texts(payload(["a", "b"], active="x"))[2] == "a"


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
