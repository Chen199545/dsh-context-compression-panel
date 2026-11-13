# dsh-context-compression-panel

给 DeepSeek Harness 的输入框加一个**上下文压缩控制面板**：两个精确百分比输入框 + 自动压缩开关，改的是引擎真正读取的那份运行时配置。点输入框右侧的「压缩 80%」胶囊就能展开，不用先去设置页、再找插件设置。

版本 3.0.0。历史两版都死在写入通道上，3.0.0 换了通道并删掉了滑轨：

| 版本 | 做法 | 结果 |
| --- | --- | --- |
| 1.0.0 | 四档 Off/Low/High/Max → 写设置系统的表单 | ✗ 设置系统不给 `compaction-basic` 命名空间 |
| 2.0.0 | 两条百分比滑轨 + 输入框 → `configEditor.edit()` | ✗ `entries()` 只认根 include 层的条目，引擎条目不在里面，写入被拒 → 松手就回默认 |
| 3.0.0 | 两个输入框 + 开关 → Loader `entry.update({config})` | 见下文；滑轨按你的要求删掉 |

---

## 1. 面板长什么样、怎么用

打开方式：输入框右侧一枚胶囊（深色主题下是深灰底），显示当前触发阈值，例如 `压缩 80%`。点它弹出卡片：

```
                      80%                 ⟳
              压缩时机 · 逐字保留 16%
  触发阈值 [ 80 ]%   保留比例 [ 16 ]%
  ────────────────────────────────
  自动压缩                       [ ●]
  上下文用掉 80% 时压缩，压缩后逐字保留最近 16%
```

- **两个输入框就是控制本身**：左边「触发阈值」（上下文用掉多少时压缩），右边「保留比例」（压缩后逐字保留多少原文）。输入数字后**停手约 0.7 秒自动写入**，也支持回车、点别处立即写入；写入结果由 Host 回传，卡片上的数字永远是引擎里实际生效的值。
- **自动压缩开关**：关掉后引擎不再自动压缩，只在你敲 `/compact` 时压一次。
- **右上 ↻**：重新从 Host 读一次实际生效的配置（被别处改过时用它对齐）。
- **胶囊上的百分比**随实际值变化，颜色按时机从蓝到紫到橙（越晚压缩越冷色）。

区间是助手定的，可以改 `lib/client.js` 与 `lib/index.js` 里的常量：

| 项 | 区间 | 说明 |
| --- | --- | --- |
| 压缩时机 `thresholdRatio` | 10%–95% | DSH 内置默认 80% |
| 压缩比例 `retainRatio` | 4%–50% | DSH 内置默认 16%，区间围绕它取 |
| 两者关系 | 比例必须 **小于** 时机至少 1 个点 | 引擎加载时校验，「保留比例不小于阈值比例」会被直接拒绝 |

另外 DSH 引擎还有一层硬上限：`min(W×阈值, W−输出预留−headroomTokens)`，`headroomTokens` 默认 65536。所以实际触发点可能比面板上写的百分比更早——这是引擎自己的保护，面板不去覆盖它。

---

## 2. 数据是怎么真的落下去的（3.0.0 的核心）

前两版各撞了一个结构性死路，这里写清楚，省得以后再踩：

1. **设置系统**：`settings` 表单只暴露用 `.volatile()` 声明过的 Config 字段，而 `@deepseek-ai/dsh-compaction-basic/lib/index.js` 里 `volatile` 出现 **0 次**。`configForms.get('compaction-basic')` 永远 `unavailable`。
2. **Config Editor**：`entries()` 只返回「父条目是根 include 且 id 唯一」的那些行（源码注释：嵌套 Include 有独立的配置所有权）。引擎的压缩条目来自 base bundle 层，不在这个集合里 —— 所以读出来是 `found:false`（面板显示默认 80/16，看着正常），写入抛「找不到 compaction-basic 条目」然后回滚。这就是你看到的「松手就回默认」。
3. **往 profile 里塞 `- id: compaction-basic`** 也不干：如果 bundle 行是平铺进根 include，这行是覆盖；如果是嵌套 include，这行会**再起一个压缩引擎**（双份压缩）。猜错的代价是隐性错误，所以本插件**一个字节都不改 DSH 自己的配置文件**。

3.0.0 的做法是直接驱动 Loader —— 也就是 DSH 自己改 patch 时走的那套生命周期：

```
浏览器                                Host
  │  POST api/context-compression-panel/policy
  │  {action:'apply', policy:{auto,timing,retain}}
  ├──────────────────────────────────────────►  findEntry(loader.entries())
  │                                              ├ 按 options.id / options.name 认条目（任何层）
  │                                              ├ entry.update({config})
  │                                              │   └ Loader 用插件自己的 schema 校验并重启它
  │                                              └ 把同样三个值写进 profile patch 的一段标记行
  │  ◄──── {ok:true, value:实际生效值}            失败则带回引擎原话，卡片底部显示
```

