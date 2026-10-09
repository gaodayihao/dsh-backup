# 更新日志(CHANGELOG)

> 本文件是 **AI 接手维护的强制记录簿**:任何 AI(或人)对本仓库做出任何改动,
> 都必须按下方格式在「未发布」区补一条记录,发版时再升版本号。
> 规则细则见仓库根目录的 [AGENTS.md](AGENTS.md)「变更记录规则」。
>
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本遵循语义化版本(SemVer)。

## 条目格式(所有记录必须遵守)

```markdown
## [x.y.z] - YYYY-MM-DD

### 新增
- 功能名:做了什么、从哪里入口使用、默认开还是关

### 变更
- 改了什么、为什么、对既有用户的影响

### 修复
- 现象 → 根因(具体到代码/契约层面)→ 修法

### 兼容
- 宿主版本 / 备份格式 / 平台的适配与破坏性变化

### 移除
- 删了什么、替代方案
```

**硬性要求**
1. 修复类条目必须写清 **现象 → 根因 → 修法**,根因要具体到代码或契约层面,禁止"修复若干问题"这类空话
2. 禁止删除或改写历史条目;只能追加
3. 改动代码而没写条目 = 未完成的工作

---

## [未发布]

_(把下一次改动的条目写在这里,发版时把标题改成版本号与日期)_

## [0.6.0] - 2026-10-09

### 新增
- **凭据库加密备份(`credentials` 组件,默认开)**:`$DSH_HOME/.credentials.yaml` 是「整文件皆为密钥」的文件(API 密钥 + client-connection 的 cookie 签名密钥),逐行脱敏对它没有意义,因此单独成组件并以 **AES-256-GCM + scrypt**(N=2^15, r=8, p=1, 随机 salt/iv)加密后写入 `payload/credentials/.credentials.yaml.enc`。容器里记录明文 sha256,让「解密是否正确」在覆盖本机文件之前就能被证明。入口:设置 → 备份与恢复 →「凭据加密密码」。零新增依赖(只用 `node:crypto`),新文件 `lib/crypto.js`。
- **密码缺失时整条跳过,绝不明文落包**:未设置密码时不导出凭据,并把跳过原因写进 manifest(`notices` 与 `components.credentials.skipped`),面板在自动备份完成消息里提示。宁可少备份,不允许「密码没设 → 退化成明文」。
- **凭据解密恢复**:覆盖导入时解密并原子替换本机 `.credentials.yaml`,原文件保留 `.bak-dshbackup-<时间戳>`,恢复后权限收紧到 `0600`。合并导入跳过该组件(凭据是整文件替换语义,合并两份只会互相覆盖)。
- **预检试开**:导入预检用当前可用密码试解一次凭据容器,直接报告「密码匹配 / 密码不对 / 未提供密码」,而不是覆盖完才发现。
- **密码随请求头传递**:`X-Dsh-Backup-Credentials-Passphrase`(UTF-8 + base64)。换机恢复时可在导入卡片临时输入密码,不必写进本机设置;密码不进 URL,避免落进浏览器历史 / Referer / 服务端访问日志。
- **设置页可直接编辑备份目录**:原「备份目录」是只读展示,现改为输入框 + 「保存目录与保留份数」;保存时先真写一次探针文件,把「盘符打错 / 目录只读 / 没权限」挡在设置阶段。
- **保留份数可在设置页编辑**(此前只能用 `/backup --keep N`)。
- **救援控制台支持凭据**:`node rescue.mjs credentials <zip|latest> [--passphrase <密码>]` 只校验不写盘;`restore` 新增 `--passphrase`(或环境变量 `DSH_BACKUP_CREDENTIALS_PASSPHRASE`);交互式菜单在检测到加密凭据时询问密码。无密码或密码错时**跳过**,密文原样留在包里,绝不把密文写成 `.credentials.yaml`。
- **发布工作流**`.github/workflows/publish.yml`:推 `v*` tag 时自动跑全量测试 → 校验 tag 与版本号一致 → `npm publish --provenance` → 建 GitHub Release(附 tgz 资产);支持手动 dry run(只测试打包不发布)。需要仓库 Secret `NPM_TOKEN`(npm Automation token,否则会卡 EOTP)。新增 `scripts/verify-version.mjs` 校验三处版本号一致,CI 也接入。

