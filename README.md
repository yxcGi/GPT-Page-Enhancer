# GPT Page Enhancer

GPT Page Enhancer 是一个面向 ChatGPT 网页的 Chrome 扩展，用来改善长内容阅读、公式复制和页面宽度控制体验。

它只在 `chatgpt.com` 和 `chat.openai.com` 生效，不会影响其他网站。

## 功能

- 调整 ChatGPT 对话内容的横向宽度，减少长回答被挤成很窄一列的问题。
- 通过滑条设置内容宽度，范围为 `45%` 到 `96%`。
- 点击悬浮图标可以收起或展开控制面板。
- 将已经发送出去的提问按 Markdown 形式显示。
- 点击页面中的公式可直接复制完整 LaTeX，自动保留 `$...$` 或 `$$...$$` 包裹符号。
- 复制同时包含文字和公式的选区时，会尽量将选区内的完整公式转换为 LaTeX。

## 安装

### 从 GitHub 下载

1. 打开本项目的 GitHub 页面。
2. 点击页面右上方的 `Code`。
3. 选择 `Download ZIP`。
4. 下载完成后，解压 ZIP 文件。
5. 记住解压后的文件夹位置，后续需要在 Chrome 中选择这个文件夹。

### 加载到 Chrome

1. 打开 Chrome，进入 `chrome://extensions/`。
2. 打开右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择刚才解压出来的项目文件夹。
5. 打开或刷新 ChatGPT 页面。

## 使用

### 调整内容宽度

进入 ChatGPT 页面后，页面会显示一个悬浮控制面板。拖动滑条即可调整回答区域的宽度。

如果面板遮挡内容，可以拖动左侧图标把它移动到屏幕任意位置。位置和宽度设置都会自动保存。

### Markdown 提问显示

发送出去的提问会按 Markdown 渲染，支持标题、列表、引用、代码块、行内代码、粗体、斜体和链接等常用格式。

### 复制公式

鼠标移动到公式上时，公式区域会出现可复制提示。点击公式后，插件会复制完整 LaTeX：

- 行内公式会复制为 `$...$`
- 块级公式会复制为 `$$...$$`

当你框选一段同时包含文字和公式的内容并复制时，插件会尝试把其中的公式替换为完整 LaTeX，而不是复制页面上渲染后的视觉文本。

## 适用范围

当前扩展匹配以下页面：

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

## 项目结构

- `manifest.json`：Chrome 扩展配置。
- `content.js`：页面增强、宽度控制、公式复制逻辑。
- `content.css`：ChatGPT 页面注入样式。
- `popup.html` / `popup.css` / `popup.js`：浏览器工具栏弹窗。

## 已知限制

ChatGPT 页面结构可能会随官方更新变化。如果页面 DOM 或公式渲染方式发生较大调整，宽度覆盖或公式复制逻辑可能需要同步更新。

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) for details.
