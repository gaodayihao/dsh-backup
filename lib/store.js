// ============================================================================
// dsh-backup —— 数据布局、组件模型、合并语义与安全恢复
//
// 设计原则（对应插件的三条硬要求）：
//   1. 对话完整、AI 可识别：会话文件（session.vN.jsonl[.zstd]）永远字节级
//      复制，不解包、不改写。dsh 打开旧代际会话时自带 v0→v1→v2→v3 迁移链，
//      未来新代际同理 —— 所以备份侧永远不需要理解会话格式。
//   2. 向下/向上兼容：manifest 只声明 formatVersion；导入时 formatVersion
//      更高的备份明确拒绝并提示升级插件，payload 中未知子目录忽略并告警。
//      workspace.json 以本机结构为准做保守合并（记录本身是扁平的
//      UUID→record 映射，跨小版本稳定）。
//   3. dsh-mnemon 上下文注入与原本一致：~/.mnemon 三目录（runtime /
//      documents / data [+ state]）字节级备份；覆盖导入 = 全量还原；合并
//      导入遵循 mnemon 官方 Pack 合并语义（memories 按 target+content 去重、
//      documents 同 id 同 contentHash 跳过 / 同 id 异内容换新 id、记忆体仅
//      新增 body）。SQLite 库替换时先清 -wal/-shm 再换库，防止旧 WAL 配新库。
//
// 所有写入走「暂存区 → 校验 → 原子提交 → 失败回滚」；暂存区放在目标所在盘
// （dshHome / mnemonRoot 内），保证 rename 同卷原子。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  encryptCredentials, decryptCredentials, hasPassphrase,
  CREDENTIALS_ZIP_PATH,
} from './crypto.js'

export const PLUGIN_VERSION_TAG = '0.6.1'
export const FORMAT = 'dsh-backup'
export const FORMAT_VERSION = 1
export const MANIFEST_NAME = 'manifest.json'
export const CHECKSUMS_NAME = 'checksums.json'

/** 用户 patch 层文件名（profile 内一份 + dshHome 根一份，后者叠加在所有 profile 之上）。 */
export const PROFILE_PATCH_FILE = 'cordis.patch.yml'
/** dshHome 根 patch 层的 zip 路径（与 profile 目录内那份区分开）。 */
export const HOME_PATCH_ZIP_PATH = 'payload/profile-home/cordis.patch.yml'

// ---------------------------------------------------------------------------
// 路径布局
// ---------------------------------------------------------------------------

export function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim()) return path.resolve(String(env).trim())
  return path.join(os.homedir(), '.dsh')
}

export function resolveMnemonRoot() {
  const env = process.env.MNEMON_DATA_DIR
  if (env && String(env).trim()) return path.resolve(String(env).trim())
  return path.join(os.homedir(), '.mnemon')
}

/**
 * 宿主注入的 profile 上下文（`ctx.get('profileContext')`，由 index.js 在 apply 时登记）。
 * DSH 的 profileContext 形如 `{ name, dir, patchPath, installAnchor, ... }`。
 * 必须在进程内共享：所有 resolveLayout() 调用点都要跟随同一个 profile。
 */
let profileContextOverride = null

export function setProfileContext(profileContext) {
  if (!profileContext || typeof profileContext !== 'object') return
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const next = {
    name: pick(profileContext.name),
    dir: pick(profileContext.dir),
    patchPath: pick(profileContext.patchPath),
  }
  if (!next.name && !next.dir && !next.patchPath) return
  profileContextOverride = next
}

export function clearProfileContext() { profileContextOverride = null }
export function getProfileContext() { return profileContextOverride }

/** 从 --profile <名> / --profile=<名> 提取（旧的 CLI 契约）。 */
function profileNameFromFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (String(argv[i]) === '--profile' && i + 1 < argv.length) {
      const v = String(argv[i + 1] || '').trim()
      if (v) return v
    }
    const m = /^--profile=(.+)$/.exec(String(argv[i] || ''))
    if (m && m[1].trim()) return m[1].trim()
  }
  return null
}

/**
 * 从位置参数里识别 `<dshHome>/profiles/<名>`。
 * Electron 桌面端就是这样传 profile 的：`DeepSeek Harness.exe ... <app.asar>/dsh
 * <profileDir> <runtime> ...` —— 既没有 `--profile`，Harness 进程自身也拿不到
 * `DSH_PROFILE`（那个变量只由 dsh-shell-env 注入模型 shell 调用）。
 * 不识别它，桌面端就会把所有 profile 误判成不存在的 `web`（见 CHANGELOG「未发布」修复条）。
 */
function profileNameFromPositionalArg(argv, dshHome) {
  if (!dshHome) return null
  const profilesDir = path.normalize(path.join(dshHome, 'profiles'))
  for (const raw of argv) {
    const arg = String(raw || '')
    if (!arg || arg.startsWith('-')) continue
    const normalized = path.normalize(arg)
    if (path.dirname(normalized) !== profilesDir) continue
    const base = path.basename(normalized)
    if (base && base !== '.' && base !== '..') return base
  }
  return null
}

/** profiles 目录下只有一个候选时兜底采用它（桌面端通常只有一个 profile）。 */
function profileNameFromSoleDir(dshHome) {
  try {
    const items = fs.readdirSync(path.join(dshHome, 'profiles'), { withFileTypes: true })
    const dirs = items.filter((it) => it.isDirectory() && !it.name.startsWith('.'))
    if (dirs.length === 1) return dirs[0].name
  } catch { /* profiles 目录不存在：交给回落值 */ }
  return null
}

/**
 * 探测当前进程运行的 profile。按可靠性从高到低：
 *   1. ctx.get('profileContext')            —— 宿主注入的权威来源（含 dir / patchPath）
 *   2. DSH_PROFILE_DIR 环境变量             —— 目录优先于名字，可直接定位
 *   3. DSH_PROFILE 环境变量
 *   4. 命令行 --profile <名> / --profile=<名>
 *   5. 命令行位置参数 <dshHome>/profiles/<名>（Electron 桌面端）
 *   6. <dshHome>/profiles 下唯一的目录
 *   7. 回落 'web'（旧 CLI 默认）
 * 新版桌面端(Electron)使用 'desktop' profile，旧版 CLI 为 'web'；
 * profile 组件的备份/恢复落点必须跟随当前进程，不能硬编码。
 */
export function resolveProfile() {
  const dshHome = resolveDshHome()
  const argv = Array.isArray(process.argv) ? process.argv : []

  if (profileContextOverride) {
    const dir = profileContextOverride.dir
    const name = profileContextOverride.name || (dir ? path.basename(dir) : null)
    if (name) {
      return { name, dir, patchPath: profileContextOverride.patchPath, source: 'profileContext' }
    }
  }

  const envDir = process.env.DSH_PROFILE_DIR
  if (envDir && String(envDir).trim()) {
    const dir = path.resolve(String(envDir).trim())
    const name = path.basename(dir)
    if (name) return { name, dir, patchPath: path.join(dir, PROFILE_PATCH_FILE), source: 'DSH_PROFILE_DIR' }
  }

  const env = process.env.DSH_PROFILE
  if (env && String(env).trim()) {
    const name = String(env).trim()
    return { name, dir: null, patchPath: null, source: 'DSH_PROFILE' }
  }

  const flagged = profileNameFromFlag(argv)
  if (flagged) return { name: flagged, dir: null, patchPath: null, source: '--profile' }

  const positional = profileNameFromPositionalArg(argv, dshHome)
  if (positional) {
    return { name: positional, dir: path.join(dshHome, 'profiles', positional), patchPath: null, source: 'argv-profile-dir' }
  }

  const sole = profileNameFromSoleDir(dshHome)
  if (sole) return { name: sole, dir: null, patchPath: null, source: 'sole-profile-dir' }

  return { name: 'web', dir: null, patchPath: null, source: 'fallback-web' }
}

export function resolveProfileName() {
  return resolveProfile().name
}

export function resolveLayout(profileName) {
  const dshHome = resolveDshHome()
  const resolved = resolveProfile()
  const explicit = typeof profileName === 'string' && profileName.trim() ? profileName.trim() : null
  const name = explicit || resolved.name

  // 显式传名时不借用 profileContext 的目录（调用方明确指定了另一个 profile）；
  // 否则优先使用宿主给的绝对目录，避免再拼一次可能拼错的路径。
  const useContextDir = !explicit && !!resolved.dir
  const profileDir = useContextDir ? resolved.dir : path.join(dshHome, 'profiles', name)
  const patchPath = useContextDir && resolved.patchPath
    ? resolved.patchPath
    : path.join(profileDir, PROFILE_PATCH_FILE)

  return {
    dshHome,
    profileName: name,
    profileSource: resolved.source,
    profileDir,
    mnemonRoot: resolveMnemonRoot(),
    p: {
      sessions: path.join(dshHome, 'sessions'),
      archive: path.join(dshHome, 'dsh-session-archive'),
      storages: path.join(dshHome, 'storages'),
      workspaceJson: path.join(dshHome, 'storages', 'workspace.json'),
      projcache: path.join(dshHome, 'storages', 'session_projcache'),
      attachments: path.join(dshHome, 'attachments'),
      settingsYaml: path.join(dshHome, 'settings.yaml'),
      credentialsYaml: path.join(dshHome, '.credentials.yaml'),
      profilePackageJson: path.join(profileDir, 'package.json'),
      // profileDir 同时挂在 layout.p 上：组件 sources(p) 只拿到 p，不能假设它能访问 layout
      profileDir,
      profilePatchYml: patchPath,
      profileCordisYml: path.join(profileDir, 'cordis.yml'),
      profilePnpmWorkspace: path.join(profileDir, 'pnpm-workspace.yaml'),
      homePatchYml: path.join(dshHome, PROFILE_PATCH_FILE),
      mnemonRuntime: path.join(resolveMnemonRoot(), 'runtime'),
      mnemonDocuments: path.join(resolveMnemonRoot(), 'documents'),
      mnemonData: path.join(resolveMnemonRoot(), 'data'),
      mnemonState: path.join(resolveMnemonRoot(), 'state'),
    },
  }
}

const PROFILE_FILES = ['package.json', PROFILE_PATCH_FILE, 'cordis.yml', 'pnpm-workspace.yaml']
const PROFILE_ZIP_BASE = 'payload/profile'
const EXTENSIONS_ZIP_BASE = 'payload/extensions'

// 导出侧组件定义。dynamic 组件（extensions）在运行时补全 sources。
export const COMPONENTS = [
  { id: 'sessions', label: '会话记录（全部对话）', sources: (p) => [
    { abs: p.sessions, zip: 'payload/sessions' },
    { abs: p.archive, zip: 'payload/sessions-archive' },
  ] },
  { id: 'workspaces', label: '工作区注册表', sources: (p) => [
    { abs: p.workspaceJson, zip: 'payload/storages/workspace.json', file: true },
  ] },
  { id: 'projcache', label: '会话投影缓存', sources: (p) => [
    { abs: p.projcache, zip: 'payload/storages/session_projcache' },
  ] },
  { id: 'attachments', label: '附件（对话中引用的文件/图片）', sources: (p) => [
    { abs: p.attachments, zip: 'payload/attachments' },
  ] },
  { id: 'settings', label: '设置文件 settings.yaml（可能含密钥）', sources: (p) => [
    { abs: p.settingsYaml, zip: 'payload/settings/settings.yaml', file: true },
  ] },
  // 凭据库是「整文件皆为密钥」，通用逐行脱敏对它无意义，因此单独成组件并
  // 强制加密（AES-256-GCM + scrypt）。没有密码时该组件会被跳过，绝不明文导出。
  { id: 'credentials', label: '凭据库 .credentials.yaml（AES-256-GCM 加密，需设置密码）', encrypt: 'credentials', sources: (p) => [
    { abs: p.credentialsYaml, zip: CREDENTIALS_ZIP_PATH, file: true },
  ] },
  // profile 组件同时承载「插件清单」和「用户 patch 配置」：
  //   - cordis.patch.yml 是用户配置本体（模型/provider/MCP/UI 等覆盖），
  //     丢失即换机失效，必须有独立的还原语义（见 shouldRestoreProfileEntry）；
  //   - dshHome 根的 cordis.patch.yml 是叠加在所有 profile 之上的全局 patch 层；
  //   - package.json / cordis.yml / pnpm-workspace.yaml 是插件清单与生成物，只补缺。
  { id: 'profile', label: 'Profile 插件清单与用户配置（cordis.patch.yml 等）', sources: (p) => [
    ...PROFILE_FILES.map((f) => ({
      abs: f === PROFILE_PATCH_FILE ? p.profilePatchYml : path.join(p.profileDir, f),
      zip: PROFILE_ZIP_BASE + '/' + f,
      file: true,
    })),
    { abs: p.homePatchYml, zip: HOME_PATCH_ZIP_PATH, file: true },
  ] },
  { id: 'mnemon', label: 'dsh-mnemon 记忆数据（上下文注入来源）', sources: (p) => [
    { abs: p.mnemonRuntime, zip: 'payload/mnemon/runtime' },
    { abs: p.mnemonDocuments, zip: 'payload/mnemon/documents' },
    { abs: p.mnemonData, zip: 'payload/mnemon/data' },
    { abs: p.mnemonState, zip: 'payload/mnemon/state', optional: true },
  ] },
  { id: 'extensions', label: '其他插件数据（task-board / dsh-usage / skins 等）', dynamic: true },
]

