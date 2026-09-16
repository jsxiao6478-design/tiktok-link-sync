# 云端部署指南（GitHub Actions）

把「抓取 TikTok + 写回飞书表格」这套流程放到 GitHub 云端跑，**你自己的电脑关机、断网、换电脑都不影响**。

---

## 一、先说清楚它能做到什么、做不到什么

| | 能不能 |
|---|---|
| 本机关机时照常同步 | ✅ 能（跑在 GitHub 服务器上） |
| 在任何电脑上编辑表格 | ✅ 能（飞书表格本来就是云端，随时编辑/点按钮） |
| 点「立即同步」后 60 秒内响应 | ⚠️ 做不到 60 秒 —— 云端最快 **每 30 分钟**一轮。想要 60 秒响应得保留本机守护进程（见第六节） |
| 完全不依赖任何一台你自己的机器 | ✅ 能，前提是 GitHub 能抓到 TikTok（见第四节验证） |
| 频率比 30 分钟更密 | ❌ 不建议，理由见第五节 |

**核心限制**：TikTok 数据必须有人去抓，飞书自己没这个能力。云端方案的本质是「把抓取这件事从你的电脑搬到 GitHub 的服务器」。

---

## 二、飞书开放平台：开通应用权限（必做，绕不过）

云端没有你在本机的 lark-cli 登录态，必须改用**应用身份（bot）**读写表格。好处是 token 两小时自动续期，**不存在 OAuth 那种约 7 天过期的问题**。

### 1. 拿到 App ID 和 App Secret

打开 <https://open.feishu.cn/app/cli_aaf039c9f5fadbe0/baseinfo>（这是 lark-cli 已经绑定的那个应用）

- **App ID**：形如 `cli_aaf039c9f5fadbe0`
- **App Secret**：点「查看」并复制

### 2. 开通多维表格权限

打开 <https://open.feishu.cn/app/cli_aaf039c9f5fadbe0/auth>，搜索并开通：

- ✅ `bitable:app`（查看、评论、编辑和管理多维表格）—— **必须**，读写都靠它

> 飞书若提示权限已升级为更细粒度的权限点，则开通这一组：
> `base:record:retrieve`（读记录）、`base:record:update`（改记录）、`base:table:read`（读表结构）

### 3. 发布版本（关键，不做权限不生效）

左侧「版本管理与发布」→「创建版本」→ 填版本号 → 申请发布。

- 如果你是管理员：在「管理后台 → 应用管理」里直接通过审核
- 如果不是：让企业管理员帮你通过

**权限变更必须发布版本后才生效**，这是最容易漏的一步。

### 4. 把应用加进这张表当协作者

打开多维表格 → 右上角「分享」→ 在协作者里搜索你的应用名 → 添加为 **「可编辑」**。

> 不做这步会报 `91403 Forbidden` 或 `code=1254303`，代码里已经把这两个错误翻译成人话了。

---

## 三、GitHub：建仓库 + 配 Secrets

### 1. 建一个 **Public** 仓库

> **为什么必须 public**：私有仓库的 Actions 免费额度是 2000 分钟/月，而本方案每 30 分钟跑一次、单次约 2 分钟 ≈ 2880 分钟/月，会超支。公开仓库的标准 runner **免费且不限时长**。
> 代码里不含任何密钥（`config.json` 已被 `.gitignore` 排除，云端用的是 `config.ci.json`，凭证全走 Secrets）。

在 GitHub 上新建仓库（例如 `tiktok-link-sync`），**不要**勾选 add README / .gitignore（本地已经有了）。

### 2. 推送代码

在本项目目录（`tiktok-link-sync`）执行：

```bash
git remote add origin https://github.com/<你的用户名>/tiktok-link-sync.git
git push -u origin main
```

> 首次推送需要认证。用 GitHub 的 Personal Access Token 当密码，或配置 SSH 密钥。

### 3. 配置 Secrets

仓库页面 → **Settings → Secrets and variables → Actions → New repository secret**，逐个添加：

| Secret 名称 | 值 | 必填 |
|---|---|---|
| `FEISHU_APP_ID` | 第二节拿到的 App ID | ✅ |
| `FEISHU_APP_SECRET` | 第二节拿到的 App Secret | ✅ |
| `FEISHU_BASE_TOKEN` | `YpZobYZ22aSL44s57RFcrmeWn4g` | ✅ |
| `FEISHU_TABLE_ID` | `tbl7UREfqxQ1VgwG` | ✅ |
| `TIKTOK_PROXY` | 公网代理地址，如 `http://user:pass@1.2.3.4:8080` | 可选，见第四节 |

> `TIKTOK_PROXY` 不填＝直连。你本机那个 `127.0.0.1:15236` **在云端用不了**（那是本机回环地址），要填必须是公网可达的代理。

---

## 四、第一次验证：先跑烟雾测试（go / no-go）

仓库页面 → **Actions** → 左侧选「TikTok 表格同步」→ **Run workflow** → 模式选 **`smoke-only`** → Run。

它会依次检查并打印：