### 变更
- 自动备份的默认组件集合随 `credentials` 组件加入而包含凭据(仍受密码开关约束)。
- `POST /dsh-backup/settings` 改为白名单 + 校验:`keep` 必须是 1..1000 整数、`destination` 必须是绝对路径、凭据密码至少 8 位。此前请求体被直接 merge 进配置文件,任何键、任何值都能写进去。
- `GET /dsh-backup/settings` 不再返回密码明文,改为 `credentialsPassphraseSet` / `credentialsPassphraseLength` / `credentialsMinLength`。此前 `cfgGet()` 结果原样进 JSON,明文密码会被发到浏览器并留在页面内存里。
- `GET /dsh-backup/disk` 增加 `defaultDestination` 与 `credentialsPassphraseSet`,供面板显示。
- `test/local-test.mjs` 的 `exportBackup` 改为直接调用 `assembleBackupZip`,不再复刻一份打包逻辑——复刻版会绕过导出侧的改动(脱敏 / 凭据加密),测试就白跑了。
- CI 补齐此前漏跑的 `test/route-harness.mjs`,并纳入新的 `test/credentials-test.mjs`。
- **分发渠道改为 GitHub Release,不再发 npm**:上游包名 `@having5548/dsh-backup` 属于原作者 having5548 的 npm scope,本仓库 `npm publish` 必然 403。`.github/workflows/publish.yml` 更名为 `Release`,去掉 npm publish 步骤与 `NPM_TOKEN` 依赖,保留「全量测试 → 校验 tag 与版本号一致 → `npm pack` → 建 GitHub Release(附 tgz 资产)」;`package.json` 的 `repository` / `bugs` / `homepage` 与两个 README 的安装说明改指本 fork;`AGENTS.md` 的发布清单同步改写(四处版本号 + 由 CI 发 Release)。包名沿用原值,因此安装本 fork 的 tgz 会以同名依赖覆盖 profile 里原有的上游插件。
- `README.md` 同步更新:组件表新增凭据库行、新增「🔑 凭据库加密」章节、救援通道补 `credentials` 与 `--passphrase`、备份格式补 `payload/credentials/`、FAQ 补「忘了密码怎么办」,并修正 Profile 插件清单一栏里写死的 `profiles/web/`。