export function componentLabel(id) {
  const c = COMPONENTS.find((x) => x.id === id)
  return c ? c.label : id
}

// ---------------------------------------------------------------------------
// 通用文件工具
// ---------------------------------------------------------------------------

export async function pathExists(abs) {
  try { await fs.promises.stat(abs); return true } catch { return false }
}

export async function walkFiles(dir, baseDir) {
  const out = []
  const root = baseDir || dir
  let items
  try {
    items = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const item of items) {
    const abs = path.join(dir, item.name)
    if (item.isDirectory()) {
      out.push(...await walkFiles(abs, root))
    } else if (item.isFile()) {
      const stat = await fs.promises.stat(abs)
      out.push({ abs, rel: path.relative(root, abs), size: stat.size, mtime: stat.mtime })
    }
  }
  return out
}

export async function dirSize(dir) {
  const files = await walkFiles(dir)
  return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) }
}

/** 同目录临时文件 + rename 的原子写（JSON）。 */
export async function atomicWriteJson(abs, obj) {
  await fs.promises.mkdir(path.dirname(abs), { recursive: true })
  const tmp = abs + '.dshbackup-tmp-' + crypto.randomBytes(4).toString('hex')
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8')
  await renameWithRetry(tmp, abs)
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** rename，带 EPERM/EBUSY 重试（Windows 上目标被占用时短暂等待）。 */
async function renameWithRetry(src, dest, tries = 4) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      await fs.promises.rename(src, dest)
      return
    } catch (err) {
      lastErr = err
      if (err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') && i < tries - 1) {
        await delay(250 * (i + 1))
        continue
      }
      if (err && err.code === 'EXDEV') {
        // 跨卷：复制 + 同卷临时名 rename
        const tmp = dest + '.dshbackup-xdev-' + crypto.randomBytes(4).toString('hex')
        await fs.promises.copyFile(src, tmp)
        try {
          await fs.promises.rename(tmp, dest)
          await fs.promises.unlink(src).catch(() => {})
          return
        } catch (e2) {
          await fs.promises.unlink(tmp).catch(() => {})
          throw e2
        }
      }
      throw err
    }
  }
  throw lastErr
}

/**
 * 把暂存文件提交到目标位置（同卷 rename）。
 * - 目标存在：先把原文件 rename 成 .bak-dshbackup-<ts>（保留回滚手尾），再提交；
 *   提交失败则把 .bak 还原回目标。
 * - 返回 { action: 'created'|'replaced', backupPath? }
 */
export async function commitFile(staged, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  let existing = false
  try { await fs.promises.stat(dest); existing = true } catch { /* not there */ }
  if (!existing) {
    await renameWithRetry(staged, dest)
    return { action: 'created' }
  }
  const backupPath = dest + '.bak-dshbackup-' + timestampSlug()
  await renameWithRetry(dest, backupPath)
  try {
    await renameWithRetry(staged, dest)
    return { action: 'replaced', backupPath }
  } catch (err) {
    // 回滚：.bak 还原回目标
    await renameWithRetry(backupPath, dest).catch(() => {})
    throw err
  }
}

async function safeDelete(abs) {
  try { await fs.promises.unlink(abs); return true } catch (err) {
    if (err && (err.code === 'ENOENT')) return false
    throw err
  }
}

function timestampSlug(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
}

// ---------------------------------------------------------------------------
// 导出：估算 + 清单
// ---------------------------------------------------------------------------

export function dynamicExtensionSources(layout) {
  const known = new Set([
    'sessions', 'dsh-session-archive', 'storages', 'attachments', 'settings.yaml',
    'profiles', '.dsh-backup-staging', 'dshbackup-tmp',
    // 凭据与插件自身设置永不作为「第三方插件数据」被扫进来：
    // `.credentials.yaml` 只允许走加密组件；`dsh-backup-settings.json` 里存着
    // 凭据加密密码与备份目录（后者是本机路径，换机恢复时也不该被覆盖）。
    '.credentials.yaml', 'dsh-backup-settings.json',
  ])
  let items = []
  try { items = fs.readdirSync(layout.dshHome, { withFileTypes: true }) } catch { return [] }
  const sources = []
  for (const item of items) {
    if (known.has(item.name) || item.name.startsWith('.')) continue
    if (item.name.startsWith('dsh-backup-spool-')) continue
    const abs = path.join(layout.dshHome, item.name)
    if (item.isDirectory()) sources.push({ abs, zip: EXTENSIONS_ZIP_BASE + '/' + item.name })
    else if (item.isFile()) sources.push({ abs, zip: EXTENSIONS_ZIP_BASE + '/' + item.name, file: true })
  }
  return sources
}

export function componentSources(layout, id) {
  const def = COMPONENTS.find((c) => c.id === id)
  if (!def) return []
  if (def.dynamic) return dynamicExtensionSources(layout)
  return def.sources(layout.p)
}

export async function collectEstimate(layout, ids) {
  const components = {}
  for (const id of ids) {
    const sources = componentSources(layout, id)
    let files = 0
    let bytes = 0
    let present = false
    for (const src of sources) {
      if (!(await pathExists(src.abs))) continue
      present = true
      if (src.file) {
        const stat = await fs.promises.stat(src.abs)
        files += 1
        bytes += stat.size
      } else {
        const r = await dirSize(src.abs)
        files += r.files
        bytes += r.bytes
      }
    }
    components[id] = { present, files, bytes }
  }
  const counts = await collectCounts(layout)
  return { components, counts }
}

export async function collectCounts(layout) {
  // 会话目录数：sessions/<projectKey>/<sessionId>/ 两层
  let sessionDirs = 0
  let projectKeys = 0
  try {
    const keys = await fs.promises.readdir(layout.p.sessions, { withFileTypes: true })
    for (const k of keys) {
      if (!k.isDirectory()) continue
      projectKeys += 1
      const sess = await fs.promises.readdir(path.join(layout.p.sessions, k.name), { withFileTypes: true })
      sessionDirs += sess.filter((s) => s.isDirectory()).length
    }
  } catch { /* 无会话目录 */ }
  let archivedSessions = 0
  try {
    const arc = await fs.promises.readdir(layout.p.archive, { withFileTypes: true })
    archivedSessions = arc.filter((s) => s.isDirectory()).length
  } catch { /* 无归档 */ }

  let workspaces = 0
  let workspaceVersion = null
  try {
    const raw = JSON.parse(await fs.promises.readFile(layout.p.workspaceJson, 'utf8'))
    workspaceVersion = raw && raw.unit && raw.unit.version
    workspaces = Object.keys((raw && raw.tables && raw.tables.workspaces) || {}).length
  } catch { /* 无注册表 */ }

  const mnemon = await mnemonInventory(layout)

  return { sessionDirs, projectKeys, archivedSessions, workspaces, workspaceVersion, mnemon }
}

/** mnemon 数据盘点：三目录存在性、body 列表、健康标志（三个不变式抽查）。 */
export async function mnemonInventory(layout) {
  const root = layout.mnemonRoot
  const inv = { root, present: false, runtime: false, documents: false, data: false, state: false, bodies: [], memoryEntries: null, documentsCount: null, health: [] }
  if (!(await pathExists(root))) return inv
  inv.present = true
  inv.runtime = await pathExists(path.join(root, 'runtime'))
  inv.documents = await pathExists(path.join(root, 'documents'))
  inv.data = await pathExists(path.join(root, 'data'))
  inv.state = await pathExists(path.join(root, 'state'))

  try {
    const bodiesRaw = JSON.parse(await fs.promises.readFile(path.join(root, 'data', '.dsh-memory-bodies.json'), 'utf8'))
    const bodies = Array.isArray(bodiesRaw && bodiesRaw.bodies) ? bodiesRaw.bodies : []
    inv.bodies = bodies.map((b) => b && b.id).filter(Boolean)
  } catch { /* 没有 bodies 登记表 */ }

  try {
    const mem = JSON.parse(await fs.promises.readFile(path.join(root, 'runtime', 'memories.json'), 'utf8'))
    inv.memoryEntries = Array.isArray(mem && mem.entries) ? mem.entries.length : null
  } catch { /* 无或损坏 */ }

  try {
    const idx = JSON.parse(await fs.promises.readFile(path.join(root, 'documents', 'index.json'), 'utf8'))
    const docs = Array.isArray(idx && idx.documents) ? idx.documents : []
    inv.documentsCount = docs.length
    // 健康抽查：index 里登记的文档文件是否都存在
    let missing = 0
    for (const d of docs) {
      const rel = d && d.relativePath
      if (!rel) continue
      // index 中 relativePath 以存储根为基准（如 documents/active/xxx.md）
      const abs = path.isAbsolute(rel) ? rel : path.join(root, rel)
      if (!(await pathExists(abs))) missing += 1
    }
    if (missing > 0) inv.health.push(`index.json 中有 ${missing} 个文档文件缺失`)
  } catch { /* 无文档索引 */ }

  return inv
}

export async function buildManifest(layout, ids, componentStats) {
  const counts = await collectCounts(layout)
  const components = componentStats || (await collectEstimate(layout, ids)).components
  let bundles = []
  let profileDeps = {}
  try {
    const pkg = JSON.parse(await fs.promises.readFile(layout.p.profilePackageJson, 'utf8'))
    bundles = (pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
    profileDeps = (pkg && pkg.dependencies) || {}
  } catch { /* profile 不可读时照常导出 */ }

  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    producer: {
      plugin: 'dsh-backup',
      pluginVersion: PLUGIN_VERSION_TAG,
      dshVersion: hostVersion() || 'unknown',
      profile: layout.profileName,
      node: process.version,
      platform: process.platform,
    },
    source: {
      dshHome: layout.dshHome,
      profile: layout.profileName,
      mnemonRoot: layout.mnemonRoot,
    },
    counts,
    components,
    bundles,
    profileDeps,
  }
}

/**
 * 收集导出文件清单（index.js 路由与离线测试共用同一条路径）。
 * 返回 { files: [{abs, zipPath, mtime, size}], componentStats }。
 */
export async function collectExportFiles(layout, components) {
  const files = []
  const componentStats = {}
  for (const id of COMPONENTS.map((c) => c.id)) {
    const stat = { included: components.has(id), present: false, files: 0, bytes: 0 }
    componentStats[id] = stat
    if (!stat.included) continue
    for (const src of componentSources(layout, id)) {
      if (!(await pathExists(src.abs))) continue
      stat.present = true
      if (src.file) {
        const st = await fs.promises.stat(src.abs)
        files.push({ abs: src.abs, zipPath: src.zip, mtime: st.mtime, size: st.size })
        stat.files += 1
        stat.bytes += st.size
        continue
      }
      await collectInto(src.abs, src.zip, files, stat)
    }
  }
  return { files, componentStats }
}

