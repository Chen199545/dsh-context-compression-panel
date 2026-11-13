# dsh-context-compression-panel
DSH (DeepSeek Harness) 上下文压缩快捷面板插件

## ✨ Features
- 在对话面板挂载快捷胶囊，无需进入设置页
- 输入框精确设置压缩触发阈值：10% ~ 95%
- 输入框精确设置历史保留比例
- 一键开关自动上下文压缩
- 写入官方 `compaction-basic`，复用 DSH 原生压缩引擎
- 无后台上传，不会窃取 API Key / 会话上下文

## 📦 Install
1. 将本项目克隆到本地
2. `pnpm install && pnpm build`
3. 在你的 DSH profile 的 `patches` 添加本项目内 `cordis.patch.yml` 的绝对路径
4. 重启 DSH

## 📝 Usage
对话输入框右侧会出现胶囊按钮，点击弹出面板修改参数；
也可以使用 `/visual-compact` 手动触发一次压缩。

## License
MIT