### 修复
- **改了备份目录后自动备份会静默停摆 → 根因:自动备份开关状态存在备份目录内的 `.dsh-backup-auto.json`,而 `rescheduleAuto()` 从「当前目录」读取该文件。换目录后新目录里没有这个文件,`readAutoState()` 返回 `{}`,`hours` 取到 0 便直接 `return`(不注册定时器)。** 只要在下一次触发前重启过 dsh 就会中招,而且界面上只显示「关闭」,不报任何错。修法:`POST /settings` 检测到 `destination` 变化时,把旧目录的自动备份状态迁到新目录并重新排程;若旧目录本就没有状态(如首次设置),面板明确提示需要重新点「开启自动备份」。
- **`dsh-backup-settings.json` 会被 `extensions` 动态组件扫进备份包 → 根因:`dynamicExtensionSources()` 的 `known` 排除集只列了 `.` 开头的条目与几个已知目录名,该文件名不以 `.` 开头,于是被当作「第三方插件数据」。** 0.6.0 起该文件存放凭据加密密码,一旦被扫进包就等于密码与密文同包,加密形同虚设。修法:把 `.credentials.yaml` 与 `dsh-backup-settings.json` 加入 `known` 排除集,并补测试断言整包里不允许出现这两个文件名。
- **`rescue.mjs --dry-run` 会把整个备份解包到暂存区且从不清理 → 根因:预演分支在 `writeFile(staged, …)` 之后才 `continue`,而清理暂存区的代码被 `if (!dryRun)` 包住。** 预演本应零写入,实际却在 `~/.dsh/.dsh-backup-staging/` 留下一份完整解包数据;救援场景下 dsh 已经停了,没有 `cleanupStale` 来收尾。修法:预演在读取条目并判定目标后直接 `continue`,不创建暂存目录、不落任何字节。
- **双击「点我恢复」找不到备份 → 根因:救援控制台的 `defaultBackupDir()` 还在找 `~/Desktop/dsh-backups`,而 0.3.1 已把插件的默认落点改成 `~/Documents/dsh-backups`,本文件当时漏改。** 于是救援工具会报「目录里没有备份」——偏偏这是最需要它工作的时刻。修法:救援端按「文档 → 桌面 → 主目录」顺序探测,优先返回真正存在备份的目录,并在都没有备份时回落到与插件一致的默认值;补回归测试断言两侧一致。
- **救援控制台把插件清单硬编码还原到 `profiles/web` → 根因:`destFor()` 的 profile 分支写死 `'web'`,违反仓库硬性禁忌 8(新一代 Electron 桌面端用 `desktop` profile)。** 在桌面端做救援恢复会凭空造出一个 `profiles/web/` 目录。修法:改用 `process.env.DSH_PROFILE || 'web'`,与 `resolveProfileName()` 的回落规则一致。
- **插件装在含空格的路径下时,「下载救援工具包」返回 404 → 根因:`handleRescueDownload()` 用 `new URL(import.meta.url).pathname` 取自身目录,`URL.pathname` 保留百分号编码,路径里的空格变成 `%20` 且从不被解码,于是算出的 `rescue/` 目录不存在、`files.length === 0` 直接 404。** 受影响的不只是 `D:\Program Files\…`,也包括 AGENTS.md 里记录的官方安装路径 `H:\DeepSeek Harness\`——偏偏救援工具包是最需要它的时刻才用的。修法:改用 `fileURLToPath()`。同一处写法在 `rescue/rescue.mjs`(isMain 判定,会导致双击启动器在含空格路径下什么都不做)与两个测试文件里也存在,一并改掉。

### 兼容
- 备份格式仍为 **DshBackup v1**(`formatVersion` 不变)。新增的 `payload/credentials/` 对旧版插件属未知子目录,按既有约定「忽略并告警」,不会导致导入失败;反向(旧包进新插件)同理,凭据组件报 `notInBackup`。
- 新增设置键 `credentialsPassphrase`,旧配置文件缺该键时回落空字符串(即凭据组件跳过),行为与 0.5.0 一致——升级后不会突然开始往包里塞东西。
- 需要 Node ≥ 20(沿用);`engines.dsh` 仍为 `>=0.1.1-rc.2`。
- 面板新增的凭据密码输入框为 `type="password"`;`GET /settings` 永不回传密码,因此面板永远显示「已设置 / 未设置」而不回填。

## [0.5.0] - 2026-09-30

### 兼容
- **适配新一代 Electron 桌面端(desktop profile)**(补记:该版本发布时漏写本文件,条目据提交 8ff28bf 追记):profile 名不再硬编码 `web`,改为 `DSH_PROFILE` 环境变量 → `--profile` 参数 → 回落 `web`;新版桌面端(`DeepSeek Harness.exe`)使用 `desktop` profile,旧的 `web` profile 在那边已不存在,因此 profile 组件的备份/恢复落点跟随运行进程。
- manifest 与 `/status` 记录 profile 名,便于跨 profile 诊断。

## [0.4.0] - 2026-09-26

### 兼容
- **适配 dsh 0.1.6 / 0.1.7**:宿主 0.1.7 客户端已移除 `settingsScope` 服务,依赖它的插件会永久挂起(`pending (waiting for service: settingsScope)`)。客户端 inject 收敛为 `['slots', 'locale']`(与官方 0.1.7 兼容插件一致),`remote` / `sessions` 改为使用时惰性解析——缺席只损失对应功能,不再阻塞整个插件。0.1.5 列车不受影响。
- **设置持久化改为插件自管**(`~/.dsh/dsh-backup-settings.json`,原子写):不再依赖宿主 settings 服务的版本契约;新增 `GET/POST /dsh-backup/settings`。服务端 inject 同步收敛为 `['webServer']`。

## [0.3.1] - 2026-09-26

### 变更
- 自动备份目录默认位置从桌面改为**「文档」文件夹**(`~/Documents/dsh-backups`,Documents 不存在时回落主目录)
- UI 写明各类备份的落点:导出 = 浏览器下载文件夹;立即/自动备份 = 「备份目录」所示路径;「立即备份」完成消息带完整路径

## [0.3.0] - 2026-09-26

### 新增
- **AI 恢复助理**(默认关闭,自主控制 token 消耗):导入报告新增「让 AI 检查恢复结果」,一键经宿主官方 `ctx.remote.session` RPC 开新会话,把结构化恢复摘要与核查任务交给 DeepSeek——只读核查 mnemon 三目录一致性、抽查会话文件、校验 workspace.json;只做「明确安全且可逆」的最小修复,**绝不删除数据**,缺失插件不自行安装
- 设置开关「跨版本导入后自动让 AI 处理」(**默认关闭**):备份与本机 dsh 版本不同(或导入有报错)时,导入完成后自动启动 AI 助理
- 跨版本检测:导出 manifest 记录宿主 dsh 版本(从运行中 bin.js 路径反推),`/status` 同步提供,导入预检比对两侧版本并标注 `crossVersion`
- `POST /dsh-backup/assistant-brief`:服务端统一生成任务书(单一事实源,可测试)

## [0.2.3] - 2026-09-26

### 修复
- **设置页全部接口 404 空响应(浏览器报 `Unexpected end of JSON input`)→ 根因:路由前缀带尾斜杠。** dsh-host-webserver 的 prefix 匹配语义是 `pathname === prefix || pathname.startsWith(prefix + '/')`,此前 `ROUTE_PREFIX = '/dsh-backup/'` 退化为 `startsWith('/dsh-backup//')` 永不命中。现改为 `/dsh-backup`
- **「预检」请求挂死 → 根因:`spoolRequest` 从不调用 `ws.end()`,** 上传 handler 永不响应,网关超时掐断后浏览器拿到空响应体。现于请求体读完后正确收尾,并对客户端中途断开做清理
- **导出下载损坏 → 根因:流式输出开始后调用 `res.setHeader`**(ERR_HTTP_HEADERS_SENT)销毁连接。已移除该调用
- **脱敏备份被带校验导入误拒 → 根因:checksums 记录的是 settings.yaml 磁盘原始大小而非包内脱敏后大小。** 现记录实际条目大小
- 回归防护:新增 HTTP 路由回归测试(mock dsh webserver 全链路:预检→执行→导出→救援包,全部带超时防挂死)

## [0.2.1] - 2026-09-26

### 修复
- **服务启动即崩(`cannot get property "webServer" without inject`)→ 根因:cordis-plugin-loader 优先取 `exports.default` 作为插件对象**,此前把 `apply` 单独导出为 default,loader 拿到裸函数丢失 `inject` 声明。现改为纯命名导出(`export { apply, inject, name }`),与 dsh-notify / 官方插件契约一致
- **`/backup` 命令风险 → 根因:直接访问未声明的 `ctx.commands` getter 会抛错。** 改为经 `ctx.inject(['commands'], …)` 延迟接线,命令服务缺席不影响其余功能

## [0.2.0] - 2026-09-26

参考 [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup) 的设计吸收五项能力(按本插件的组件化 ZIP 架构重写):

### 新增
- **救援通道**:零依赖 `rescue.mjs`(list / verify / restore,默认只补缺失文件、`--force` 覆盖并留 `.bak-rescue-*`)+ 三平台「点我恢复」双击启动器;磁盘备份目录自动附带,面板可下载救援工具包
- **自动备份**:`/backup auto 12` 每 12 小时(1–720)写盘一次,重启自动续跑;每份带 `.sha256` sidecar,按保留份数(默认 7)自动轮换
- **`/backup` 斜杠命令**:`backup / list / verify / restore [--dry-run] [--mode] / auto / doctor / --keep N / help`(命令名冲突自动退回 `/dsh-backup`)
- **凭据脱敏**:导出默认把 settings.yaml 中疑似密钥值(自动识别 camelCase)替换为占位符并写 `redaction.json`;覆盖导入时占位符处自动回填本机现值
- **会话体检 doctor**:只读扫描全部会话(zstd 魔数 / 空文件 / JSONL 首字节)

### 变更
- 仓库:新增 CI(node 22/24 × ubuntu/windows 矩阵)、Issue 模板、`engines.dsh` 兼容声明、英文 README

## [0.1.0] - 2026-09-26

### 新增
- 首个版本
- **导出**:设置 → 备份与恢复,勾选组件后流式导出 DshBackup v1 ZIP 备份包(会话 / 工作区注册表 / 投影缓存 / 附件 / 设置 / 插件清单 / dsh-mnemon 记忆数据 / 其他插件数据)
- **导入**:预检(增量计划 + 缺失插件报告 + 警告)→ 合并 / 覆盖双模式执行 → 逐组件报告
- **会话保真**:会话文件字节级复制,不解包不改写;旧代际(v0–v2)由 harness 迁移链自动升级
- **mnemon 保真**:覆盖 = `~/.mnemon` 全量按字节还原(SQLite 换库先清 `-wal`/`-shm`);合并 = 官方 Pack 语义(热记忆去重并入、文档同 id 异内容换新 id、记忆体仅新增 body)
- **安全**:暂存区 + 逐文件 CRC32 校验 + manifest sha256 + 原子提交 + 失败回滚,被替换文件保留 `.bak-dshbackup-<时间戳>`;formatVersion 更新的备份明确拒绝
- **兼容**:payload 未知子目录忽略并告警;跨 Windows / macOS / Linux;仅依赖 schemastery

[未发布]: https://github.com/having5548/dsh-backup/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/having5548/dsh-backup/releases/tag/v0.6.0
[0.5.0]: https://github.com/having5548/dsh-backup/releases/tag/v0.5.0
[0.4.0]: https://github.com/having5548/dsh-backup/releases/tag/v0.4.0
[0.3.1]: https://github.com/having5548/dsh-backup/releases/tag/v0.3.1
[0.3.0]: https://github.com/having5548/dsh-backup/releases/tag/v0.3.0
[0.2.3]: https://github.com/having5548/dsh-backup/releases/tag/v0.2.3
[0.2.1]: https://github.com/having5548/dsh-backup/releases/tag/v0.2.1
[0.2.0]: https://github.com/having5548/dsh-backup/releases/tag/v0.2.0
[0.1.0]: https://github.com/having5548/dsh-backup/releases/tag/v0.1.0