async function collectInto(absDir, zipBase, files, stat) {
  let items
  try {
    items = await fs.promises.readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    const abs = path.join(absDir, item.name)
    if (item.isDirectory()) {
      await collectInto(abs, zipBase + '/' + item.name, files, stat)
    } else if (item.isFile()) {
      const st = await fs.promises.stat(abs)
      files.push({ abs, zipPath: zipBase + '/' + item.name, mtime: st.mtime, size: st.size })
      stat.files += 1
      stat.bytes += st.size
    }
  }
}

// ---------------------------------------------------------------------------
// 导入：zip 路径分类
// ---------------------------------------------------------------------------

export function classifyZipPath(zipPath) {
  const p = zipPath
  if (p === MANIFEST_NAME) return { kind: 'meta', component: null, rel: null }
  if (p === CHECKSUMS_NAME) return { kind: 'meta', component: null, rel: null }
  if (!p.startsWith('payload/')) return { kind: 'unknown', component: null, rel: null }
  const rest = p.slice('payload/'.length)
  if (rest.startsWith('sessions/')) return { kind: 'payload', component: 'sessions', rel: rest.slice('sessions/'.length) }
  if (rest.startsWith('sessions-archive/')) return { kind: 'payload', component: 'sessions', rel: rest.slice('sessions-archive/'.length), archive: true }
  if (rest === 'storages/workspace.json') return { kind: 'payload', component: 'workspaces', rel: 'workspace.json', special: 'workspaceJson' }
  if (rest.startsWith('storages/session_projcache/')) return { kind: 'payload', component: 'projcache', rel: rest.slice('storages/session_projcache/'.length) }
  if (rest.startsWith('attachments/')) return { kind: 'payload', component: 'attachments', rel: rest.slice('attachments/'.length) }
  if (rest === 'settings/settings.yaml') return { kind: 'payload', component: 'settings', rel: 'settings.yaml' }
  if (rest.startsWith('settings/')) return { kind: 'unknown', component: null, rel: null }
  if (rest === 'credentials/.credentials.yaml.enc') return { kind: 'payload', component: 'credentials', rel: '.credentials.yaml.enc' }
  if (rest.startsWith('credentials/')) return { kind: 'unknown', component: null, rel: null }
  // dshHome 根的全局 patch 层必须在 profile/ 之前判掉，否则会被当成 profile 目录内文件。
  if (rest === 'profile-home/' + PROFILE_PATCH_FILE) return { kind: 'payload', component: 'profile', rel: PROFILE_PATCH_FILE, home: true }
  if (rest.startsWith('profile-home/')) return { kind: 'unknown', component: null, rel: null }
  if (rest.startsWith('profile/')) return { kind: 'payload', component: 'profile', rel: rest.slice('profile/'.length) }
  if (rest.startsWith('mnemon/')) return { kind: 'payload', component: 'mnemon', rel: rest.slice('mnemon/'.length) }
  if (rest.startsWith('extensions/')) return { kind: 'payload', component: 'extensions', rel: rest.slice('extensions/'.length) }
  return { kind: 'unknown', component: null, rel: null }
}

export function destForComponent(layout, cls) {
  const p = layout.p
  const rel = cls.rel
  switch (cls.component) {
    case 'sessions': return cls.archive ? path.join(p.archive, rel) : path.join(p.sessions, rel)
    case 'workspaces': return p.workspaceJson
    case 'projcache': return path.join(p.projcache, rel)
    case 'attachments': return path.join(p.attachments, rel)
    case 'settings': return p.settingsYaml
    case 'credentials': return p.credentialsYaml
    case 'profile': {
      if (cls.home) return p.homePatchYml
      if (cls.rel === PROFILE_PATCH_FILE) return p.profilePatchYml
      return path.join(layout.profileDir, rel)
    }
    case 'extensions': {
      const segs = rel.split('/')
      const top = segs.shift()
      if (!top || top.startsWith('.') || /[\\/]/.test(top)) throw new Error(`extensions 路径非法：${rel}`)
      return path.join(layout.dshHome, top, ...segs)
    }
    case 'mnemon': return path.join(layout.mnemonRoot, rel)
    default: throw new Error(`未知组件：${cls.component}`)
  }
}

// ---------------------------------------------------------------------------
// 合并语义
// ---------------------------------------------------------------------------

/**
 * 合并 workspace.json（dsh-storage domain，unit version 2）。
 * 结构以本机为准（unit/global 骨架），记录按 UUID 合并、updatedAt 新者胜；
 * workspaceIds 保序去重（本机在前）；archivedSessionIds 并集；
 * pendingMutation 保留本机（那是本机在途变更日志，备份侧的没有意义）。
 */
export function mergeWorkspaceRegistries(localRaw, backupRaw) {
  const local = localRaw && typeof localRaw === 'object' ? localRaw : null
  const backup = backupRaw && typeof backupRaw === 'object' ? backupRaw : null
  const localUnit = local && local.unit && local.unit.name === 'workspace' ? local.unit : null
  const backupUnit = backup && backup.unit && backup.unit.name === 'workspace' ? backup.unit : null
  const unit = localUnit
    ? { ...localUnit }
    : (backupUnit ? { ...backupUnit } : { name: 'workspace', version: 2 })

  const localGlobal = (local && local.global) || {}
  const backupGlobal = (backup && backup.global) || {}
  const localTables = (local && local.tables && local.tables.workspaces) || {}
  const backupTables = (backup && backup.tables && backup.tables.workspaces) || {}

  const workspaceIds = []
  const seen = new Set()
  for (const id of (localGlobal.workspaceIds || [])) {
    if (typeof id === 'string' && !seen.has(id)) { seen.add(id); workspaceIds.push(id) }
  }
  for (const id of (backupGlobal.workspaceIds || [])) {
    if (typeof id === 'string' && !seen.has(id)) { seen.add(id); workspaceIds.push(id) }
  }

  const archived = []
  const archSeen = new Set()
  for (const s of [...(localGlobal.archivedSessionIds || []), ...(backupGlobal.archivedSessionIds || [])]) {
    if (typeof s === 'string' && !archSeen.has(s)) { archSeen.add(s); archived.push(s) }
  }

  const tables = {}
  let added = 0
  let updated = 0
  let kept = 0
  const ids = new Set([...Object.keys(localTables), ...Object.keys(backupTables)])
  for (const id of ids) {
    const a = localTables[id]
    const b = backupTables[id]
    if (a && b) {
      const aT = String(a.updatedAt || '')
      const bT = String(b.updatedAt || '')
      if (bT > aT) { tables[id] = b; updated += 1 } else { tables[id] = a; kept += 1 }
    } else if (a) { tables[id] = a; kept += 1 } else { tables[id] = b; added += 1 }
    // workspaceIds 与 tables 理应一致；对稍有不一致的真实数据兜底：孤儿记录追加到队尾
    if (!seen.has(id)) { seen.add(id); workspaceIds.push(id) }
  }

  const result = {
    unit,
    global: {
      initialized: !!(localGlobal.initialized || backupGlobal.initialized),
      workspaceIds,
      archivedSessionIds: archived,
    },
    tables: { workspaces: tables },
  }
  if (local && local.global && local.global.pendingMutation) {
    result.global.pendingMutation = local.global.pendingMutation
  }
  return { result, added, updated, kept }
}

/** 合并 memories.json：按 target+content 去重（mnemon 官方 Pack 合并语义）。 */
export function mergeMemoriesJson(localRaw, backupRaw) {
  const local = localRaw && Array.isArray(localRaw.entries) ? localRaw : { version: 1, entries: [] }
  const backup = backupRaw && Array.isArray(backupRaw.entries) ? backupRaw : { version: 1, entries: [] }
  const version = Math.max(Number(local.version) || 1, Number(backup.version) || 1)
  const keyOf = (e) => String((e && e.target) || 'memory') + '::' + String((e && e.content) || '')
  const seen = new Set()
  const entries = []
  for (const e of local.entries) {
    const k = keyOf(e)
    if (!seen.has(k)) { seen.add(k); entries.push(e) }
  }
  let added = 0
  for (const e of backup.entries) {
    const k = keyOf(e)
    if (!seen.has(k)) { seen.add(k); entries.push(e); added += 1 }
  }
  return { json: { version, entries }, added, total: entries.length }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s) }
export function newUuid() { return crypto.randomUUID() }

/** 文件名里的 8 hex 短 id（<slug>-<8hex>.md）换新 id 前缀。 */
function renameDocFilename(filename, newId) {
  const m = /^(.*?)-([0-9a-f]{8})\.md$/i.exec(filename)
  const head = m ? m[1] : String(filename).replace(/\.md$/i, '')
  return head + '-' + newId.slice(0, 8) + '.md'
}

/**
 * 合并 documents/index.json（mnemon 官方语义）：
 * - 同 id 同 contentHash：跳过
 * - 同 id 异 contentHash：备份侧文档改用新 id / 新文件名导入
 * - 新 id：整体导入
 * 返回需要落盘的文档写入计划（在暂存区内改名）与合并后的 index。
 */
