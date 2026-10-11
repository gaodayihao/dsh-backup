<div align="center">

# 💾 dsh-backup

**DeepSeek Harness 备份与恢复插件** — 工作区、完整对话、附件、设置、mnemon 记忆，一个 ZIP 全带走，换机 / 重装 / 升级后原样恢复。

![Version](https://img.shields.io/badge/version-0.3.0-4c7ef3?style=flat-square)
![Format](https://img.shields.io/badge/format-DshBackup%20v1-2b6cb0?style=flat-square)
![CI](https://github.com/having5548/dsh-backup/actions/workflows/ci.yml/badge.svg?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d6?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Dependencies](https://img.shields.io/badge/dependencies-1%20(schemastery)-9cf?style=flat-square)

</div>

---

## ✨ 特性

| | | |
|---|---|---|
| 🗂 **工作区级备份**<br>类似 VS Code 的 Profile 导出：一个 ZIP 携带工作区注册表 + 全部会话 + 附件 + 设置 + 插件清单 | 🔒 **对话字节级保真**<br>会话文件全程不解包、不改写，恢复后 AI 可完整识别全部历史 | 🔁 **版本双向兼容**<br>旧代际会话由 harness 自带迁移链自动升级；未来新版 harness 的会话也能装进当前备份 |
| 🧠 **mnemon 注入一致**<br>`~/.mnemon` 三目录按字节备份，覆盖导入 = 全量还原，上下文注入与备份时完全一致 | 🔍 **先预检再动手**<br>导入前看清楚将新增 / 覆盖 / 保留多少数据、缺哪些插件；导入后给出逐组件报告 | 🛟 **救援通道**<br>每份磁盘备份都带零依赖的 `rescue.mjs` 与「点我恢复」双击启动器——DSH 起不来也能还原 |
| 🔀 **合并 / 覆盖双模式**<br>合并只补缺不覆盖（日常）；覆盖整批替换（灾难恢复），语义透明、行为可预期 | ⏰ **自动备份 + 轮换**<br>定时写盘到本机备份目录，每份带 `.sha256` 校验文件，按保留份数自动轮换，重启不中断 | 🩺 **会话体检**<br>一键扫描全部会话文件（zstd 魔数 / 文件头 / 空文件），异常早发现 |
| 🤖 **/backup 斜杠命令**<br>在对话里直接 `/backup`、`/backup restore latest --dry-run`、`/backup auto 12` | 🔐 **凭据脱敏 + 凭据库加密**<br>settings.yaml 的密钥值导出时替换为占位符；`.credentials.yaml`（整文件皆为密钥）则用 AES-256-GCM 加密后才入包，未设密码就整条不导出 | 🩺 **AI 恢复助理（可选）**<br>跨版本导入后一键/自动开新会话让 DeepSeek 核查恢复结果并做最小修复；**默认关闭**，自主控制 token 消耗 |

## 📦 安装

> 本仓库是 [having5548/dsh-backup](https://github.com/having5548/dsh-backup) 的 fork。
> **本 fork 不发布到 npm**（上游包名 `@having5548/dsh-backup` 属于原作者的 npm scope，
> 本仓库无权 publish），分发渠道是 GitHub 仓库本身。包名沿用 `@having5548/dsh-backup`，
> 因此安装本 fork 会以同名依赖**覆盖** profile 里原有的那个插件。

**推荐：从 GitHub 仓库直装**（跟随 `main`，锁文件会把当时的 commit 钉住）

```bash
dsh plugin --profile desktop add github:gaodayihao/dsh-backup
```

- 只要求本机装了 `git`（pnpm 要用 `git ls-remote` 解析 ref）。
- 想钉死某一版：`github:gaodayihao/dsh-backup#v0.6.0`。
- 与下面 Release tgz 装出来的文件**逐字节相同**（pnpm 会按 `package.json` 的 `files` 白名单重新打包，不会把 `.github/`、`test/` 带进 `node_modules`）。

**备选：从 GitHub Release 装 tgz**（本机没有 `git` 时用；但要留意下面那条 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`）

```bash
dsh plugin --profile web add https://github.com/gaodayihao/dsh-backup/releases/latest/download/having5548-dsh-backup.tgz
```

本地开发 / 打包：

```bash
npm pack          # 得到 having5548-dsh-backup-<版本>.tgz
dsh plugin --profile web add having5548-dsh-backup-<版本>.tgz
```

> profile 名按前端来：**桌面端是 `desktop`**，旧版 CLI 是 `web`。

安装后**重启服务**（桌面端工具栏「重新连接服务」），打开 **设置 → 备份与恢复**。

### 装不上？报 `ERR_PNPM_MISSING_TARBALL_INTEGRITY`

> 这条**只跟上面「从 Release 装 tgz」那种装法有关**。想直接绕开，改用
> `dsh plugin --profile desktop add github:gaodayihao/dsh-backup` 即可（`github:` 形式不受影响）。

现象（tgz 装法）：**同一台机器上第一次装能成功，之后每次装**（重装 / 换版本 / 装进另一个 profile）都失败：

```
[ERR_PNPM_MISSING_TARBALL_INTEGRITY] Cannot install package "@having5548/dsh-backup@https://github.com/…/having5548-dsh-backup.tgz":
its lockfile entry has no "integrity" field, so pnpm cannot verify the downloaded tarball.
```

根因是 **pnpm 自己的 bug，与本插件无关**（上游 [pnpm#12185](https://github.com/pnpm/pnpm/issues/12185)，已在 **pnpm ≥ 11.9.0** 修复；DSH 桌面端目前内置的是 pnpm 11.7.0，会踩到）：

- pnpm ≤ 11.8 解析「**直接用 URL 指定的 tgz 依赖**」时只产出 `{tarball: <url>}`，**不带 integrity**——integrity 本来要靠「把它下载进本地 store」这一步补上；
- 如果这个 tarball 已经在本地 store 里（`%LOCALAPPDATA%\pnpm\store\v11\index.db` 中有 `key` 形如 `<url>` + `\tbuilt` 的一行），解析阶段就直接 `reused`、不再下载，于是写进 `pnpm-lock.yaml` 的条目**没有 integrity**；
- pnpm 紧接着又用「非 git 托管、非 `file:` 的 tarball 依赖必须有 integrity」这条硬规则读回同一个条目，于是自己刚写下的条目把自己判死。

**修法一（推荐，保留 URL 依赖声明）**：清掉 store 里那行索引，再重跑安装命令。

```powershell
# 需要 Node 22+ 的 node:sqlite（DSH 自带 24.x）；先备份 index.db 更稳妥
@'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.LOCALAPPDATA + "/pnpm/store/v11/index.db");
const del = db.prepare("DELETE FROM package_index WHERE key LIKE '%having5548-dsh-backup.tgz%'").run();
console.log("deleted rows:", del.changes);
db.close();
'@ | Set-Content -Encoding utf8 clean-store.cjs
node clean-store.cjs      # 打印 deleted rows: 1 即可
```

```bash
dsh plugin --profile desktop add https://github.com/gaodayihao/dsh-backup/releases/latest/download/having5548-dsh-backup.tgz
```

> `pnpm store prune` **无效**：它清理的是包，不是这行索引。
> 实在嫌麻烦，直接 `Remove-Item -Recurse -Force "$env:LOCALAPPDATA\pnpm\store"` 删掉整个 store 也行——
> 效果一样（下次安装会重新下载所有依赖，只是慢一点）。

**修法二（最省事，`file:` 形式不受这条硬校验约束）**：

```bash
curl -L -o having5548-dsh-backup.tgz https://github.com/gaodayihao/dsh-backup/releases/latest/download/having5548-dsh-backup.tgz
dsh plugin --profile desktop add ./having5548-dsh-backup.tgz
```

> 代价：profile 的 `pnpm-lock.yaml` 会记住这个 tgz 的**绝对路径**，别把它删掉。

> ⚠️ 安装失败会在 profile 的 `pnpm-lock.yaml` 里**残留一条没有 `integrity` 的条目**，它会让之后每次安装立刻失败。修之前先确认这条（`'@having5548/dsh-backup@https://…'`）已被删除，或者按 [上游给的写法](https://github.com/pnpm/pnpm/issues/12185#issuecomment-4670405277) 给它补上 `integrity`（`sha512-` + tarball 的 SHA-512 base64）。

**根治**：把 DSH 桌面端升到内置 pnpm ≥ 11.9.0 的版本。

## 🚀 快速开始

### 方式一：设置面板（推荐）

1. 打开 **设置 → 备份与恢复**，状态卡会显示数据目录、会话数、工作区数与 mnemon 概况
2. 勾选要包含的组件（每项实时显示文件数与体积）→「导出备份包」
3. 恢复：选择备份包 →「预检」→ 合并 / 覆盖 →「执行导入」

### 方式二：对话里敲 `/backup`

```
/backup                    # 立即备份（默认写到 ~/Documents/dsh-backups/，输出 sha256 与位置）
/backup auto 12            # 每 12 小时自动备份，重启不中断
/backup restore latest --dry-run   # 先预览恢复会做什么
/backup restore latest     # 正式恢复（默认合并模式）
/backup list | verify all | doctor | help
```

每份磁盘备份都附带 `rescue.mjs` 和「点我恢复」双击启动器（Windows `.bat` / macOS `.command` / Linux `.sh`）——DSH 起不来时，装个 Node 就能恢复。

### 导入恢复（面板流程）

1. 选择备份包 → 点「**预检**」：看清楚备份来自哪里、将发生什么、缺哪些插件
2. 选择模式：**合并导入**（推荐）或 **覆盖导入**
3. 勾选要恢复的组件 → 「执行导入」→ 查看报告
4. 报告提示后**重启服务**并刷新页面，会话列表完全刷新

> 换机 / 重装 → 用「覆盖导入」一步回到备份时点；日常把旧机器的数据并进新机器 → 用「合并导入」。

## 🗜 备份包含什么

| 组件 | 内容 | 默认 |
|---|---|:---:|
| 会话记录 | `~/.dsh/sessions/` + `dsh-session-archive/`，全部对话（含归档会话） | ✅ |
| 工作区注册表 | `~/.dsh/storages/workspace.json`（工作区列表、排序、会话归属） | ✅ |
| 会话投影缓存 | `storages/session_projcache/`，可再生，加速恢复后首次打开 | ✅ |
| 附件 | 对话中引用的图片 / 文件（`~/.dsh/attachments/`） | ✅ |
| 设置 | `settings.yaml`，各插件设置（**可能含 API 密钥，请妥善保管备份**） | ✅ |
| **凭据库** | `~/.dsh/.credentials.yaml`（API 密钥 + 登录签名密钥），整文件皆为密钥，**AES-256-GCM 加密后才入包**；未设密码则整条跳过并写明原因 | ✅ |
| Profile 插件清单 | `profiles/<profile>/` 的 package.json 与 patch 文件；导入时仅补缺并生成缺失插件报告 | ✅ |
| dsh-mnemon 记忆数据 | `~/.mnemon/{runtime, documents, data[, state]}`，上下文注入的全部来源 | ✅ |
| 其他插件数据 | task-board / dsh-usage / skins 等第三方插件的数据目录（动态发现） | ⬜ |

## 🔀 两种导入模式

| | 合并导入（推荐） | 覆盖导入 |
|---|---|---|
| 会话 / 附件 / 缓存 | 同名文件保留本机，只补充备份多出的 | 备份内容替换本机同名文件；本机多出的数据**不会**被删除 |
| 工作区注册表 | 按 UUID 合并，`updatedAt` 新者胜，排序保序 | 整体替换为备份版本 |
| mnemon 热记忆 | 按 `target+content` 去重并入；MEMORY.md / USER.md 保留本机投影，下次写入自动重投影 | 按备份原样还原 |
| mnemon 文档 | 同 id 同 contentHash 跳过；同 id 异内容换新 id 导入 | 按备份原样还原 |
| mnemon 记忆体（SQLite） | 仅新增 body，已有 body 一律保留本机 | 全量替换（先清 `-wal`/`-shm`，防旧 WAL 配新库） |
| settings.yaml | 跳过（想覆盖请用覆盖模式） | 整体替换 |
| 凭据库 `.credentials.yaml` | 跳过（整文件替换语义，合并两份凭据只会互相覆盖） | 解密后整体替换（原文件留 `.bak`，权限收紧到 `0600`） |
| 被替换的原文件 | — | 保留为 `*.bak-dshbackup-<时间戳>`，可随时手动还原 |

## 🛟 救援通道（DSH 起不来时）

磁盘备份目录里的 `rescue.mjs` 是**零依赖**单文件（只用 Node 内置模块），不依赖 DSH：

```bash
node rescue.mjs list                              # 列出备份
node rescue.mjs verify dsh-backup-xxx.zip         # 逐条目 CRC 校验
node rescue.mjs restore latest --dry-run          # 预览（默认只补缺失文件，绝不覆盖）
node rescue.mjs restore latest --force            # 覆盖恢复（原文件留 *.bak-rescue-*）
node rescue.mjs credentials latest                # 只校验加密凭据库能否解开，不写盘
node rescue.mjs restore latest --force --passphrase '你的密码'   # 连凭据库一起恢复
```

Windows 双击「点我恢复.bat」、macOS 双击「点我恢复.command」进入交互式菜单。
也可以在设置面板点「下载救援工具包」把它和备份放在一起。

> `rescue.mjs` 默认按「文档 → 桌面 → 主目录」顺序找备份目录，优先选真正有备份的那个；
> 密码也可用环境变量 `DSH_BACKUP_CREDENTIALS_PASSPHRASE` 提供。
> 没有密码或密码不对时，凭据库会被**跳过**（密文原样留在包里），本机凭据不受影响——
> 它绝不会把一个 dsh 读不了的密文写成 `.credentials.yaml`。

## 🔐 凭据脱敏

- 导出（含自动备份）默认把 `settings.yaml` 中疑似密钥的值（`apiKey` / `token` / `password` / `secret`…，自动识别 camelCase）替换为占位符，**明文不出备份包**；占位符清单写在包内 `redaction.json`
- 覆盖导入时，占位符处自动回填**本机现值**（本机没有的保留占位符并在报告中提示重填）——换机恢复后无需担心密钥互相覆盖
- 需要明文备份（如本机冷存档）可在导出时取消勾选

## 🔑 凭据库加密（`.credentials.yaml`）

`~/.dsh/.credentials.yaml` 是 dsh 自己的凭据库（5 个 API 密钥 + `client-connection` 的 cookie 签名密钥），**整个文件每一行都是密钥**——逐行脱敏对它没有意义。所以它不走脱敏，走对称加密：

- 在 **设置 → 备份与恢复 →「凭据加密密码」** 设置密码后，凭据库以 **AES-256-GCM + scrypt**（N=2^15, r=8, p=1，每次随机 salt/iv）加密写入 `payload/credentials/.credentials.yaml.enc`
- 容器里记录了明文 sha256，因此**解密结果可被证明**：密码不对、密文被改一个字节都会在**覆盖本机文件之前**失败，不会出现「覆盖完才发现打不开」
- **未设置密码时该组件整条跳过**，并在 manifest 里写明原因。明文凭据在任何情况下都不会进入备份包
- 覆盖导入时解密恢复，原文件保留 `.bak-dshbackup-<时间戳>`，恢复后权限收紧到 `0600`；合并导入跳过（凭据是整文件替换语义）
- **换机恢复**：本机没有那份备份的密码时，在导入卡片的「凭据库解密密码」里临时填写即可。密码走请求头（UTF-8 + base64），**不进 URL**（避开浏览器历史、Referer、服务端访问日志），也不写入本机设置
- 密码保存在本机 `~/.dsh/dsh-backup-settings.json`，而**该文件已被排除在备份之外**（否则密码与密文同包，加密形同虚设）。请务必把密码另存到密码管理器——机器全损时它是打开备份里凭据的唯一钥匙

## ⏰ 自动备份

- `/backup auto 12`：每 12 小时一次（1–720），重启 dsh 后自动续跑，不中断
- **备份目录与保留份数都能在面板里直接编辑**：「设置 → 备份与恢复 → 备份目录 / 保留 N 份 → 保存」。保存时会先真写一次探针文件，盘符打错或目录不可写会当场报错，而不是等到备份时才发现
- 改备份目录时，自动备份状态会自动迁移到新目录并重新排程（否则新目录里没有 `.dsh-backup-auto.json`，重启后自动备份会静默停摆）
- 每份备份：`dsh-backup-<时间戳>.zip` + 同名 `.sha256`（sha256sum 格式）+ 救援工具
- 保留策略：默认保留最近 7 份（面板或 `/backup --keep N`），超出自动轮换删除

## 🧠 为什么 dsh-mnemon 上下文注入能「跟原本一样」

mnemon 的注入内容全部来自 `~/.mnemon` 三个目录：

- `runtime/memories.json` — 热记忆单一事实源（+ MEMORY.md / USER.md 投影）
- `documents/` — 项目文档与 `index.json` 登记表
- `data/<bodyId>/mnemon.db` — 记忆体证据图（SQLite）

dsh-backup 在导入前校验两组对应关系（index ↔ 文件、bodies ↔ db 目录），
**覆盖导入按字节还原这三处**，因此恢复后 mnemon 的 `system-prompt/assemble` 注入段与
`agent/pre-step` 记忆快照和备份时完全一致，AI 拿到的上下文不变。

> ⚠️ 若 mnemon 使用 `workspaces` 存储范围（按工作区路径哈希分桶），恢复后请保持
> 工作区**目录路径不变**，否则 mnemon 会以新路径建新桶。默认 `global` 范围无此顾虑。

## 🛡 数据安全设计

```
上传备份包 → 暂存区落盘 → 逐文件 CRC32 / sha256 校验 → 原子提交（tmp → rename）
                                    ↓ 校验失败
                              拒绝导入，本机数据零改动
```

- 暂存区放在目标所在磁盘内，rename 同卷原子；不占大块内存，GB 级备份也稳
- manifest.json 有独立 sha256，防清单被篡改；`formatVersion` 更新的备份**明确拒绝**并提示升级插件
- 导入过程被中断：暂存区自动清理，已提交文件前均有 `.bak`，可手动恢复
- 同源防护：浏览器跨站请求被拒绝，其它网页无法触发你的导出 / 导入

## 🧩 备份格式 DshBackup v1

```
manifest.json      { format: "dsh-backup", formatVersion: 1, counts, components, bundles, … }
checksums.json     { manifest: sha256, files: { <路径>: { size } } }
redaction.json     { file, paths }        ← 仅在启用脱敏且命中密钥时出现
payload/
  sessions/<projectKey>/<sessionId>/…      ← ~/.dsh/sessions
  sessions-archive/…                       ← ~/.dsh/dsh-session-archive
  storages/workspace.json                  ← 工作区注册表（unit v2）
  storages/session_projcache/…             ← 投影缓存
  attachments/…                            ← 附件
  settings/settings.yaml                   ← 设置（默认已脱敏）
  credentials/.credentials.yaml.enc        ← 凭据库（AES-256-GCM + scrypt；密码缺失时整条不出现）
  profile/…                                ← 插件清单（package.json / cordis.patch.yml / …）
  mnemon/{runtime,documents,data}/…        ← dsh-mnemon 数据
  extensions/<插件数据>/…                   ← 其它插件数据
```

条目完整性由 ZIP CRC32 逐文件保证；导入时未知子目录（来自更新版本插件）忽略并告警，
永远不静默丢弃。

## ❓ FAQ

**Q: 备份文件里有没有敏感信息？**
默认没有。导出与自动备份默认**脱敏** `settings.yaml` 中的密钥值（明文不出包），`.credentials.yaml` 则在设置密码后以 AES-256-GCM 加密入包（未设密码时干脆不导出）。会话内容当然在备份里。若手动取消脱敏选项，`settings.yaml` 即明文，请像保管密钥一样保管备份文件——**但凭据库即使取消脱敏也仍然是密文**，它只有「加密」和「不导出」两种状态。

**Q: 我忘了凭据加密密码怎么办？**
备份里的 `.credentials.yaml` 就解不开了（scrypt + AES-256-GCM 没有后门）。但这不等于丢失：本机的 `.credentials.yaml` 还在，dsh 照常能用；只是这份备份无法用于「换机恢复凭据」。删掉重设密码重新备份即可。**所以请把密码记进密码管理器**。

**Q: 老版本 dsh 产生的会话，新版 harness 里能用吗？**
能。会话文件按字节复制，打开时由 harness 自带的 v0→v1→v2→v3 迁移链自动升级——这正是 dsh-backup 不解包会话的原因：无论会话格式怎么演进，备份侧永远兼容。

**Q: 和 dsh-mnemon 自带的「备份与迁移」什么关系？**
互补。mnemon 自带的 Mnemon Pack 只覆盖记忆数据；dsh-backup 连同会话、工作区、附件、设置一起打包，并保证二者恢复后行为一致。若你只关心记忆，用 mnemon 的 Pack 也完全可以。

**Q: 跨机器恢复要注意什么？**
工作区记录里保存的是绝对路径（如 `H:\mycode`）。若新机器路径不同，会话记录仍然完整可读，只是工作区面板里显示的是备份时的路径；按需手动调整即可。mnemon 默认 `global` 范围与路径无关。

**Q: 导入后插件没装全怎么办？**
预检报告会列出备份里有、本机没有的插件名称与版本，在「插件管理」里装回即可；数据导入不受影响。

## 🧪 开发与测试

> **AI / 接手维护者请先读 [AGENTS.md](AGENTS.md)**——含架构地图、历史踩坑的硬性禁忌、发布清单与「变更记录规则」(任何改动必须记入 [CHANGELOG.md](CHANGELOG.md))。

```bash
npm install            # 安装 schemastery
node --test test/local-test.mjs   # 核心套件
node --test test/v02-test.mjs     # v0.2 特性套件
node --test test/route-harness.mjs  # HTTP 路由台架
```

测试覆盖：ZIP 读写回环（文本 / 二进制 / 空文件 / 嵌套 / 大文件 / 第三方 zip）、zip 路径安全（穿越 / 绝对路径 / 驱动器号）、组件分类与落点、workspace / memories / documents 三类合并语义、两套假 dsh home 之间的端到端导出导入（合并 / 覆盖 / 校验失败拒绝 / 惰性暂存）。

```
lib/
├── index.js    服务端：/dsh-backup/* 路由（status / estimate / export / import）
├── store.js    数据布局、组件模型、合并语义、暂存与原子恢复
├── zip.js      纯 JS 流式 ZIP 读写（deflate / store / zip64 / CRC32）
└── client.js   客户端：设置 → 备份与恢复（settings.section 槽位）
```

## 📄 License

[MIT](LICENSE)