```
[OK]   出口 IP: x.x.x.x [US] ...            ← GitHub 服务器从哪个国家出网
[OK]   TikTok 经代理可达 / TikTok 直连可达   ← 最关键的一行
[OK]   tenant_access_token 获取成功          ← 飞书应用凭证对不对
[OK]   读取表格成功：39 条记录                ← 应用有没有表格权限
[OK]   抓取 @xxx 成功：66 条视频              ← 真的能抓到数据
```

**判定标准**：

- 只要「抓取 @xxx 成功」是 `[OK]` → 这套方案可行，改成 `sync` 模式手动跑一次，之后它会自动每 30 分钟跑。
- 如果显示 `[FAIL] 抓取 ... 返回 0 条（被降级 / 风控）` → **GitHub 的机房 IP 被 TikTok 拦了**。两个选择：
  1. 配一个公网代理，填到 `TIKTOK_PROXY` Secret（你本机代理能否提供公网入口需要确认）；
  2. 放弃云端，改回本机常驻（让电脑保持开机不休眠）。

> 这一步不通过就别往下走了 —— 这是整个方案的唯一硬门槛。

---

## 五、运行频率与额度

| 项 | 数值 |
|---|---|
| 触发频率 | 每 30 分钟（`cron: '0,30 * * * *'`，GitHub 用 UTC，整半点对齐） |
| 单次耗时 | 约 2 分钟（首次装浏览器 3~4 分钟，之后有缓存） |
| 公开仓库 | 免费无时长限制 ✅ |
| 私有仓库 | 约 2880 分钟/月 > 2000 分钟免费额度 ❌ |

**两个必须知道的坑：**

1. **GitHub 会延迟**：定时任务在平台高峰期可能晚几分钟到十几分钟，甚至偶尔跳过。这是 GitHub 调度的固有行为，不是配置问题。
2. **60 天无活动会自动停用定时任务**：如果这个仓库 60 天没有任何提交，GitHub 会停掉它的 schedule。建议偶尔（比如每月）往仓库提交一次，或去 Actions 页面手动 Run 一次。

---

## 六、上云之后，本机那套怎么处理

两套同时跑**不会互相加锁**（文件锁只在同一台机器上生效），会各自抓一遍 TikTok，属于重复劳动，还容易触发风控。

**推荐做法**：云端验证通过后，停掉本机的守护进程：

```bash
npm run watch:stop     # 写 data/watch.disabled，看门狗不会再自动拉起
```

之后「立即同步」按钮的响应时间从 ≤60 秒变成 ≤30 分钟（等云端下一轮），但换来的是完全不受本机开关机影响。

**如果你想两者都要**（按钮 60 秒响应 + 关机也能跑）：保留本机守护进程，但让它**只补链接、不刷播放量/点赞数**，避免和云端重复抓取：

```bash
npm run watch:stop
npm run watch:start -- --stats-every 0     # 0 = 本机不刷 stats，交给云端
```

或者只是把本机的刷新间隔拉长（例如 120 轮 ≈ 2 小时）：

```bash
npm run watch:stop
npm run watch:start -- --stats-every 120
```

> 后台启动的守护进程会继承这条命令的环境变量，参数也支持 `--interval` 等。
> 想让它长期生效，也可以直接改 `src/watch-trigger.cjs` 里的默认值（`let statsEvery = 30`）。

---

## 七、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `code=99991672 app_scope_not_applied` | 应用没开 `bitable:app` 权限，或**开了但没发布版本** |
| `91403 Forbidden` / `code=1254303` | 应用没被加进这张多维表格的协作者 |
| `tenant_access_token 获取失败` | App ID / Secret 填错，或 Secret 里有多余空格 |
| 抓取返回 0 条 | TikTok 拦了 GitHub 的 IP，配 `TIKTOK_PROXY` |
| 定时任务不跑 | ① 检查仓库是否被 GitHub 停用 schedule（60 天无活动）② workflow 文件是否在默认分支上 |
| 状态写入报错（单选字段） | 说明该字段在表里被改成了别的类型，找我看 `coerceForApi` 的类型映射 |
| 想看历史运行结果 | 每次运行会上传 `data/feishu-run-*.csv` 审计快照，在 Actions 运行页面的 Artifacts 里下载，保留 7 天 |

---

## 八、本地跑一遍同样的流程（不用等云端）

装了 Node 的任意电脑上：

```bash
git clone <你的仓库地址>
cd tiktok-link-sync
npm ci
npm install   # 若缺 config.json，按需新建（见下）
npx playwright install chromium

# 配好环境变量后，用云端同一套配置试跑
FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx \
FEISHU_BASE_TOKEN=YpZobYZ22aSL44s57RFcrmeWn4g \
FEISHU_TABLE_ID=tbl7UREfqxQ1VgwG \
node bin/smoke-test.cjs --config config.ci.json
```

> `config.json`（含本机代理 `127.0.0.1:15236`）不在仓库里，所以换机器跑时要么重新建一份，要么全程用 `--config config.ci.json` + 环境变量。