export function mergeDocumentsIndex(localIndexRaw, backupIndexRaw) {
  const local = localIndexRaw && Array.isArray(localIndexRaw.documents) ? localIndexRaw : { version: 1, documents: [] }
  const backup = backupIndexRaw && Array.isArray(backupIndexRaw.documents) ? backupIndexRaw : { version: 1, documents: [] }
  const version = Math.max(Number(local.version) || 1, Number(backup.version) || 1)
  const localById = new Map(local.documents.map((d) => [d && d.id, d]))
  // 只用本机已有文件名做冲突基线；备份侧文件名逐个处理后加入
  const usedFilenames = new Set()
  for (const d of local.documents) {
    if (d && d.filename) usedFilenames.add(d.filename)
  }

  const documents = local.documents.slice()
  const ops = []
  let added = 0
  let renamed = 0
  let skipped = 0
  for (const doc of backup.documents) {
    if (!doc || !doc.id) continue
    const existing = localById.get(doc.id)
    if (existing) {
      if (existing.contentHash && doc.contentHash && existing.contentHash === doc.contentHash) {
        skipped += 1
        continue
      }
      // 同 id 异内容：换新 id 导入
      const newId = newUuid()
      const newFilename = renameDocFilename(doc.filename || 'document.md', newId)
      let finalName = newFilename
      let n = 2
      while (usedFilenames.has(finalName)) {
        finalName = newFilename.replace(/\.md$/i, '') + '-' + n + '.md'
        n += 1
      }
      usedFilenames.add(finalName)
      const entry = {
        ...doc,
        id: newId,
        filename: finalName,
        relativePath: 'documents/' + (doc.status === 'archived' ? 'archived' : 'active') + '/' + finalName,
        createdAt: doc.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      documents.push(entry)
      ops.push({ kind: 'rename', from: doc.filename, to: finalName, entry })
      renamed += 1
      added += 1
      continue
    }
    // 新 id：检查文件名冲突
    let entry = { ...doc }
    if (doc.filename && usedFilenames.has(doc.filename)) {
      const newId = newUuid()
      const newFilename = renameDocFilename(doc.filename, newId)
      let finalName = newFilename
      let n = 2
      while (usedFilenames.has(finalName)) {
        finalName = newFilename.replace(/\.md$/i, '') + '-' + n + '.md'
        n += 1
      }
      usedFilenames.add(finalName)
      entry = { ...doc, id: doc.id, filename: finalName, relativePath: 'documents/' + (doc.status === 'archived' ? 'archived' : 'active') + '/' + finalName }
      ops.push({ kind: 'rename', from: doc.filename, to: finalName, entry })
      renamed += 1
    } else {
      if (doc.filename) usedFilenames.add(doc.filename)
      ops.push({ kind: 'copy', from: doc.filename, to: doc.filename, entry })
    }
    documents.push(entry)
    added += 1
  }
  return { index: { version, documents }, ops, added, renamed, skipped }
}

// ---------------------------------------------------------------------------
// 导入：计划（预检）与执行
// ---------------------------------------------------------------------------

export const REPORT_LIMIT = 60

function pushCapped(list, item, cap = REPORT_LIMIT) {
  if (list.length < cap) list.push(item)
}

// ---------------------------------------------------------------------------
// profile 组件：用户 patch 配置 vs 插件清单
//
// 换机恢复的真实情形是：DSH 首次启动就用模板把 cordis.patch.yml 建成 `[]`
// （见 dsh 的 initProfile），因此「文件已存在」不代表「用户已有配置」。
// 对 patch 文件必须覆盖；对插件清单/生成物则维持只补缺，避免打乱本机插件。
// ---------------------------------------------------------------------------

/** profile 组件里等价于「用户配置」的文件（必须可覆盖还原）。 */
export function isProfilePatchEntry(cls) {
  return !!cls && cls.rel === PROFILE_PATCH_FILE
}

/** 计划/报告里展示的条目名（区分 dshHome 根 patch 与 profile 内 patch）。 */
export function profileEntryLabel(cls) {
  if (cls && cls.home) return 'home/' + PROFILE_PATCH_FILE
  return (cls && cls.rel) || ''
}

/** 该条目是否属于 profile 组件允许还原的已知文件。 */
export function isKnownProfileEntry(cls) {
  if (!cls) return false
  if (cls.home) return cls.rel === PROFILE_PATCH_FILE
  return PROFILE_FILES.includes(cls.rel)
}

/** 内容是否是「空白 patch 模板」（只有注释和 `[]` / 空）。 */
export function isEmptyPatchText(text) {
  const body = String(text == null ? '' : text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .trim()
  return body === '' || body === '[]'
}

async function isEmptyPatchFile(abs) {
  try { return isEmptyPatchText(await fs.promises.readFile(abs, 'utf8')) } catch { return true }
}

/**
 * profile 条目的还原判定：
 *   - 本机不存在            → 还原（所有文件）
 *   - patch 文件 + 覆盖模式 → 还原（覆盖，原文件留 .bak）
 *   - patch 文件 + 合并模式 + 本机是空模板 → 还原（空模板没有可保留的用户内容）
 *   - 其余（插件清单/生成物，或本机已有真实 patch）→ 保留本机
 */
export function shouldRestoreProfileEntry({ cls, exists, mode, localEmptyPatch }) {
  if (!exists) return true
  if (!isProfilePatchEntry(cls)) return false
  if (mode === 'replace') return true
  return mode === 'merge' && localEmptyPatch === true
}

/**
 * 生成导入计划（不写任何东西）。
 * @param entries 已解析的 zip 条目（ZipReader.entries）
 * @param opts { layout, mode: 'merge'|'replace', components: Set<string>, manifest, checksums, credentialsPassphrase }
 */
export async function planImport(reader, opts) {
  const { layout, mode, components, manifest } = opts
  const localV = hostVersion() || 'unknown'
  const backupV = (manifest && manifest.producer && manifest.producer.dshVersion) || 'unknown'
  const plan = {
    mode,
    crossVersion: backupV !== 'unknown' && localV !== 'unknown' && backupV !== localV,
    components: {},
    warnings: [],
    missingPlugins: [],
  }
  const byComponent = new Map()
  for (const id of ['sessions', 'workspaces', 'projcache', 'attachments', 'settings', 'credentials', 'profile', 'mnemon', 'extensions']) {
    byComponent.set(id, { files: [], special: [] })
  }

  for (const entry of reader.entries) {
    const name = entry.name
    if (name.endsWith('/')) continue // 目录占位
    const cls = classifyZipPath(name)
    if (cls.kind === 'unknown') {
      pushCapped(plan.warnings, `备份中包含当前版本未识别的数据：${name}（已忽略，可能来自更新版本的插件）`)
      continue
    }
    if (cls.kind !== 'payload') continue
    const bucket = byComponent.get(cls.component)
    if (!bucket) continue
    if (!components.has(cls.component)) continue
    bucket.files.push({ entry, cls })
  }

  // ---- 逐组件计划 ----
  for (const [id, bucket] of byComponent) {
    const stat = { files: bucket.files.length, add: 0, overwrite: 0, skip: 0, conflicts: [], bytes: 0 }
    plan.components[id] = stat

    if (id === 'workspaces') {
      const hasFile = bucket.files.some((f) => f.cls.special === 'workspaceJson')
      stat.files = hasFile ? 1 : 0
      if (hasFile) {
        const entry = bucket.files.find((f) => f.cls.special === 'workspaceJson').entry
        try {
          const backupRaw = JSON.parse((await reader.readEntry(entry)).toString('utf8'))
          const localRaw = await readJsonIfExists(layout.p.workspaceJson)
          const merged = mergeWorkspaceRegistries(localRaw, backupRaw)
          stat.merge = { added: merged.added, updated: merged.updated, kept: merged.kept, total: Object.keys(merged.result.tables.workspaces).length }
          stat.backupWorkspaces = Object.keys((backupRaw && backupRaw.tables && backupRaw.tables.workspaces) || {}).length
        } catch (err) {
          stat.error = 'workspace.json 解析失败：' + String((err && err.message) || err)
        }
      } else {
        stat.merge = null
      }
      continue
    }

    if (id === 'settings') {
      stat.action = mode === 'replace' ? 'replaced' : 'skippedMergeMode'
      if (mode === 'replace' && bucket.files.length === 0) stat.action = 'notInBackup'
      if (mode === 'replace' && bucket.files.length > 0) {
        // 预检：统计备份里被脱敏的密钥处数（导入时这些 key 保留本机值）
        try {
          const text = await fs.promises.readFile(bucket.files[0].staged, 'utf8')
          stat.redactedCount = (text.match(new RegExp(REDACT_MARKER, 'g')) || []).length
        } catch { stat.redactedCount = 0 }
      }
      continue
    }

    if (id === 'credentials') {
      // 凭据是单文件、整文件替换语义：合并模式没有意义（合并两份凭据只会互相覆盖），
      // 因此与 settings.yaml 一致——只在覆盖导入时恢复。
      const file = bucket.files[0]
      const hasFile = !!file
      stat.files = hasFile ? 1 : 0
      stat.action = !hasFile ? 'notInBackup' : (mode === 'replace' ? 'replaced' : 'skippedMergeMode')
      if (hasFile) {
        const raw = await reader.readEntry(file.entry)
        try {
          const env = JSON.parse(raw.toString('utf8'))
          stat.algorithm = (env.cipher && env.cipher.name) || 'unknown'
          stat.kdf = (env.kdf && env.kdf.name) || 'unknown'
          stat.plaintextBytes = env.plaintext && env.plaintext.bytes
        } catch { /* 容器不是 JSON：留给解密那一步报明确错误 */ }
        // 预检就试开一次：让用户在这里知道密码对不对，而不是覆盖完才发现
        const probe = String(opts.credentialsPassphrase || '')
        if (!hasPassphrase(probe)) {
          stat.decryptable = false
          stat.needsPassphrase = true
          pushCapped(plan.warnings, '备份含加密凭据库，但当前未提供密码；导入时需输入密码，否则凭据组件会被跳过。')
        } else {
          try {
            decryptCredentials(raw, probe)
            stat.decryptable = true
          } catch (err) {
            stat.decryptable = false
            stat.decryptError = String((err && err.message) || err)
            pushCapped(plan.warnings, '加密凭据库无法用当前密码打开：' + stat.decryptError)
          }
        }
      }
      continue
    }

    if (id === 'profile') {
      const restoreFiles = []
      const keepFiles = []
      for (const f of bucket.files) {
        if (!isKnownProfileEntry(f.cls)) {
          pushCapped(plan.warnings, `profile 组件含未知文件：${profileEntryLabel(f.cls)}（已忽略）`)
          continue
        }
        const label = profileEntryLabel(f.cls)
        const dest = destForComponent(layout, f.cls)
        const exists = await pathExists(dest)
        const localEmptyPatch = exists && isProfilePatchEntry(f.cls) ? await isEmptyPatchFile(dest) : false
        if (shouldRestoreProfileEntry({ cls: f.cls, exists, mode, localEmptyPatch })) {
          restoreFiles.push(label)
          if (exists && isProfilePatchEntry(f.cls)) {
            pushCapped(plan.warnings, mode === 'replace'
              ? `${label}：将用备份内容覆盖本机文件（原文件另存为 .bak）`
              : `${label}：本机只是空模板，将用备份内容覆盖`)
          }
        } else {
          keepFiles.push(label)
          if (isProfilePatchEntry(f.cls) && exists) {
            pushCapped(plan.warnings, `${label}：本机已有非空配置，保留本机版本 —— 备份中的这份不会还原（如需强制还原请用「覆盖」模式）`)
          }
        }
      }
      stat.restoreFiles = restoreFiles
      stat.keepFiles = keepFiles
      // 缺失插件报告：备份 bundles vs 本机 profile bundles / dependencies
      try {
        const backupBundles = (manifest && Array.isArray(manifest.bundles)) ? manifest.bundles : []
        let localBundles = []
        let localDeps = {}
        const localPkg = await readJsonIfExists(layout.p.profilePackageJson)
        if (localPkg) {
          localBundles = (localPkg.dsh && localPkg.dsh.profile && localPkg.dsh.profile.bundles) || []
          localDeps = localPkg.dependencies || {}
        }
        const builtin = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'])
        const localSet = new Set([...localBundles, ...Object.keys(localDeps)])
        const backupDeps = (manifest && manifest.profileDeps) || {}
        const backupNameOf = new Map()
        for (const [dep, spec] of Object.entries(backupDeps)) backupNameOf.set(dep, dep)
        for (const b of backupBundles) {
          if (builtin.has(b)) continue
          if (localSet.has(b)) continue
          plan.missingPlugins.push({ name: b, spec: backupDeps[b] || backupNameOf.get(b) || b })
        }
      } catch { /* 报告失败不阻塞 */ }
      continue
    }

    if (id === 'mnemon') {
      const mPlan = await planMnemon(reader, layout, mode, bucket, manifest)
      Object.assign(stat, mPlan)
      continue
    }

    // sessions / projcache / attachments / extensions：逐文件 exists 对比
    for (const f of bucket.files) {
      let dest
      try {
        dest = destForComponent(layout, f.cls)
      } catch (err) {
        pushCapped(stat.conflicts, { file: f.entry.name, reason: String((err && err.message) || err) })
        stat.skip += 1
        continue
      }
      if (await pathExists(dest)) {
        if (mode === 'replace') {
          stat.overwrite += 1
          stat.bytes += f.entry.uncompressed
        } else {
          const lst = await fs.promises.stat(dest).catch(() => null)
          if (lst && lst.size !== f.entry.uncompressed) {
            pushCapped(stat.conflicts, { file: f.cls.rel, reason: `本机同名文件内容不同（本地 ${lst.size}B / 备份 ${f.entry.uncompressed}B），合并模式保留本机版本` })
          }
          stat.skip += 1
        }
      } else {
        stat.add += 1
        stat.bytes += f.entry.uncompressed
      }
    }
  }

  return plan
}

export async function readJsonIfExists(abs) {
  try {
    return JSON.parse(await fs.promises.readFile(abs, 'utf8'))
  } catch {
    return null
  }
}

/** mnemon 组件计划：读备份侧 memories/index/bodies，结合本机状态给出合并/覆盖方案。 */
async function planMnemon(reader, layout, mode, bucket, manifest) {
  const stat = { memoriesAdded: 0, memoriesTotal: null, documentsAdded: 0, documentsRenamed: 0, documentsSkipped: 0, bodiesAdded: 0, bodiesKept: 0, dbReplaced: 0, runtimeFiles: 0, otherFiles: 0, invalid: [], absent: bucket.files.length === 0 }

  const staged = { memories: null, index: null, bodies: null }
  const fileRels = []
  for (const f of bucket.files) {
    const rel = f.cls.rel
    if (rel === 'runtime/memories.json') {
      try { staged.memories = JSON.parse((await reader.readEntry(f.entry)).toString('utf8')) } catch (err) { stat.invalid.push('备份 memories.json 无法解析：' + String((err && err.message) || err)) }
    } else if (rel === 'documents/index.json') {
      try { staged.index = JSON.parse((await reader.readEntry(f.entry)).toString('utf8')) } catch (err) { stat.invalid.push('备份 documents/index.json 无法解析：' + String((err && err.message) || err)) }
    } else if (rel === 'data/.dsh-memory-bodies.json') {
      try { staged.bodies = JSON.parse((await reader.readEntry(f.entry)).toString('utf8')) } catch (err) { stat.invalid.push('备份 .dsh-memory-bodies.json 无法解析：' + String((err && err.message) || err)) }
    } else {
      fileRels.push(rel)
    }
  }
  stat.runtimeFiles = fileRels.filter((r) => r.startsWith('runtime/')).length
  stat.backupPresent = bucket.files.length > 0

  if (mode === 'replace') {
    stat.dbReplaced = fileRels.filter((r) => /^data\/[^/]+\/mnemon\.db$/.test(r)).length
    stat.otherFiles = fileRels.length
    return stat
  }

  // ---- 合并模式 ----
  const localRoot = layout.mnemonRoot
  if (staged.memories) {
    const localMem = await readJsonIfExists(path.join(localRoot, 'runtime', 'memories.json'))
    const merged = mergeMemoriesJson(localMem, staged.memories)
    stat.memoriesAdded = merged.added
    stat.memoriesTotal = merged.total
  }
  if (staged.index) {
    const localIndex = await readJsonIfExists(path.join(localRoot, 'documents', 'index.json'))
    const merged = mergeDocumentsIndex(localIndex, staged.index)
    stat.documentsAdded = merged.added
    stat.documentsRenamed = merged.renamed
    stat.documentsSkipped = merged.skipped
  }
  if (staged.bodies && Array.isArray(staged.bodies.bodies)) {
    const localBodies = await readJsonIfExists(path.join(localRoot, 'data', '.dsh-memory-bodies.json'))
    const localIds = new Set(((localBodies && Array.isArray(localBodies.bodies)) ? localBodies.bodies : []).map((b) => b && b.id).filter(Boolean))
    for (const b of staged.bodies.bodies) {
      if (!b || !b.id) continue
      if (localIds.has(b.id)) { stat.bodiesKept += 1; continue }
      const hasDb = fileRels.some((r) => r === 'data/' + b.id + '/mnemon.db')
      if (hasDb) stat.bodiesAdded += 1
    }
  }
  return stat
}

// ---------------------------------------------------------------------------
// 导入：执行
// ---------------------------------------------------------------------------

/**
 * 从 reader 抽取 payload 条目到暂存区并（可选）校验 sha256。
 * 暂存目录按目标盘选择：mnemon 目标 → mnemonRoot 内；其余 → dshHome 内。
 * 返回 { stagingRootDsh, stagingRootMnemon, extracted: Map<zipPath, stagedAbs> }
 */
export async function extractPayload(reader, entries, layout, checksums, verify) {
  const stagingId = 'dsh-backup-staging-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex')
  const stagingRootDsh = path.join(layout.dshHome, '.dsh-backup-staging', stagingId)
  const stagingRootMnemon = path.join(layout.mnemonRoot, '.dsh-backup-staging', stagingId)
  await fs.promises.mkdir(stagingRootDsh, { recursive: true })
  // mnemon 暂存根惰性创建：备份里没有 mnemon 组件时不要凭空造出 ~/.mnemon 骨架
  let mnemonStagingReady = false
  const extracted = new Map()
  const hashErrors = []

  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    const cls = classifyZipPath(entry.name)
    if (cls.kind !== 'payload') continue
    let dest
    try {
      dest = destForComponent(layout, cls)
    } catch {
      continue // 分类已告警
    }
    const isMnemon = dest.startsWith(layout.mnemonRoot)
    if (isMnemon && !mnemonStagingReady) {
      await fs.promises.mkdir(stagingRootMnemon, { recursive: true })
      mnemonStagingReady = true
    }
    const stagingRoot = isMnemon ? stagingRootMnemon : stagingRootDsh
    // 暂存名必须区分 dshHome 根 patch 与 profile 内 patch：两者 component/rel
    // 相同（profile + cordis.patch.yml），只用 rel 会互相覆盖。
    const stagedName = (cls.home ? 'home__' : '') + cls.rel.replace(/[/\\]/g, '__')
    const staged = path.join(stagingRoot, cls.component, stagedName)
    await fs.promises.mkdir(path.dirname(staged), { recursive: true })
    const hash = crypto.createHash('sha256')
    const ws = await fs.promises.open(staged, 'w')
    try {
      await reader.extractEntryTo(entry, async (chunk) => {
        hash.update(chunk)
        await ws.write(chunk)
      })
    } finally {
      await ws.close()
    }
    if (verify && checksums && checksums.files && checksums.files[entry.name]) {
      const expect = checksums.files[entry.name]
      if (typeof expect === 'string') {
        if (hash.digest('hex') !== String(expect).toLowerCase()) {
          hashErrors.push(entry.name)
          await fs.promises.unlink(staged).catch(() => {})
          continue
        }
      } else if (expect && typeof expect.size === 'number' && expect.size !== entry.uncompressed) {
        hashErrors.push(entry.name)
        await fs.promises.unlink(staged).catch(() => {})
        continue
      }
    }
    extracted.set(entry.name, staged)
  }

  if (hashErrors.length > 0) {
    throw new Error(`以下文件 sha256 校验失败，备份可能已损坏：${hashErrors.slice(0, 10).join('、')}${hashErrors.length > 10 ? ` 等 ${hashErrors.length} 个` : ''}`)
  }
  return { stagingRootDsh, stagingRootMnemon, extracted }
}