- **实时生效**：`entry.update({config})` 走 `_patchContext(['config'])` → `fiber.update(config, true)`，即对该插件就地重解析并重启，和 DSH 自己应用 patch 是同一套动作。
- **持久化用 DSH 自己的机制**：在 `profiles\desktop\cordis.patch.yml` 末尾维护一段带 `# dsh-context-compression-panel:begin` / `:end` 标记的行：

  ```yaml
  # dsh-context-compression-panel:begin
  - id: compaction-basic
    name: "@deepseek-ai/dsh-compaction-basic"
    config:
      auto: true
      thresholdRatio: 0.65
      retainRatio: 0.2
  # dsh-context-compression-panel:end
  ```

  顶层 patch 行按 id 覆盖 bundle 层的同一条目 —— 这个 profile 自己就靠这招把 `ui-settings` 关掉、把 `usage-stats` 禁用，所以重启后引擎会自己读这行，不依赖谁“回灌”。值等于官方默认（80% / 16% / 开）时这段会被整段删掉，不留残留。
- **只动自己那一段**：写入前先 `stripBlock` 删掉旧块再追加，同盘 temp + `rename` 原子替换；文件里别人的行一个字节都不改。`tools/verify-patch.mjs` 会用 DSH 自带的 `js-yaml` 解析真实 patch 来验证这一点（见第 4 节）。
- **写入失败原样返回**：引擎拒绝（例如比例不小于阈值）、条目找不到，都会以 `ok:false` 回传并在卡片底部出说明，同时写一份诊断快照（见第 5 节）。不会出现「看着保存了其实没写」。
- **`retainTokens` 会被删掉**：它和 `retainRatio` 互斥，两个同时存在引擎会拒整份配置。面板只改 `auto / thresholdRatio / retainRatio`，`headroomTokens`、`modelPolicies` 等其它键原样保留。

为了让浏览器够得着 Host，插件注册了一条 HTTP 路由（`connection.fetch.register`，DSH 自己的面板用的同一个 API）。Host 半 `lib/index.js` 因此只 import `node:fs/promises` 与 `node:path`，不依赖任何外部包。

---

## 3. 安装 / 升级

已经装过旧版的，**代码已经就地更新，只要完全退出 DSH 再打开**（不是关窗口，是托盘里也退掉）即可，不用重跑安装脚本。

全新安装：

```powershell
cd "E:\工作\插件制作\dsh-context compression panel"
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` 做三件事，全部幂等：

1. 建两个 junction：`~\.dsh\plugins-src\dsh-context-compression-panel` → 本目录；`~\.dsh\profiles\desktop\node_modules\dsh-context-compression-panel` → 前者（用 junction 是为了改代码后不必重装）
2. 备份 profile 的 `package.json`，然后往里加 `dependencies` 与 `dsh.profile.bundles` 两个条目
3. 校验写进去了没有，并提示完全退出 DSH

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

它只删「确实指向本目录的 junction」、两处清单条目，以及面板在 `cordis.patch.yml` 里留下的那段标记行（先备份成 `.bak-时间戳`，只删标记块，别的行不动），再删掉诊断快照。它不动源码目录，也不动 profile 备份。

---

## 4. 自检

```powershell
cd "E:\工作\插件制作\dsh-context compression panel"
npm test        # = node test/host.mjs && node test/smoke.mjs
```

- `test/host.mjs`（72 项）：假 Cordis ctx + 假 `loader` + 临时 profile 目录跑 Host 半——路由注册在正确路径、`read` 从 loader 条目读出实际值（含按包名匹配、优先活动条目）、`apply` 写 `auto/thresholdRatio/retainRatio` 并删 `retainTokens`、百分比夹取与「比例低于阈值」、引擎拒绝时 `ok:false` 且 patch 文件一个字节都没变、条目缺失时 `ok:false`、标记行被替换而不是重复、回到默认值时标记行整段消失且别人的行仍在、诊断快照字段完整。
- `test/smoke.mjs`（43 项）：假模块加载器跑浏览器半——模块 id、`apply/inject` 形状、两个槽位注册、缺槽不抛、百分比归一化与夹取、文案与配色、路由调用的 URL/方法/信封、Host 拒绝原因能透出。

还有一项**用真 patch 验证**的检查（不写你的真文件，只操作副本）：

```powershell
node tools\verify-patch.mjs --patch "C:\Users\雨桐\.dsh\profiles\desktop\cordis.patch.yml" --yaml "<DSH 里的 js-yaml.mjs 路径>"
```

它拿真实 patch 的副本跑一次写入，再用 **DSH 自带的 js-yaml** 解析结果，确认：文件仍是合法序列、`compaction-basic` 行恰好一条、值写对了、其它行 JSON 级完全一致、回到默认值后整行消失且行数与原文相同。`--yaml` 从 `resources\app.asar` 里 `dsh\node_modules\js-yaml\dist\js-yaml.mjs` 解出来即可（不给也能跑，只跳过解析校验）。

