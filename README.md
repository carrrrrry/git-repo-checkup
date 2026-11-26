# 🩺 Git 仓库接入体检 (Git Repo Checkup)

> 48 小时实战题交付：输入一个公开 GitHub 仓库链接，30 秒生成「接入就绪度报告」——评估新人/新团队能否顺利把这个仓库跑起来。

**纯前端实现，零后端、零安装**：所有扫描在浏览器端完成，仓库内容只与 GitHub 直连，不经过任何中间服务器。

## ✨ 功能

| 维度 | 检查内容 |
|---|---|
| 📖 README 完整度 | 是否存在、篇幅、安装/启动/配置章节覆盖、可复制代码块 |
| 📦 依赖清单 | package.json / requirements.txt / pom.xml / go.mod / Cargo.toml 等 10 种生态；lockfile 版本锁定；package.json 可解析性 |
| 🚀 启动脚本 | npm scripts.start/dev、Dockerfile/compose、Makefile run 目标、启动脚本、Python 入口；库项目按 main/exports/约定 index.js 识别（不误扣分） |
| 🪟 Windows 专用脚本 | 列出全部 `.bat` / `.cmd` / `.ps1` / `.vbs`，评估跨平台兼容性 |
| 📁 硬编码路径 | `C:\`、`C:/`、`/Users/`、`/home/` 等绝对路径，定位到文件+行号 |
| 🔐 密钥与敏感信息 | `sk-`、`AKIA`/`AKID`/`LTAI`、`ghp_`/`github_pat_`、`xoxb`、Bearer Token、私钥文件与内容、Google API Key、`.env` 入库、密钥/证书文件入库、疑似凭证赋值（低置信度标注"需人工确认"） |

产出：

- **接入就绪度评分**（0-100，等级 A/B/C/D + 扣分明细）
- **主要风险清单**（严重级别、文件+行号证据，密钥类证据自动脱敏）
- **接入建议**（规则生成，始终可用）
- **AI 接入建议**（可选：填入任意 OpenAI 兼容接口，由模型给出优先级整改方案）

## 🚀 使用

方式一（推荐）：直接用任意静态服务器托管本目录：

```bash
npx serve .        # 或 python -m http.server 8080
```

打开页面 → 粘贴 `https://github.com/owner/repo` → 点「开始体检」。

方式二：直接双击 `index.html` 也能用（浏览器 CORS 允许直连 GitHub API）。

大仓库或连续扫描建议在「高级选项」填入 GitHub Token（额度 60 → 5000 次/小时），Token 只保存在浏览器内存中。

## 🧮 评分规则

满分 100，按下表扣分（各类别封顶）：

| 扣分项 | 分值 |
|---|---|
| 缺少 README | -25 |
| README 完整度 < 60 | -10 |
| 缺少依赖清单 | -20 |
| package.json 无法解析 | -8 |
| 缺少明确启动方式 | -15 |
| 高危密钥发现 | 每项 -10，封顶 -30 |
| `.env` 入库 | -10 |
| 硬编码路径 | 每 3 处 -5，封顶 -15 |

等级：A ≥ 85（开箱即用）｜B ≥ 70｜C ≥ 50｜D < 50（暂不建议直接接入）。

## 🔄 更新跟踪设计（要求 #5）

> 如果原仓库后续有代码更新，工具如何发现并更新报告？以下是完整设计（本期实现到「报告标注 commit」一步，增量机制为设计说明）。

### 1. 怎么发现更新？

- 每次生成报告时记录三元组：`(owner/repo, branch, commitSha)`，其中 `commitSha` 来自 `GET /repos/{o}/{r}/commits/{branch}?per_page=1`（成本 1 次 API 调用），报告中已可见（页面顶部与摘要中均展示短 SHA）。
- 复检时先取远端最新 HEAD SHA，与本地缓存对比：
  - SHA 相同 → 直接返回缓存报告，标注「未变化」；
  - SHA 不同 → 触发增量重扫。