/**
 * 执行导入。调用前应已 planImport 并 extractPayload。
 * @param opts { layout, mode, components, manifest, extracted, stagingRoots, plan, credentialsPassphrase }
 * @returns report
 */
export async function applyImport(reader, opts) {
  const { layout, mode, components, manifest, extracted, stagingRoots, plan } = opts
  const credentialsPassphrase = String(opts.credentialsPassphrase || '')
  const report = {
    ok: true,
    mode,
    applied: 0,
    needsRestart: false,
    components: {},
    mnemon: null,
    missingPlugins: plan.missingPlugins || [],
    warnings: plan.warnings || [],
    errors: [],
    backups: [],
    durationMs: 0,
  }
  const started = Date.now()

  const byComponent = new Map()
  for (const entry of reader.entries) {
    if (entry.name.endsWith('/')) continue
    const cls = classifyZipPath(entry.name)
    if (cls.kind !== 'payload') continue
    if (!components.has(cls.component)) continue
    if (!extracted.has(entry.name)) continue // 校验失败或未知
    let bucket = byComponent.get(cls.component)
    if (!bucket) { bucket = []; byComponent.set(cls.component, bucket) }
    bucket.push({ entry, cls, staged: extracted.get(entry.name) })
  }

  // ---- 1. sessions / projcache / attachments / extensions：逐文件 ----
  for (const id of ['sessions', 'projcache', 'attachments', 'extensions']) {
    const bucket = byComponent.get(id) || []
    const stat = { add: 0, overwrite: 0, skip: 0, errors: 0, bytes: 0, conflictSamples: (plan.components[id] && plan.components[id].conflicts) || [] }
    for (const f of bucket) {
      let dest
      try { dest = destForComponent(layout, f.cls) } catch { stat.skip += 1; continue }
      const exists = await pathExists(dest)
      if (exists && mode === 'merge') { stat.skip += 1; continue }
      try {
        const res = await commitFile(f.staged, dest)
        if (res.action === 'created') stat.add += 1
        else stat.overwrite += 1
        stat.bytes += f.entry.uncompressed
        if (res.backupPath) report.backups.push(res.backupPath)
      } catch (err) {
        stat.errors += 1
        pushCapped(report.errors, `${id}/${f.cls.rel}：${String((err && err.message) || err)}`)
      }
    }
    report.components[id] = stat
    if (stat.add + stat.overwrite > 0) report.needsRestart = true
  }

  // ---- 2. workspaces：合并 / 覆盖 workspace.json ----
  if (components.has('workspaces') && byComponent.has('workspaces')) {
    const entry = (byComponent.get('workspaces')).find((f) => f.cls.special === 'workspaceJson')
    const stat = { action: 'skipped', added: 0, updated: 0, kept: 0, total: 0 }
    if (entry) {
      try {
        const backupRaw = JSON.parse(await fs.promises.readFile(entry.staged, 'utf8'))
        if (mode === 'replace') {
          const localRaw = await readJsonIfExists(layout.p.workspaceJson)
          if (localRaw) {
            const bak = layout.p.workspaceJson + '.bak-dshbackup-' + timestampSlug()
            await fs.promises.copyFile(layout.p.workspaceJson, bak)
            report.backups.push(bak)
          }
          await atomicWriteJson(layout.p.workspaceJson, backupRaw)
          stat.action = 'replaced'
          stat.total = Object.keys((backupRaw && backupRaw.tables && backupRaw.tables.workspaces) || {}).length
        } else {
          const localRaw = await readJsonIfExists(layout.p.workspaceJson)
          const merged = mergeWorkspaceRegistries(localRaw, backupRaw)
          await atomicWriteJson(layout.p.workspaceJson, merged.result)
          stat.action = 'merged'
          stat.added = merged.added
          stat.updated = merged.updated
          stat.kept = merged.kept
          stat.total = Object.keys(merged.result.tables.workspaces).length
        }
        report.needsRestart = true
      } catch (err) {
        stat.action = 'error'
        pushCapped(report.errors, 'workspace.json：' + String((err && err.message) || err))
      }
    }
    report.components.workspaces = stat
  }

  // ---- 3. settings：仅覆盖模式（脱敏备份自动回填本机真实密钥） ----
  if (components.has('settings') && byComponent.has('settings')) {
    const entry = (byComponent.get('settings')).find((f) => f.cls.rel === 'settings.yaml')
    const stat = { action: 'skippedMergeMode', secretsRestored: 0, secretsMissing: [] }
    if (entry) {
      if (mode === 'replace') {
        try {
          let stagedFile = entry.staged
          const backupText = await fs.promises.readFile(entry.staged, 'utf8')
          if (backupText.includes(REDACT_MARKER)) {
            // 备份是脱敏的：标记处用本机现值回填；本机没有的保留标记并提示重填
            const localText = await fs.promises.readFile(layout.p.settingsYaml, 'utf8').catch(() => null)
            const merged = mergeRedactedSettings(backupText, localText)
            stagedFile = entry.staged + '.unredacted'
            await fs.promises.writeFile(stagedFile, merged.text, 'utf8')
            stat.secretsRestored = merged.restored.length
            stat.secretsMissing = merged.missing
            if (merged.missing.length > 0) {
              pushCapped(report.warnings, `settings.yaml 有 ${merged.missing.length} 处密钥在本机没有现值，恢复后需手动重填：${merged.missing.slice(0, 5).join('、')}`)
            }
          }
          const res = await commitFile(stagedFile, layout.p.settingsYaml)
          stat.action = 'replaced'
          if (res.backupPath) report.backups.push(res.backupPath)
          report.needsRestart = true
        } catch (err) {
          stat.action = 'error'
          pushCapped(report.errors, 'settings.yaml：' + String((err && err.message) || err))
        }
      }
    } else {
      stat.action = 'notInBackup'
    }
    report.components.settings = stat
  }

  // ---- 3.5 credentials：仅覆盖模式；解密失败绝不动本机文件 ----
  if (components.has('credentials') && byComponent.has('credentials')) {
    const f = byComponent.get('credentials')[0]
    const stat = { action: 'skippedMergeMode', applied: 0 }
    if (!f) {
      stat.action = 'notInBackup'
    } else if (mode !== 'replace') {
      stat.action = 'skippedMergeMode'
    } else if (!hasPassphrase(credentialsPassphrase)) {
      // 关键安全边界：没有密码时宁可什么都不做，也不能把本机凭据换成一个打不开的密文，
      // 更不能退化成明文写回。
      stat.action = 'skippedNoPassphrase'
      pushCapped(report.warnings, '凭据组件已跳过：未提供解密密码。本机 .credentials.yaml 未改动。')
    } else {
      try {
        // 先解密 + 校验 sha256（decryptCredentials 内部做），全部通过才碰本机文件
        const plain = decryptCredentials(await fs.promises.readFile(f.staged), credentialsPassphrase)
        const stagedPlain = f.staged + '.plain'
        await fs.promises.writeFile(stagedPlain, plain, { mode: 0o600 })
        const res = await commitFile(stagedPlain, layout.p.credentialsYaml)
        stat.action = 'replaced'
        stat.applied = 1
        stat.bytes = plain.length
        if (res.backupPath) report.backups.push(res.backupPath)
        // harness 自己按 0600 管理这个文件；恢复后保持收紧（Windows 上是无害 no-op）
        await fs.promises.chmod(layout.p.credentialsYaml, 0o600).catch(() => {})
        report.needsRestart = true
      } catch (err) {
        stat.action = 'error'
        pushCapped(report.errors, '凭据库 .credentials.yaml：' + String((err && err.message) || err))
      }
    }
    report.components.credentials = stat
  }

  // ---- 4. profile：patch 配置按模式还原；插件清单/生成物只补缺 ----
  // 只补缺会把用户的 cordis.patch.yml 永久挡在门外：换机后 DSH 启动时已经用
  // 空模板 `[]` 建过这个文件，于是「已存在」被误判成「本机有配置」。判定逻辑
  // 与 planImport 共用 shouldRestoreProfileEntry，保证预检和执行一致。
  if (components.has('profile') && byComponent.has('profile')) {
    const stat = { restored: [], kept: [] }
    let changed = false
    for (const f of byComponent.get('profile')) {
      if (!isKnownProfileEntry(f.cls)) continue
      const label = profileEntryLabel(f.cls)
      const dest = destForComponent(layout, f.cls)
      const exists = await pathExists(dest)
      const localEmptyPatch = exists && isProfilePatchEntry(f.cls) ? await isEmptyPatchFile(dest) : false
      if (!shouldRestoreProfileEntry({ cls: f.cls, exists, mode, localEmptyPatch })) {
        stat.kept.push(label)
        if (isProfilePatchEntry(f.cls) && exists) {
          pushCapped(report.warnings, `${label}：本机已有非空配置，保留本机版本 —— 备份中的这份未还原（如需强制还原请用「覆盖」模式）`)
        }
        continue
      }
      try {
        await commitFile(f.staged, dest)
        stat.restored.push(label)
        changed = true
      } catch (err) {
        pushCapped(report.errors, `profile/${label}：` + String((err && err.message) || err))
      }
    }
    report.components.profile = stat
    // patch 层是启动时加载的：还原后必须重载（重启 dsh）才生效。
    if (changed) report.needsRestart = true
  }

  // ---- 5. mnemon：最关键，放最后并单独报告 ----
  if (components.has('mnemon') && byComponent.has('mnemon')) {
    try {
      report.mnemon = await applyMnemon(reader, { layout, mode, bucket: byComponent.get('mnemon'), manifest, stagingRoots })
      if (report.mnemon.applied > 0) report.needsRestart = true
    } catch (err) {
      pushCapped(report.errors, 'mnemon：' + String((err && err.message) || err))
      report.mnemon = { applied: 0, error: String((err && err.message) || err) }
    }
  }

  report.applied = Object.values(report.components).reduce((n, s) => {
    return n + (s.add || 0) + (s.overwrite || 0) + (s.applied || 0) + (s.restored ? s.restored.length : 0)
  }, 0) + (report.mnemon ? report.mnemon.applied : 0)

  report.durationMs = Date.now() - started
  report.ok = report.errors.length === 0
  return report
}