界面里也可以手测接口：

```powershell
curl.exe -s -X POST http://127.0.0.1:<DSH端口>/api/context-compression-panel/policy -H "content-type: application/json" -d '{\"action\":\"read\"}'
```

浏览器控制台里 `window.__dshContextPanel` 暴露了纯函数与失败记录：

```js
__dshContextPanel.normalizePolicy({thresholdRatio: 0.65, retainRatio: 0.2})  // {auto:true, timing:65, retain:20}
__dshContextPanel.failures                                                  // 每次失败都留痕
await __dshContextPanel.callRoute({action: 'read'})                         // 直接打接口
```

---

## 5. 排错

失败时 Host 会往 `profiles\desktop\.context-compression-panel.diag.json` 写一份快照（启动时必写一次，之后每次失败覆盖），内容是：阶段、原因、当前策略，以及 loader 里前 400 个条目的 `id / name / parent / active / config`。**排查「写不进去」先看这个文件**，它能一次性说清引擎条目到底叫什么、挂在谁下面。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 输入框右侧没有胶囊 | `conversation.input.right` 槽位没注册（版本/主题相关） | 看 DSH 日志里 `composer-seat failed` 一行；设置页里同名行是备用入口 |
| 卡片副行「未接上 Host 接口」 | Host 半没加载或路由没注册 | 完全退出 DSH 再开；日志里搜 `dsh-context-compression-panel` |
| 卡片底部「…未生效：Loader 里找不到 compaction-basic 条目」 | 组合里没有这个条目，或名字变了 | 看诊断文件里的 `snapshot.compaction` |
| 卡片底部「…未生效：保留比例不小于阈值比例」 | 比例被外部改到阈值之上 | 把保留比例调小，或点 ↻ 重读 |
| 改完这一轮没反应 | 写入成功但引擎已在本轮读过配置 | 下一条消息生效 |
| 重启后回到旧值 | patch 里的标记行没写进去或被人删了 | 看 `cordis.patch.yml` 里有没有 `# dsh-context-compression-panel:begin` 段；没有就再点一次输入框 |

日志前缀统一是 `[dsh-context-compression-panel]`，失败都会 `console.error` 一行。

---

## 6. 边界与事实

- **写入会重载 `compaction-basic` 条目**：这是 Loader 的正常配置生命周期（普通配置按 Loader 生命周期生效），不是本插件额外折腾。
- **面板不读 API Key、不联网**。全部代码只有三种 I/O：本机同源的 HTTP 路由、profile 目录里的 `cordis.patch.yml`（只维护自己那一段标记行）、同目录的诊断快照。没有任何外部域名请求。
- **只碰自己那一段**：`cordis.patch.yml` 里其它行一律不动（`tools/verify-patch.mjs` 用真 patch 的副本验证过「别人的行 JSON 级完全一致」）；profile 的 `package.json` 只在安装 / 卸载时由脚本改，并各留一份备份。
- **设置页那一行**（`settings.general.item`）在本 profile 里 `ui-settings` 是 disabled，多半不注册；胶囊是主入口。
- **诚实声明**：3.0.0 的读取、写入、持久化、YAML 合法性都验证过（第 4 节，含用 DSH 自带 js-yaml 解析真实 patch 的副本），但**我还没有在真实 DSH 界面里点过胶囊**。第一次重启后如果哪里不对，卡片底部会直接写出原因，诊断快照里有完整现场，贴回来就能一次性定位。
- 滑轨相关代码（`Rail`、`.ccp-rail` 系列样式、拖动/滚轮/键盘处理）已全部删除，不留兼容层。

---

## 7. 目录

```
dsh-context compression panel/
├─ package.json          插件清单（dsh.bundle.patch 指向 cordis.patch.yml；dsh.client.platform=web）
├─ cordis.patch.yml      组合补丁：insert 一行 context-compression-panel
├─ lib/
│  ├─ index.js           Host 半：注册路由，读写走 loader 条目 + patch 里的标记行
│  └─ client.js          浏览器半：胶囊 + 卡片（两个输入框、自动压缩开关、刷新）
├─ test/
│  ├─ host.mjs           Host 半行为测试（假 ctx + 假 loader + 临时 profile 目录）
│  └─ smoke.mjs          浏览器半行为测试（假模块加载器 + 假 fetch）
├─ tools/
│  ├─ profile-edit.mjs   改 profile package.json 的小工具（install 调用）
│  └─ verify-patch.mjs   真 patch 副本 + DSH 自带 js-yaml 的写入合法性校验
├─ install.ps1 / uninstall.ps1
└─ README.md
```

`cordis.patch.yml` 里只 insert 一行：

```yaml
- insert:
    - id: context-compression-panel
      name: 'dsh-context-compression-panel'
```

这一行让组合加载本包的 `main`（Host 半）与 `./client`（浏览器半）；Host 半再自己注册路由。