- 更进一步可监听 Webhook（GitHub `push` 事件）主动推送，适合服务端部署形态；纯前端形态用"打开页面时轮询 HEAD"即可。

### 2. 怎么避免全量重算？

关键观察：GitHub Trees API 对每个文件返回 **blob SHA**（即 `git hash-object` 的结果），文件内容不变则 blob SHA 不变。因此：

- 首扫时把「文件路径 → blob SHA → 该文件的扫描结果」存入 `localStorage`（或 IndexedDB，按仓库+分支分桶）；
- 复扫时用新 tree 与缓存 diff，**只对 blob SHA 变化、新增、删除的文件重扫**，未变化文件直接复用缓存的部分结论；
- 依赖树/API 请求量级：一次 `GET /git/trees/{branch}?recursive=1` 即可完成全部 diff，不下载任何未变化文件的内容——重扫成本 ≈ 变更文件数 × 1 次 raw 下载，而非全仓库。
- 注意 git 历史重写（rebase/amend）会改变全部 blob SHA，此时自动退化为全量重扫，属于可接受的兜底。

### 3. 报告如何标注所基于的 commit？

- 报告 meta 固定写入 `commitSha`（完整 SHA）与 `scannedAt` 时间戳，页面顶部显示短 SHA（hover 看完整值），并链接到 `https://github.com/{o}/{r}/commit/{sha}`；
- 导出/分享报告时 SHA 随 JSON 一起带走，保证「报告 ↔ 代码版本」可追溯；
- 若报告 SHA 落后于 HEAD，页面显示「⚠️ 此报告基于旧版本 commit abc1234，仓库已有更新，点击重扫」。

### 4. 失败或限流时怎么兜底？

- **限流（403/429）**：识别 `x-ratelimit-remaining` 头，提示用户填入 GitHub Token；已有 Token 时按 `Retry-After` 退避重试一次；仍失败则降级为「文件名级扫描」（不下载内容，仅做 README/依赖清单/Windows 脚本/密钥文件名检查），报告明确标注「受限模式」。
- **API 失败**：tree 请求失败时回退到 `GET /repos/{o}/{r}/contents/` 逐目录遍历（慢但可用）；
- **树被截断**（>100k 条目，API `truncated: true`）：截断告警写入报告 meta（当前页面已显示黄色警告框）；
- **raw 下载失败**：单文件失败不阻塞整体，标记 content=null 只参与文件名级检查；
- **本地缓存损坏**：读取缓存时 try/catch + 版本号字段，损坏即丢弃缓存走全量。

## 🧪 测试

```bash
node test/run-test.mjs
```

覆盖三类：构造的"问题仓库" fixture（18 项断言）、构造的"干净仓库" fixture（7 项断言）、真实仓库端到端（expressjs/express 全量 API 抓取 + 扫描）。当前 **32/32 通过**。另用真实含密钥仓库 `trufflesecurity/test_keys` 验证了密钥检出能力。

## 📁 结构

```
git-repo-checkup/
├── index.html          # 页面入口
├── css/style.css       # 样式
├── js/scanner.js       # 扫描引擎（纯逻辑，浏览器/Node 双端，UMD 导出）
├── js/app.js           # GitHub API 抓取 + 报告渲染 + 可选 AI 面板
├── test/run-test.mjs   # 测试（fixture + 真实仓库端到端）
├── AI_USAGE.md         # AI 协作过程记录（含 AI 答错被发现的记录）
└── README.md
```

## ⚠️ 已知限制

- 仅支持 GitHub（`api.github.com`）；扩展 GitLab 等只需替换 fetchRepository 层。
- 正则扫描存在固有误报/漏报：高危凭证格式直接报、低置信度赋值标"需人工确认"；二进制文件（>200KB 或非文本扩展名）不做内容扫描。
- 单仓库文本文件扫描上限 1500 个（超限有明确提示），避免浏览器卡顿。
- 评分是启发式的：库项目没有启动脚本属正常（已按 main/exports/index.js 约定识别），文档型仓库缺依赖清单也属正常场景，后续可按仓库类型自适应。

## License

MIT