/** mnemon 组件执行：覆盖 = 全量还原；合并 = 官方 Pack 语义。 */
async function applyMnemon(reader, { layout, mode, bucket, manifest, stagingRoots }) {
  const root = layout.mnemonRoot
  const report = { applied: 0, memoriesAdded: 0, memoriesTotal: null, documentsAdded: 0, documentsRenamed: 0, documentsSkipped: 0, bodiesAdded: 0, bodiesKept: 0, dbReplaced: 0, projections: null, notes: [], errors: [] }
  if (bucket.length === 0) {
    report.note = '备份中没有 mnemon 数据'
    return report
  }

  const files = [] // { rel, staged, entry, cls }
  const parsed = { memories: null, index: null, bodies: null }
  const metaStaged = new Map() // rel → staged（replace 模式下这三个 JSON 也要原样还原）
  for (const f of bucket) {
    const rel = f.cls.rel
    if (rel === 'runtime/memories.json') { metaStaged.set(rel, f.staged); try { parsed.memories = JSON.parse(await fs.promises.readFile(f.staged, 'utf8')) } catch { /* 计划阶段已报 */ } ; continue }
    if (rel === 'documents/index.json') { metaStaged.set(rel, f.staged); try { parsed.index = JSON.parse(await fs.promises.readFile(f.staged, 'utf8')) } catch { /* ignore */ } ; continue }
    if (rel === 'data/.dsh-memory-bodies.json') { metaStaged.set(rel, f.staged); try { parsed.bodies = JSON.parse(await fs.promises.readFile(f.staged, 'utf8')) } catch { /* ignore */ } ; continue }
    files.push({ rel, staged: f.staged, entry: f.entry, cls: f.cls })
  }

  // ---- 校验（覆盖与合并都需要）：index 与文件一一对应 ----
  if (parsed.index && Array.isArray(parsed.index.documents)) {
    for (const d of parsed.index.documents) {
      if (!d || !d.filename) continue
      const statusDir = d.status === 'archived' ? 'archived' : 'active'
      const rel = 'documents/' + statusDir + '/' + d.filename
      const staged = files.find((x) => x.rel === rel)
      if (!staged) {
        report.errors.push(`备份 documents/index.json 引用的文件缺失：${rel}`)
      }
    }
  }
  if (report.errors.length > 0 && mode === 'replace') {
    throw new Error('备份 mnemon 数据不完整，已中止覆盖：' + report.errors[0])
  }

  if (mode === 'replace') {
    // ---- 全量还原：runtime / documents / data（+state）逐文件替换 ----
    // 三个 JSON 元文件（memories / index / bodies）在合并模式下用于合并，
    // 在覆盖模式下同样要按备份原样落盘。
    for (const [rel, staged] of metaStaged) {
      try {
        await commitFile(staged, destForComponent(layout, { component: 'mnemon', rel }))
        report.applied += 1
      } catch (err) {
        report.errors.push(`${rel}：${String((err && err.message) || err)}`)
      }
    }
    for (const f of files) {
      let dest
      try { dest = destForComponent(layout, f.cls) } catch { continue }
      // SQLite 库走安全替换（先清 -wal/-shm）
      const dbMatch = /^data\/([^/]+)\/mnemon\.db$/.exec(f.rel)
      try {
        if (dbMatch) {
          await commitSqliteDb(f.staged, dest)
          report.dbReplaced += 1
        } else {
          const res = await commitFile(f.staged, dest)
          if (res.backupPath) { /* bak 路径汇总在 report.backups 之外，mnemon 里记录数量即可 */ }
        }
        report.applied += 1
      } catch (err) {
        report.errors.push(`${f.rel}：${String((err && err.message) || err)}`)
      }
    }
    report.notes.push('覆盖模式：MEMORY.md / USER.md 等投影文件已按备份原样还原，mnemon 上下文注入与备份时一致')
    return report
  }

  // ---- 合并模式 ----
  // 1) memories.json：按 target+content 去重合并；投影 md 保留本机版本（下次写入自动重投影）
  if (parsed.memories) {
    const memPath = path.join(root, 'runtime', 'memories.json')
    const localMem = await readJsonIfExists(memPath)
    const merged = mergeMemoriesJson(localMem, parsed.memories)
    if (merged.added > 0) {
      await atomicWriteJson(memPath, merged.json)
      report.memoriesAdded = merged.added
      report.memoriesTotal = merged.total
      report.applied += merged.added
      report.notes.push(`已并入 ${merged.added} 条热记忆；MEMORY.md / USER.md 保留本机投影，mnemon 下次记忆写入时自动同步`)
    }
  }

  // 2) documents：官方语义合并
  if (parsed.index && Array.isArray(parsed.index.documents)) {
    const localIndex = await readJsonIfExists(path.join(root, 'documents', 'index.json'))
    const merged = mergeDocumentsIndex(localIndex, parsed.index)
    report.documentsAdded = merged.added
    report.documentsRenamed = merged.renamed
    report.documentsSkipped = merged.skipped
    if (merged.added > 0) {
      const byFilename = new Map(files.map((f) => [path.posix.basename(f.rel), f]))
      for (const op of merged.ops) {
        const src = byFilename.get(op.from)
        if (!src) { report.errors.push(`文档文件缺失：${op.from}`); continue }
        const statusDir = op.entry.status === 'archived' ? 'archived' : 'active'
        const destDir = path.join(root, 'documents', statusDir)
        const dest = path.join(destDir, op.to)
        try {
          if (op.kind === 'rename') {
            // 同 id 异内容 → 新 id 新文件名：把暂存文件改名到暂存区新名，再提交
            const stagedNew = src.staged + '.as-' + op.to
            await fs.promises.copyFile(src.staged, stagedNew)
            await commitFile(stagedNew, dest)
          } else {
            await commitFile(src.staged, dest)
          }
          report.applied += 1
        } catch (err) {
          report.errors.push(`文档 ${op.from}：${String((err && err.message) || err)}`)
        }
      }
      await atomicWriteJson(path.join(root, 'documents', 'index.json'), merged.index)
    }
  }

  // 3) data：bodies 登记表合并 + 新 body 的 db 整目录导入（已有 body 一律保留本机）
  if (parsed.bodies && Array.isArray(parsed.bodies.bodies)) {
    const bodiesPath = path.join(root, 'data', '.dsh-memory-bodies.json')
    const localBodies = await readJsonIfExists(bodiesPath)
    const localList = (localBodies && Array.isArray(localBodies.bodies)) ? localBodies.bodies : []
    const localIds = new Set(localList.map((b) => b && b.id).filter(Boolean))
    const toAdd = parsed.bodies.bodies.filter((b) => b && b.id && !localIds.has(b.id))
    if (toAdd.length > 0) {
      const mergedBodies = { version: Math.max(Number((localBodies && localBodies.version) || 1), Number(parsed.bodies.version) || 1), bodies: localList.concat(toAdd) }
      for (const f of files) {
        const m = /^data\/([^/]+)\/mnemon\.db$/.exec(f.rel)
        if (!m) continue
        const bodyId = m[1]
        if (!toAdd.some((b) => b.id === bodyId)) continue
        const dest = path.join(root, 'data', bodyId, 'mnemon.db')
        try {
          await fs.promises.mkdir(path.dirname(dest), { recursive: true })
          const res = await commitFile(f.staged, dest)
          if (res.backupPath) { /* ignore */ }
          report.bodiesAdded += 1
          report.applied += 1
        } catch (err) {
          report.errors.push(`记忆体 ${bodyId}：${String((err && err.message) || err)}`)
        }
      }
      try { await atomicWriteJson(bodiesPath, mergedBodies) } catch (err) {
        report.errors.push('.dsh-memory-bodies.json：' + String((err && err.message) || err))
      }
    } else {
      report.bodiesKept = parsed.bodies.bodies.length
    }
  }

  // 4) state（provider 凭据）：仅本机缺失时导入
  for (const f of files) {
    if (!f.rel.startsWith('state/')) continue
    const dest = path.join(root, f.rel)
    if (await pathExists(dest)) continue
    try {
      await commitFile(f.staged, dest)
      report.applied += 1
    } catch (err) {
      report.errors.push(`${f.rel}：${String((err && err.message) || err)}`)
    }
  }

  return report
}

