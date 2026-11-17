# 贡献指南

感谢你愿意为 Multi-Text Tabs 出力。这份文档说明**改动口径**和**验收要求**，让你的 PR 更容易被合并。

## 环境准备

```bash
git clone https://github.com/caramos/comfyui-multi-text-tabs.git
cd ComfyUI/custom_nodes/comfyui-multi-text-tabs
```

本项目**没有 Python 第三方依赖**，前端也没有构建步骤——仓库里放的就是发布文件。

## 开发与测试

三套测试都不需要浏览器，也不需要跑起来的 ComfyUI：

```bash
python tests/test_nodes.py                     # 15  后端契约
node tests/frontend/state.test.mjs             # 34  文本状态机
node tests/frontend/check_extension.mjs        # 31  假 DOM 端到端
```

**改动之后必须三套全绿**，并在 PR 里贴出真实输出。

在 ComfyUI 里真机验证时，把插件装到 `ComfyUI/custom_nodes/` 下并重启 ComfyUI。

## 代码风格

- **界面文案、代码注释、文档一律中文**；术语统一用「待命文本」「主输出」「端点」「槽位」「连线」。
- 保留英文的只有：技术专有名词（JSON、ComfyUI、LiteGraph、Vue、DOM、API 等）、代码标识符、示例命令。
- 前端缩进 **4 空格**；Python **4 空格**。
- 不引入新的构建工具或打包步骤。

## 改动口径（重要）

### 只能改注释，不能改逻辑

本项目的代码逻辑是**经过真机验收**的。要翻译注释、补充说明，随便改；但凡涉及运行行为的改动，都必须在 PR 里说明理由并附真机验证结果。

评审时会检查：**去掉注释后，代码与改动前逐字符相同**。

### 几条不能碰的红线

- **不拼接文本、不 trim、不做提示词插值**（`dynamicPrompts=False`）。
- **不依赖 `localStorage` / `sessionStorage`**——工作流文件是唯一的持久化来源。
- **不全局覆盖 `LGraphNode.prototype`** 或任何全局对象，只用官方文档化的扩展接口。
- **用户输入一律用 `textContent`**，不用 `innerHTML`。
- **样式一律以 `.mtt-` 前缀作用域隔离**，避免影响 ComfyUI 界面其余部分。

### 输出端点的顺序

ComfyUI 后端**只按端点序号**解析连线，不看端点名。因此「主输出」必须固定排在末尾——放在前面会让已有工作流里文本端点的序号全部错位。新增输出端点时请遵守这条。

## 提交信息

用中文或英文都可以，格式参考：

```
feat: 支持从文件导入文本
fix: 关闭文本后连线序号错位
docs: 补充 FAQ
chore: 汉化源码注释
```

一次提交只做一件事。

## 提 PR 之前

- [ ] 三套测试全绿，输出贴在 PR 里
- [ ] 改了行为的话，附上真机验证步骤和结果
- [ ] README 里受影响的章节同步更新
- [ ] 新功能在 [CHANGELOG.md](CHANGELOG.md) 里记一笔

## 报告 Bug

请用 [Bug 反馈模板](.github/ISSUE_TEMPLATE/bug_report.md)，并附上：

- ComfyUI 后端版本（`/comfyui_version` 或启动日志）、前端版本、浏览器版本；
- 节点属性的截图（能看出标签栏和输出端点）；
- 浏览器控制台的报错（如果有）。