/** SQLite 库安全替换：先清本机 -wal/-shm（失败即中止，库未动），再换库，最后补 wal/shm。 */
async function commitSqliteDb(stagedDb, destDb) {
  const wal = destDb + '-wal'
  const shm = destDb + '-shm'
  const stagedWal = stagedDb + '-wal'
  const stagedShm = stagedDb + '-shm'
  // 1) 清本机 WAL（若 mnemon 正持有句柄，这里会 EPERM → 明确报错让用户重启后重试）
  await safeDelete(wal)
  await safeDelete(shm)
  // 2) 换库（带 .bak 回滚）
  await commitFile(stagedDb, destDb)
  // 3) 备份侧带了 wal/shm 就一并放回（正常冷备份不会有）
  if (await pathExists(stagedWal)) await renameWithRetry(stagedWal, wal)
  if (await pathExists(stagedShm)) await renameWithRetry(stagedShm, shm)
}

// ---------------------------------------------------------------------------
// 暂存/落盘清理
// ---------------------------------------------------------------------------

export async function cleanupStale(layout, maxAgeMs = 3600_000) {
  const roots = [path.join(layout.dshHome, '.dsh-backup-staging'), path.join(layout.mnemonRoot, '.dsh-backup-staging')]
  const now = Date.now()
  for (const root of roots) {
    let items
    try { items = await fs.promises.readdir(root, { withFileTypes: true }) } catch { continue }
    for (const item of items) {
      const m = /dsh-backup-staging-(\d+)-/.exec(item.name)
      if (!m) continue
      if (now - Number(m[1]) < maxAgeMs) continue
      await fs.promises.rm(path.join(root, item.name), { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ===========================================================================
// v0.2.0 新增：凭据脱敏、会话体检、共享打包、磁盘备份轮换
// （设计参考 xiaoyuyu6420/dsh-backup：凭据脱敏 / 自动备份轮换 / 会话 doctor /
//   救援通道；实现按本插件的组件化 ZIP 架构重写）
// ===========================================================================

// ---------------------------------------------------------------------------
// 凭据脱敏（settings.yaml）
//
// 导出时把「疑似密钥」的标量值替换为 REDACT_MARKER；导入（覆盖模式）时，
// 本机同名 key 有真实值的用本机值回填，本机没有的保留标记并提示重填。
// 纯行级处理，不引入 YAML 依赖：settings.yaml 的结构就是缩进映射/列表。
// ---------------------------------------------------------------------------

export const REDACT_MARKER = '__DSHBACKUP_REDACTED__'

const SECRET_KEY_RE = /(?:^|[-_.\s])(?:password|passwd|token|secret|api[-_]?key|apikey|access[-_]?key|credential(?:s)?|private[-_]?key|client[-_]?secret|auth)(?:$|[-_.\s])/i

function lastKeySegment(dottedPath) {
  const segs = String(dottedPath).split('.')
  return segs[segs.length - 1] || ''
}

/** key 路径的末段是否疑似密钥（camelCase 先归一化：githubToken → github-Token） */
function isSecretKey(dottedPath) {
  const norm = lastKeySegment(dottedPath).replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  return SECRET_KEY_RE.test(norm)
}

/** 标量值是否值得脱敏（空/布尔/数字/已是标记的不动） */
function isRedactableValue(value) {
  const v = String(value).trim()
  if (!v) return false
  if (v === REDACT_MARKER) return false
  if (/^(null|true|false|~|''|""|\[\]|\{\})$/i.test(v)) return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return false
  // 引号字符串也算（去引号后非空即可）
  return true
}

/**
 * 对 settings.yaml 文本做行级脱敏。
 * 返回 { text, paths: [脱敏的 key 路径] }。
 */
export function redactYamlSecrets(text) {
  const lines = String(text).split(/\r?\n/)
  const paths = []
  // 缩进栈 → 当前点分路径
  const stack = [] // { indent, key }
  function pathOf(indent, key) {
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack.length > 0 ? stack[stack.length - 1].path + '.' : ''
    return parent + key
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || /^\s*(#|$)/.test(line)) continue
    const indent = line.match(/^(\s*)/)[1].replace(/\t/g, '  ').length
    // 匹配 "key: value"（value 非空；列表项 "- xxx" 不在此列）
    const m = /^(\s*)([^#:\s][^:]*?)\s*:\s+(.*)$/.exec(line)
    if (!m) {
      // "key:"（嵌套容器）入栈
      const container = /^(\s*)([^#:\s][^:]*?)\s*:\s*$/.exec(line)
      if (container) {
        const key = container[2].replace(/^["']|["']$/g, '')
        stack.push({ indent, key, path: pathOf(indent, key) })
      }
      continue
    }
    const key = m[2].replace(/^["']|["']$/g, '')
    const dotted = pathOf(indent, key)
    stack.push({ indent, key, path: dotted })
    if (isSecretKey(dotted) && isRedactableValue(m[3])) {
      lines[i] = m[1] + m[2] + ': ' + REDACT_MARKER
      paths.push(dotted)
    }
  }
  return { text: lines.join('\n'), paths }
}

/**
 * 从缩进行流提取 标量叶子路径 → 原始行文本 的映射（用于回填）。
 * 同名路径后出现者覆盖（YAML map 语义近似）。
 */
function scalarLines(text) {
  const out = new Map()
  const stack = []
  const lines = String(text).split(/\r?\n/)
  for (const line of lines) {
    if (!line || /^\s*(#|$)/.test(line)) continue
    const indent = line.match(/^(\s*)/)[1].replace(/\t/g, '  ').length
    const m = /^(\s*)([^#:\s][^:]*?)\s*:\s+(.*)$/.exec(line)
    if (!m) {
      const container = /^(\s*)([^#:\s][^:]*?)\s*:\s*$/.exec(line)
      if (container) {
        const key = container[2].replace(/^["']|["']$/g, '')
        stack.push({ indent, path: pathOfScalar(stack, indent, key) })
      }
      continue
    }
    const key = m[2].replace(/^["']|["']$/g, '')
    const dotted = pathOfScalar(stack, indent, key)
    stack.push({ indent, path: dotted })
    out.set(dotted, line)
  }
  return out

  function pathOfScalar(stk, indent, key) {
    while (stk.length > 0 && stk[stk.length - 1].indent >= indent) stk.pop()
    const parent = stk.length > 0 ? stk[stk.length - 1].path + '.' : ''
    return parent + key
  }
}

/**
 * 覆盖导入 settings.yaml 时回填被脱敏的值：
 * 备份里值为 REDACT_MARKER 的行，用本机同路径行的真实值替换；
 * 本机没有对应值时保留标记，并在 missing 中报告。
 * 返回 { text, restored, missing: [路径] }。
 */
export function mergeRedactedSettings(backupText, localText) {
  const local = localText ? scalarLines(localText) : new Map()
  const lines = String(backupText).split(/\r?\n/)
  const restored = []
  const missing = []
  const stack = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || /^\s*(#|$)/.test(line)) continue
    const indent = line.match(/^(\s*)/)[1].replace(/\t/g, '  ').length
    const m = /^(\s*)([^#:\s][^:]*?)\s*:\s+(.*)$/.exec(line)
    if (!m) {
      const container = /^(\s*)([^#:\s][^:]*?)\s*:\s*$/.exec(line)
      if (container) {
        const key = container[2].replace(/^["']|["']$/g, '')
        stack.push({ indent, path: pathOfM(stack, indent, key) })
      }
      continue
    }
    const key = m[2].replace(/^["']|["']$/g, '')
    const dotted = pathOfM(stack, indent, key)
    stack.push({ indent, path: dotted })
    if (m[3].trim() === REDACT_MARKER) {
      const localLine = local.get(dotted)
      const localValue = localLine && /^(\s*)([^#:\s][^:]*?)\s*:\s+(.*)$/.exec(localLine)
      if (localValue && localValue[3].trim() && localValue[3].trim() !== REDACT_MARKER) {
        lines[i] = m[1] + m[2] + ': ' + localValue[3].trim()
        restored.push(dotted)
      } else {
        missing.push(dotted)
      }
    }
  }
  return { text: lines.join('\n'), restored, missing }

  function pathOfM(stk, indent, key) {
    while (stk.length > 0 && stk[stk.length - 1].indent >= indent) stk.pop()
    const parent = stk.length > 0 ? stk[stk.length - 1].path + '.' : ''
    return parent + key
  }
}

// ---------------------------------------------------------------------------
// 会话体检（doctor）：只读扫描，报告损坏会话；不做修复、不跳过备份
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 扫描 sessions/ 与归档目录的会话文件健康度。
 * 返回 { total, healthy, corrupt: [{ session, file, reason }], skipped: n }
 */
export async function doctorScan(layout) {
  const report = { total: 0, healthy: 0, corrupt: [], skipped: 0 }
  const roots = [
    { root: layout.p.sessions, label: 'sessions' },
    { root: layout.p.archive, label: 'archive' },
  ]
  for (const { root } of roots) {
    let keys
    try { keys = await fs.promises.readdir(root, { withFileTypes: true }) } catch { continue }
    for (const keyEntry of keys) {
      if (!keyEntry.isDirectory()) continue
      const keyDir = path.join(root, keyEntry.name)
      let sess
      try { sess = await fs.promises.readdir(keyDir, { withFileTypes: true }) } catch { continue }
      for (const s of sess) {
        if (!s.isDirectory()) continue
        report.total += 1
        const dir = path.join(keyDir, s.name)
        const verdict = await checkSessionDir(dir)
        if (verdict.ok) report.healthy += 1
        else report.corrupt.push({ session: s.name, project: keyEntry.name, file: verdict.file, reason: verdict.reason })
      }
    }
  }
  return report
}

async function checkSessionDir(dir) {
  let files
  try { files = await fs.promises.readdir(dir) } catch (err) {
    return { ok: false, file: null, reason: '目录不可读：' + String((err && err.message) || err) }
  }
  // 找格式代际文件：session.vN.jsonl[.zstd] / session.jsonl[.zstd]
  const candidates = files.filter((f) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f)).sort()
  if (candidates.length === 0) {
    const any = files.filter((f) => !f.startsWith('.'))
    return any.length === 0
      ? { ok: false, file: null, reason: '目录为空（无会话文件）' }
      : { ok: true, file: any[0], reason: null } // 未知文件布局不当损坏处理
  }
  const file = candidates[candidates.length - 1]
  const abs = path.join(dir, file)
  let stat
  try { stat = await fs.promises.stat(abs) } catch (err) {
    return { ok: false, file, reason: '文件不可读：' + String((err && err.message) || err) }
  }
  if (stat.size === 0) return { ok: false, file, reason: '文件为 0 字节' }
  const head = Buffer.alloc(8)
  const fh = await fs.promises.open(abs, 'r').catch(() => null)
  if (!fh) return { ok: false, file, reason: '文件打开失败' }
  try {
    await fh.read(head, 0, 8, 0)
  } finally {
    await fh.close().catch(() => {})
  }
  if (file.endsWith('.zstd')) {
    if (!head.subarray(0, 4).equals(ZSTD_MAGIC)) {
      return { ok: false, file, reason: 'zstd 魔数不符（文件头损坏或不是 zstd）' }
    }
    return { ok: true, file, reason: null } // 压缩流不再解包（会话内容字节级哲学）
  }
  // 明文 JSONL：首字节必须是 JSON 对象起始
  if (head[0] !== 0x7b) {
    return { ok: false, file, reason: '首字节不是 JSON 对象起始（{）' }
  }
  return { ok: true, file, reason: null }
}

// ---------------------------------------------------------------------------
// 共享打包：HTTP 导出、磁盘备份、测试共用同一条路径
// ---------------------------------------------------------------------------

const SETTINGS_ZIP_PATH = 'payload/settings/settings.yaml'

/**
 * 组装备份 ZIP 并写入 sink。
 * @param opts { components: Set<string>, redactSecrets: boolean, credentialsPassphrase: string, onChunk(chunk) }
 * @returns { manifest, fileCount, bytes, redacted: {count, paths}, credentials: {requested, included, reason} }
 */
export async function assembleBackupZip(layout, components, opts = {}) {
  const { ZipWriter } = await import('./zip.js')
  const redactSecrets = opts.redactSecrets !== false
  const passphrase = typeof opts.credentialsPassphrase === 'string' ? opts.credentialsPassphrase : ''
  const { files: collected, componentStats } = await collectExportFiles(layout, components)

  // 凭据组件强制加密。没有密码就整条不导出——绝不允许「密码没设 → 退化成明文」。
  const files = []
  const notices = []
  const credentials = { requested: components.has('credentials'), included: false, reason: null }
  for (const f of collected) {
    if (f.zipPath !== CREDENTIALS_ZIP_PATH) { files.push(f); continue }
    if (!hasPassphrase(passphrase)) {
      credentials.reason = 'no-passphrase'
      if (componentStats.credentials) {
        componentStats.credentials.skipped = 'no-passphrase'
        componentStats.credentials.files = 0
        componentStats.credentials.bytes = 0
      }
      notices.push('凭据组件已跳过：未设置凭据加密密码。明文凭据永不进入备份包。')
      continue
    }
    credentials.included = true
    if (componentStats.credentials) componentStats.credentials.encrypted = 'aes-256-gcm/scrypt'
    files.push(f)
  }
  // 请求了凭据组件但本机没有该文件
  if (credentials.requested && !credentials.included && !credentials.reason) {
    credentials.reason = 'absent'
    notices.push('凭据组件已跳过：本机没有 .credentials.yaml。')
  }

  const manifest = await buildManifest(layout, [...components], componentStats)
  if (notices.length > 0) manifest.notices = notices

  const sink = opts.sink
  let bytes = 0
  const tee = opts.onChunk
  const wrappingSink = tee
    ? { async write(chunk) { bytes += chunk.length; tee(chunk); await sink.write(chunk) } }
    : { async write(chunk) { bytes += chunk.length; await sink.write(chunk) } }

  const writer = new ZipWriter(wrappingSink)
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  const h = crypto.createHash('sha256')
  h.update(manifestBytes)
  const checksums = { algorithm: 'zip-entry-crc32 + manifest-sha256', manifest: h.digest('hex'), files: {} }
  for (const f of files) checksums.files[f.zipPath] = { size: f.size }

  const redacted = { count: 0, paths: [] }
  await writer.addBuffer('manifest.json', manifestBytes)
  for (const f of files) {
    if (redactSecrets && f.zipPath === SETTINGS_ZIP_PATH) {
      const raw = await fs.promises.readFile(f.abs, 'utf8')
      const r = redactYamlSecrets(raw)
      redacted.count = r.paths.length
      redacted.paths = r.paths
      if (r.paths.length > 0) {
        await writer.addBuffer('redaction.json', Buffer.from(JSON.stringify({ file: SETTINGS_ZIP_PATH, paths: r.paths }, null, 2), 'utf8'))
      }
      const buf = Buffer.from(r.text, 'utf8')
      // checksums 记录的必须是包内实际内容的大小(脱敏后与磁盘原始文件不同)
      checksums.files[SETTINGS_ZIP_PATH] = { size: buf.length, redacted: true }
      await writer.addBuffer(SETTINGS_ZIP_PATH, buf)
      continue
    }
    if (f.zipPath === CREDENTIALS_ZIP_PATH) {
      const raw = await fs.promises.readFile(f.abs)
      const buf = encryptCredentials(raw, passphrase)
      // 包内是密文，checksums 必须记密文长度（与磁盘上的明文长度不同）
      checksums.files[CREDENTIALS_ZIP_PATH] = { size: buf.length, encrypted: true }
      await writer.addBuffer(CREDENTIALS_ZIP_PATH, buf)
      continue
    }
    await writer.addFromFile(f.abs, f.zipPath, { mtime: f.mtime })
  }
  await writer.addBuffer('checksums.json', Buffer.from(JSON.stringify(checksums, null, 2), 'utf8'))
  await writer.close()
  return { manifest, fileCount: files.length, bytes, redacted, credentials }
}

// ---------------------------------------------------------------------------
// 磁盘备份目录：列表 / sha256 sidecar / 轮换 / 自动备份状态
// ---------------------------------------------------------------------------

export const BACKUP_NAME_RE = /^dsh-backup-\d{8}-\d{6}\.zip$/

/** 列出目录里的备份（新→旧），附带 sidecar 信息。 */
export async function listBackups(dir) {
  let items
  try { items = await fs.promises.readdir(dir) } catch { return [] }
  const out = []
  for (const name of items) {
    if (!BACKUP_NAME_RE.test(name)) continue
    const abs = path.join(dir, name)
    const stat = await fs.promises.stat(abs).catch(() => null)
    if (!stat) continue
    out.push({
      name,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      hasSha256: fs.existsSync(abs + '.sha256'),
    })
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
  return out
}

/** 轮换：按 mtime 新→旧保留 keep 份，多余删除（连同 .sha256）。返回删除名单。 */
export async function rotateBackups(dir, keep) {
  const n = Math.floor(Number(keep))
  if (!Number.isFinite(n) || n <= 0) return []
  const all = await listBackups(dir)
  const removed = []
  for (const b of all.slice(n)) {
    await fs.promises.unlink(path.join(dir, b.name)).catch(() => {})
    await fs.promises.unlink(path.join(dir, b.name + '.sha256')).catch(() => {})
    removed.push(b.name)
  }
  return removed
}

/** 自动备份状态文件（放在备份目录；不进备份、不参与轮换）。 */
export async function readAutoState(dir) {
  try {
    const raw = JSON.parse(await fs.promises.readFile(path.join(dir, '.dsh-backup-auto.json'), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

export async function writeAutoState(dir, state) {
  await fs.promises.mkdir(dir, { recursive: true })
  await atomicWriteJson(path.join(dir, '.dsh-backup-auto.json'), state)
}

/** 时间戳文件名：dsh-backup-20260926-153040.zip（本地时区）。 */
export function backupFileName(d = new Date()) {
  const pad = (x) => String(x).padStart(2, '0')
  return 'dsh-backup-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.zip'
}

// ---------------------------------------------------------------------------
// v0.3.0:AI 恢复助理(跨版本导入善后)
// ---------------------------------------------------------------------------

/** 从运行中的 dsh bin.js 路径反推宿主版本(argv[1] = <root>/node_modules/@deepseek-ai/dsh/lib/bin.js)。 */
export function hostVersion() {
  try {
    const argv1 = String(process.argv[1] || '')
    if (argv1) {
      const pkgPath = path.resolve(path.dirname(argv1), '..', 'package.json')
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg && pkg.name === '@deepseek-ai/dsh' && pkg.version) return String(pkg.version)
    }
  } catch { /* ignore */ }
  return null
}

function fmtBriefList(items, fmt) {
  const list = (items || []).slice(0, 8)
  if (!list.length) return '无'
  return list.map((x) => '  - ' + (fmt ? fmt(x) : String(x))).join('\n') + ((items || []).length > 8 ? `\n  - …共 ${items.length} 项` : '')
}

/**
 * 生成「AI 恢复助理」任务书。
 * @returns { prompt, crossVersion }
 */
export function buildAssistantBrief({ report, manifest, localDshVersion }) {
  const r = report || {}
  const c = r.components || {}
  const m = manifest || {}
  const backupVer = (m.producer && m.producer.dshVersion) || '未知'
  const local = localDshVersion || '未知'
  const crossVersion = backupVer !== '未知' && local !== '未知' && backupVer !== local

  const lines = []
  lines.push('你是 DeepSeek Harness 的「恢复助理」。dsh-backup 插件刚完成一次导入恢复' + (crossVersion ? '(备份来自不同版本的 dsh,属于跨版本恢复)' : '') + '。请核查恢复结果,做最小必要的修复,最后给出简明报告。')
  lines.push('')
  lines.push('## 背景')
  lines.push('- 备份创建:' + (m.createdAt || '未知') + '(dsh ' + backupVer + ' / dsh-backup ' + ((m.producer && m.producer.pluginVersion) || '?') + ')')
  lines.push('- 本机:dsh ' + local)
  lines.push('- 导入模式:' + (r.mode || '?') + ' · 写入 ' + (r.applied ?? 0) + ' 项 · 耗时 ' + Math.round((r.durationMs || 0) / 100) / 10 + 's')
  lines.push('')
  lines.push('## 恢复摘要')
  const sc = c.sessions || {}
  lines.push('- 会话:新增 ' + (sc.add || 0) + ' / 覆盖 ' + (sc.overwrite || 0) + ' / 保留本机 ' + (sc.skip || 0))
  const wc = c.workspaces || {}
  lines.push('- 工作区注册表:' + (wc.action || '?') + (wc.action === 'merged' ? '(新增 ' + wc.added + ' / 更新 ' + wc.updated + ' / 保留 ' + wc.kept + ')' : ''))
  const st = c.settings || {}
  lines.push('- settings.yaml:' + (st.action || '?') + (st.secretsRestored ? '(回填本机密钥 ' + st.secretsRestored + ' 处)' : '') + ((st.secretsMissing && st.secretsMissing.length) ? '(需手动重填 ' + st.secretsMissing.length + ' 处)' : ''))
  const mn = r.mnemon || {}
  lines.push('- mnemon:写入 ' + (mn.applied ?? 0) + ' 项' + (mn.memoriesAdded ? '、并入热记忆 ' + mn.memoriesAdded + ' 条' : '') + (mn.documentsAdded ? '、新增文档 ' + mn.documentsAdded + ' 篇' : ''))
  const pc = c.profile || {}
  if (pc.restored && pc.restored.length) lines.push('- profile 补缺:' + pc.restored.join(', '))
  lines.push('')
  lines.push('## 需要关注')
  lines.push('错误(' + ((r.errors || []).length) + '):')
  lines.push(fmtBriefList(r.errors))
  lines.push('警告(' + ((r.warnings || []).length) + '):')
  lines.push(fmtBriefList(r.warnings))
  lines.push('本机缺失的插件(不要自行安装,交给用户):')
  lines.push(fmtBriefList(r.missingPlugins, (p) => p && p.name))
  lines.push('')
  lines.push('## 你的任务(按顺序执行)')
  lines.push('1. 只读核查 mnemon 数据一致性(根目录通常是 ~/.mnemon,若不存在则跳过):')
  lines.push('   - runtime/memories.json 是否可解析为 JSON 且含 entries 数组')
  lines.push('   - documents/index.json 里登记的每个 relativePath 文件是否存在')
  lines.push('   - data/.dsh-memory-bodies.json 登记的每个 bodyId 是否有对应 data/<bodyId>/mnemon.db')
  lines.push('2. 抽查 2-3 个还原的会话目录(~/.dsh/sessions/<项目>/<会话ID>/):目录存在、会话文件非空')
  lines.push('3. 检查 ~/.dsh/storages/workspace.json:JSON 可解析、global.workspaceIds 与 tables.workspaces 的键一致')
  lines.push('4. 仅当问题「明确安全且可逆」时才动手修复(例如从同名 .bak-dshbackup-*.bak / .bak-rescue-* 恢复一个损坏文件);任何拿不准的情况只报告、不动手;绝不删除任何数据')
  lines.push('5. 缺失插件不要安装,在报告里建议用户到「插件管理」安装')
  lines.push('6. 最终报告三栏:发现的问题 / 已修复(附文件路径) / 建议用户手动处理')
  lines.push('')
  lines.push('(本任务由 dsh-backup 插件发起;用户可在插件设置中关闭跨版本自动助理)')

  return { prompt: lines.join('\n'), crossVersion }
}
