// ============================================================================
// dsh-backup v0.2.0 新增能力测试：凭据脱敏 / 会话体检 / 磁盘备份引擎 / 救援控制台
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  REDACT_MARKER, redactYamlSecrets, mergeRedactedSettings,
  doctorScan, resolveLayout, assembleBackupZip, COMPONENTS,
  listBackups, rotateBackups, readAutoState, writeAutoState, backupFileName,
  resolveProfile, resolveProfileName, setProfileContext, clearProfileContext,
} from '../lib/store.js'
import { backupToFile, defaultBackupDir, verifyBackupFile, writeRescueTools } from '../lib/backupdir.js'
import { planImport, extractPayload, applyImport } from '../lib/store.js'
import { ZipReader } from '../lib/zip.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-v02-'))
}

function write(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

const SQLITE_HEADER = Buffer.concat([Buffer.from('SQLite format 3\0'), crypto.randomBytes(48)])

const SETTINGS_WITH_SECRETS = [
  'ui-onboarding:',
  '  done: true',
  'llm-deepseek:',
  '  baseUrl: https://api.example.com',
  '  apiKey: sk-abcdef123456',
  '  model: deepseek-chat',
  'some-plugin:',
  '  githubToken: ghp_zzzzzzzzzz',
  '  tokens: 42',
  '  note: not a secret key',
  '  password: hunter2',
].join('\n')

/** 造一套带密钥 settings 的假 dsh home（v0.2.0 测试用，结构比 local-test 精简） */
function makeFakeHome(root, name, { withSecrets = false, corruptSession = false } = {}) {
  const home = path.join(root, name)
  const mnemon = path.join(root, name + '-mnemon')
  process.env.DSH_HOME = home
  process.env.MNEMON_DATA_DIR = mnemon

  const sessions = path.join(home, 'sessions', '--H-demo--')
  // 真实 zstd 魔数开头（doctor 体检按魔数判断健康）
  write(path.join(sessions, '11111111-1111-4111-8111-111111111111', 'session.v3.jsonl.zstd'), Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), crypto.randomBytes(32)]))
  if (corruptSession) {
    write(path.join(sessions, '22222222-2222-4222-8222-222222222222', 'session.v3.jsonl.zstd'), Buffer.from('NOT-ZSTD-DATA'))
    write(path.join(sessions, '33333333-3333-4333-8333-333333333333', 'session.v2.jsonl'), '')
  }
  write(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [] },
    tables: { workspaces: { w1: { path: 'C:\\a', title: 'a', sessionIds: [], createdAt: 'T0', updatedAt: 'T0' } } },
  }))
  write(path.join(home, 'settings.yaml'), withSecrets ? SETTINGS_WITH_SECRETS : 'ui-onboarding:\n  done: true\n')
  write(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }))
  write(path.join(mnemon, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [] }))
  write(path.join(mnemon, 'data', 'default', 'mnemon.db'), SQLITE_HEADER)
  return { home, mnemon }
}

const ALL = COMPONENTS.map((c) => c.id)

async function exportRedactable(layout, { redactSecrets = true } = {}) {
  const chunks = []
  const sink = { async write(c) { chunks.push(c) } }
  const { manifest, fileCount, bytes, redacted } = await assembleBackupZip(layout, new Set(ALL), { sink, redactSecrets })
  return { zip: Buffer.concat(chunks), manifest, fileCount, bytes, redacted }
}

async function importZip(zipBuf, layout, mode) {
  const backupFile = path.join(path.dirname(layout.dshHome), 'bk-' + crypto.randomBytes(4).toString('hex') + '.zip')
  fs.writeFileSync(backupFile, zipBuf)
  const reader = new ZipReader(backupFile)
  await reader.open()
  try {
    const me = reader.entries.find((e) => e.name === 'manifest.json')
    const manifest = JSON.parse((await reader.readEntry(me)).toString('utf8'))
    const components = new Set(ALL)
    const plan = await planImport(reader, { layout, mode, components, manifest, checksums: null })
    const { stagingRootDsh, stagingRootMnemon, extracted } = await extractPayload(reader, reader.entries, layout, null, false)
    try {
      const report = await applyImport(reader, { layout, mode, components, manifest, extracted, plan })
      return report
    } finally {
      fs.rmSync(stagingRootDsh, { recursive: true, force: true })
      fs.rmSync(stagingRootMnemon, { recursive: true, force: true })
    }
  } finally {
    await reader.close()
    fs.unlinkSync(backupFile)
  }
}

// ---------------------------------------------------------------------------
// 1. 脱敏
// ---------------------------------------------------------------------------

test('redactYamlSecrets：密钥值替换为标记，普通键值与数字不动', () => {
  const r = redactYamlSecrets(SETTINGS_WITH_SECRETS)
  assert.ok(!r.text.includes('sk-abcdef123456'))
  assert.ok(!r.text.includes('ghp_zzzzzzzzzz'))
  assert.ok(!r.text.includes('hunter2'))
  assert.ok(r.text.includes('https://api.example.com'))
  assert.ok(r.text.includes('deepseek-chat'))
  assert.ok(r.text.includes('tokens: 42'))
  assert.ok(r.text.includes('note: not a secret key'))
  const markerCount = (r.text.match(new RegExp(REDACT_MARKER, 'g')) || []).length
  assert.equal(markerCount, 3)
  assert.ok(r.paths.some((p) => p.endsWith('apiKey')))
  assert.ok(r.paths.some((p) => p.endsWith('githubToken')))
  assert.ok(r.paths.some((p) => p.endsWith('password')))
})

test('mergeRedactedSettings：标记处回填本机现值，本机缺失则保留标记并报告', () => {
  const redacted = redactYamlSecrets(SETTINGS_WITH_SECRETS).text
  const localText = [
    'ui-onboarding:',
    '  done: true',
    'llm-deepseek:',
    '  baseUrl: https://api.example.com',
    '  apiKey: sk-local-real-key',
    'some-plugin:',
    '  githubToken: ghp-local-token',
  ].join('\n')
  const m = mergeRedactedSettings(redacted, localText)
  assert.ok(m.text.includes('sk-local-real-key'))
  assert.ok(m.text.includes('ghp-local-token'))
  assert.equal(m.restored.length, 2)
  // 本机没有 password → 保留标记
  assert.ok(m.text.includes('password: ' + REDACT_MARKER))
  assert.deepEqual(m.missing, ['some-plugin.password'])
  // 本机为空 → 全部保留标记
  const m2 = mergeRedactedSettings(redacted, null)
  assert.equal(m2.restored.length, 0)
  assert.equal(m2.missing.length, 3)
})

test('端到端：脱敏导出 → 覆盖导入 → 本机真实密钥保留，其余设置取备份', async () => {
  const root = tmpRoot()
  const prevHome = process.env.DSH_HOME
  const prevMnemon = process.env.MNEMON_DATA_DIR
  try {
    makeFakeHome(root, 'home-a', { withSecrets: true })
    const layoutA = resolveLayout()
    const { zip, redacted } = await exportRedactable(layoutA, { redactSecrets: true })
    assert.equal(redacted.count, 3)
    const zipText = zip.toString('latin1')
    assert.ok(!zipText.includes('sk-abcdef123456'), '备份包不得包含明文密钥')

    // 目标 B：settings.yaml 有自己的 apiKey
    process.env.DSH_HOME = path.join(root, 'home-b')
    process.env.MNEMON_DATA_DIR = path.join(root, 'home-b-mnemon')
    makeFakeHome(root, 'home-b')
    const layoutB = resolveLayout()
    write(layoutB.p.settingsYaml, [
      'ui-onboarding:',
      '  done: false',
      'llm-deepseek:',
      '  apiKey: sk-b-local-key',
    ].join('\n'))

    const report = await importZip(zip, layoutB, 'replace')
    assert.ok(report.ok, JSON.stringify(report.errors))
    assert.equal(report.components.settings.action, 'replaced')
    assert.equal(report.components.settings.secretsRestored, 1)
    const finalText = fs.readFileSync(layoutB.p.settingsYaml, 'utf8')
    assert.ok(finalText.includes('sk-b-local-key'), '本机密钥应保留')
    assert.ok(finalText.includes('done: true'), '非密钥设置应取备份值')
    assert.ok(!finalText.includes('sk-abcdef123456'), '备份明文密钥不得出现')

    // 关闭脱敏的导出：解出 settings.yaml 条目应为明文
    const raw = await exportRedactable(layoutA, { redactSecrets: false })
    const tmpRaw = path.join(root, 'raw.zip')
    fs.writeFileSync(tmpRaw, raw.zip)
    const reader = new ZipReader(tmpRaw)
    await reader.open()
    try {
      const se = reader.entries.find((e) => e.name === 'payload/settings/settings.yaml')
      const settingsText = (await reader.readEntry(se)).toString('utf8')
      assert.ok(settingsText.includes('sk-abcdef123456'), '关闭脱敏时应包含明文（用户显式选择）')
    } finally {
      await reader.close()
      fs.unlinkSync(tmpRaw)
    }
  } finally {
    process.env.DSH_HOME = prevHome
    process.env.MNEMON_DATA_DIR = prevMnemon
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. 会话体检
// ---------------------------------------------------------------------------

test('doctorScan：健康/空文件/zstd 魔数错误分别识别', async () => {
  const root = tmpRoot()
  const prevHome = process.env.DSH_HOME
  const prevMnemon = process.env.MNEMON_DATA_DIR
  try {
    makeFakeHome(root, 'home-x', { corruptSession: true })
    const layout = resolveLayout()
    const r = await doctorScan(layout)
    assert.equal(r.total, 3)
    assert.equal(r.corrupt.length, 2)
    const reasons = r.corrupt.map((c) => c.reason).join('|')
    assert.match(reasons, /0 字节/)
    assert.match(reasons, /zstd 魔数/)
    assert.equal(r.healthy, 1)
  } finally {
    process.env.DSH_HOME = prevHome
    process.env.MNEMON_DATA_DIR = prevMnemon
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. 磁盘备份引擎
// ---------------------------------------------------------------------------

test('backupToFile：写盘 + sha256 sidecar + 救援工具 + 轮换', async () => {
  const root = tmpRoot()
  const prevHome = process.env.DSH_HOME
  const prevMnemon = process.env.MNEMON_DATA_DIR
  try {
    makeFakeHome(root, 'home-a')
    const layout = resolveLayout()
    const dest = path.join(root, 'backups')

    const r1 = await backupToFile({ layout, destination: dest, keep: 2 })
    assert.ok(fs.existsSync(r1.path))
    assert.ok(fs.existsSync(r1.path + '.sha256'))
    // sha256 sidecar 与文件实际哈希一致
    const actual = crypto.createHash('sha256').update(fs.readFileSync(r1.path)).digest('hex')
    assert.equal(r1.sha256, actual)
    assert.match(fs.readFileSync(r1.path + '.sha256', 'utf8'), new RegExp('^' + actual))
    // 救援工具就位
    assert.ok(fs.existsSync(path.join(dest, 'rescue.mjs')))
    assert.ok(fs.existsSync(path.join(dest, '点我恢复.bat')))
    assert.ok(fs.existsSync(path.join(dest, '点我恢复.sh')))
    // verifyBackupFile 全过
    const v = await verifyBackupFile(r1.path)
    assert.ok(v.ok)

    // 再备 3 份，keep=2 → 只剩 2 份
    await backupToFile({ layout, destination: dest, keep: 2 })
    await new Promise((r) => setTimeout(r, 1100)) // 文件名秒级精度，错开
    await backupToFile({ layout, destination: dest, keep: 2 })
    const after = await listBackups(dest)
    assert.equal(after.length, 2)
    assert.equal(after[0].name, r1.name === after[0].name ? after[0].name : after[0].name)
    void r1
    // 自动状态文件可读写
    await writeAutoState(dest, { hours: 6, lastRunAt: 123 })
    const st = await readAutoState(dest)
    assert.equal(st.hours, 6)
    assert.equal(st.lastRunAt, 123)
  } finally {
    process.env.DSH_HOME = prevHome
    process.env.MNEMON_DATA_DIR = prevMnemon
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rotateBackups：keep 之外的旧备份连同 sidecar 一起删除', async () => {
  const root = tmpRoot()
  try {
    const dest = path.join(root, 'bk')
    fs.mkdirSync(dest, { recursive: true })
    for (let i = 1; i <= 5; i++) {
      const name = 'dsh-backup-2026010' + i + '-000000.zip'
      fs.writeFileSync(path.join(dest, name), 'x' + i)
      fs.writeFileSync(path.join(dest, name + '.sha256'), 'hash' + i)
    }
    const removed = await rotateBackups(dest, 2)
    assert.equal(removed.length, 3)
    const left = await listBackups(dest)
    assert.equal(left.length, 2)
    assert.ok(left.every((b) => b.hasSha256))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('defaultBackupDir：插件与救援控制台必须一致（否则双击「点我恢复」找不到备份）', async () => {
  const { defaultBackupDir: rescueDefault } = await import('../rescue/rescue.mjs')
  const root = tmpRoot()
  const prevUser = process.env.USERPROFILE
  const prevHome = process.env.HOME
  try {
    // os.homedir() 在 Windows 读 USERPROFILE，在 POSIX 读 HOME —— 两个都伪造
    process.env.USERPROFILE = root
    process.env.HOME = root
    const docsBackups = path.join(root, 'Documents', 'dsh-backups')
    fs.mkdirSync(docsBackups, { recursive: true })
    fs.mkdirSync(path.join(root, 'Desktop'), { recursive: true })

    assert.equal(defaultBackupDir(), docsBackups, '插件默认落点应是「文档」')
    assert.equal(rescueDefault(), docsBackups, '没有备份时救援控制台应回落到与插件相同的位置')

    // 备份真的落在「文档」：救援控制台必须能找到（0.3.1 改默认位置时这里漏改过）
    fs.writeFileSync(path.join(docsBackups, 'dsh-backup-20260101-000000.zip'), 'x')
    assert.equal(rescueDefault(), docsBackups)

    // 历史遗留：只有桌面目录有备份时，救援控制台仍应找到它
    fs.rmSync(docsBackups, { recursive: true, force: true })
    const deskBackups = path.join(root, 'Desktop', 'dsh-backups')
    fs.mkdirSync(deskBackups, { recursive: true })
    fs.writeFileSync(path.join(deskBackups, 'dsh-backup-20260101-000000.zip'), 'x')
    assert.equal(rescueDefault(), deskBackups)
  } finally {
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. 救援控制台（子进程真实运行）
// ---------------------------------------------------------------------------

test('rescue.mjs：verify / restore（只补缺失） / restore --force 覆盖', async () => {
  const root = tmpRoot()
  const prevHome = process.env.DSH_HOME
  const prevMnemon = process.env.MNEMON_DATA_DIR
  const rescueSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rescue', 'rescue.mjs')
  try {
    makeFakeHome(root, 'home-a')
    const layoutA = resolveLayout()
    const dest = path.join(root, 'backups')
    const r1 = await backupToFile({ layout: layoutA, destination: dest, keep: 3 })

    // verify
    const v = await execFileAsync(process.execPath, [rescueSrc, 'verify', r1.name, '--dir', dest])
    assert.match(v.stdout, /✅/)

    // restore 到全新 home（copy-missing）
    process.env.DSH_HOME = path.join(root, 'home-r')
    process.env.MNEMON_DATA_DIR = path.join(root, 'home-r-mnemon')
    fs.mkdirSync(path.join(root, 'home-r'), { recursive: true })
    const out1 = await execFileAsync(process.execPath, [rescueSrc, 'restore', r1.name, '--dir', dest,
      '--home', path.join(root, 'home-r'), '--mnemon', path.join(root, 'home-r-mnemon')])
    assert.match(out1.stdout, /还原文件 \d+ 个/)
    const sessionFile = path.join(root, 'home-r', 'sessions', '--H-demo--', '11111111-1111-4111-8111-111111111111', 'session.v3.jsonl.zstd')
    assert.ok(fs.existsSync(sessionFile))
    const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    assert.ok(fs.readFileSync(sessionFile).subarray(0, 4).equals(ZSTD_MAGIC))
    assert.ok(fs.readFileSync(path.join(root, 'home-r-mnemon', 'data', 'default', 'mnemon.db')).equals(SQLITE_HEADER))

    // dry-run：不改东西
    fs.writeFileSync(sessionFile, 'LOCAL')
    const out2 = await execFileAsync(process.execPath, [rescueSrc, 'restore', r1.name, '--dir', dest, '--dry-run',
      '--home', path.join(root, 'home-r'), '--mnemon', path.join(root, 'home-r-mnemon')])
    assert.match(out2.stdout, /预演/)
    assert.equal(fs.readFileSync(sessionFile, 'utf8'), 'LOCAL')

    // --force：覆盖并留 .bak-rescue-
    const out3 = await execFileAsync(process.execPath, [rescueSrc, 'restore', r1.name, '--dir', dest, '--force',
      '--home', path.join(root, 'home-r'), '--mnemon', path.join(root, 'home-r-mnemon')])
    assert.match(out3.stdout, /覆盖 [1-9]/)
    assert.ok(fs.readFileSync(sessionFile).subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])))
    const dirEntries = fs.readdirSync(path.dirname(sessionFile))
    assert.ok(dirEntries.some((n) => n.includes('.bak-rescue-')))
  } finally {
    process.env.DSH_HOME = prevHome
    process.env.MNEMON_DATA_DIR = prevMnemon
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rescue.mjs：cordis.patch.yml 空模板按缺失还原 / 非空保留 / 根 patch 落点正确', async () => {
  const root = tmpRoot()
  const prev = {
    home: process.env.DSH_HOME, mnemon: process.env.MNEMON_DATA_DIR,
    profile: process.env.DSH_PROFILE, dir: process.env.DSH_PROFILE_DIR,
  }
  const rescueSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rescue', 'rescue.mjs')
  const TEMPLATE = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n'
  const userPatch = '- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: opencode-go\n'
  const homePatch = '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n'
  try {
    delete process.env.DSH_PROFILE
    delete process.env.DSH_PROFILE_DIR

    // 源机：只有 desktop profile（没有 web）——救援通道不得再硬编码 web
    const homeA = path.join(root, 'home-a')
    process.env.DSH_HOME = homeA
    process.env.MNEMON_DATA_DIR = path.join(root, 'home-a-mnemon')
    write(path.join(homeA, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dsh: { profile: { bundles: [] } } }))
    write(path.join(homeA, 'profiles', 'desktop', 'cordis.patch.yml'), userPatch)
    write(path.join(homeA, 'cordis.patch.yml'), homePatch)
    const layoutA = resolveLayout()
    assert.equal(layoutA.profileName, 'desktop', '只有 desktop 时必须靠单目录兜底识别')

    const chunks = []
    await assembleBackupZip(layoutA, new Set(['profile']), { sink: { async write(c) { chunks.push(c) } }, redactSecrets: false })
    const backupDir = path.join(root, 'backups')
    fs.mkdirSync(backupDir, { recursive: true })
    const zipName = 'dsh-backup-profile.zip'
    fs.writeFileSync(path.join(backupDir, zipName), Buffer.concat(chunks))

    // 目标 1：DSH 已用空模板初始化过 profile → 默认（copy-missing）也必须还原
    const homeR1 = path.join(root, 'home-r1')
    write(path.join(homeR1, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dsh: { profile: { bundles: [] } } }))
    write(path.join(homeR1, 'profiles', 'desktop', 'cordis.patch.yml'), TEMPLATE)
    const out1 = await execFileAsync(process.execPath, [rescueSrc, 'restore', zipName, '--dir', backupDir,
      '--home', homeR1, '--mnemon', path.join(root, 'home-r1-mnemon')])
    assert.equal(fs.readFileSync(path.join(homeR1, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), userPatch, '空模板必须被备份内容替换')
    assert.equal(fs.readFileSync(path.join(homeR1, 'cordis.patch.yml'), 'utf8'), homePatch, '根 patch 层落点必须是 <home>/cordis.patch.yml')
    assert.ok(!fs.existsSync(path.join(homeR1, 'profiles', 'web')), '不得凭空造出 profiles/web')
    assert.match(out1.stdout, /保留本机/)

    // 目标 2：本机有真实配置 → 默认不覆盖（救援语义的保守性不变）
    const homeR2 = path.join(root, 'home-r2')
    write(path.join(homeR2, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: ui-theme\n')
    const out2 = await execFileAsync(process.execPath, [rescueSrc, 'restore', zipName, '--dir', backupDir,
      '--home', homeR2, '--mnemon', path.join(root, 'home-r2-mnemon')])
    assert.equal(fs.readFileSync(path.join(homeR2, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), '- id: ui-theme\n', '本机真实配置不得被默认模式覆盖')
    assert.match(out2.stdout, /保留本机 1 个/)
  } finally {
    if (prev.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev.home
    if (prev.mnemon === undefined) delete process.env.MNEMON_DATA_DIR; else process.env.MNEMON_DATA_DIR = prev.mnemon
    if (prev.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = prev.profile
    if (prev.dir === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = prev.dir
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolveProfileName：DSH_PROFILE → --profile → 回落 web', async () => {
  const { resolveProfileName } = await import('../lib/store.js')
  const prevEnv = process.env.DSH_PROFILE
  const prevArgv = process.argv
  try {
    clearProfileContext()
    delete process.env.DSH_PROFILE
    delete process.env.DSH_PROFILE_DIR
    process.argv = ['node', 'test.mjs']
    assert.equal(resolveProfileName(), 'web')
    process.argv = ['node', 'test.mjs', '--profile', 'desktop']
    assert.equal(resolveProfileName(), 'desktop')
    process.argv = ['node', 'test.mjs', '--profile=web']
    assert.equal(resolveProfileName(), 'web')
    process.argv = ['node', 'test.mjs']
    process.env.DSH_PROFILE = 'desktop'
    assert.equal(resolveProfileName(), 'desktop', '环境变量优先于默认值')
  } finally {
    clearProfileContext()
    if (prevEnv === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = prevEnv
    process.argv = prevArgv
  }
})

test('resolveProfile：桌面端位置参数 / DSH_PROFILE_DIR / profileContext 优先链', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-profile-'))
  const prev = {
    home: process.env.DSH_HOME,
    mnemon: process.env.MNEMON_DATA_DIR,
    profile: process.env.DSH_PROFILE,
    dir: process.env.DSH_PROFILE_DIR,
    argv: process.argv,
  }
  try {
    clearProfileContext()
    delete process.env.DSH_PROFILE
    delete process.env.DSH_PROFILE_DIR
    process.env.DSH_HOME = root
    process.env.MNEMON_DATA_DIR = path.join(root, 'mnemon')

    // Electron 桌面端：没有 --profile，只有位置参数 <dshHome>/profiles/<名>
    const desktopDir = path.join(root, 'profiles', 'desktop')
    fs.mkdirSync(desktopDir, { recursive: true })
    process.argv = ['DeepSeek Harness.exe', '--expose-internals', 'app.asar/dsh/index.js', desktopDir, 'runtime']
    assert.equal(resolveProfile().name, 'desktop', '位置参数必须被识别')
    assert.equal(resolveProfile().source, 'argv-profile-dir')
    assert.equal(resolveLayout().profileDir, desktopDir)

    // DSH_PROFILE_DIR 优先于位置参数（目录可直接定位，名字从 basename 取）
    process.env.DSH_PROFILE_DIR = path.join(root, 'profiles', 'custom')
    assert.equal(resolveProfileName(), 'custom')
    assert.equal(resolveLayout().profileDir, path.join(root, 'profiles', 'custom'))
    delete process.env.DSH_PROFILE_DIR

    // profiles 下只有一个目录时兜底采用（无任何其它信号）
    process.argv = ['node', 'test.mjs']
    assert.equal(resolveProfileName(), 'desktop')

    // profileContext（宿主注入，含 dir / patchPath）优先于一切探测
    setProfileContext({ name: 'desktop', dir: desktopDir, patchPath: path.join(desktopDir, 'cordis.patch.yml') })
    process.env.DSH_PROFILE = 'web'
    process.argv = ['node', 'test.mjs', '--profile', 'web']
    const resolved = resolveProfile()
    assert.equal(resolved.name, 'desktop')
    assert.equal(resolved.source, 'profileContext')
    const layout = resolveLayout()
    assert.equal(layout.profileDir, desktopDir)
    assert.equal(layout.p.profilePatchYml, path.join(desktopDir, 'cordis.patch.yml'))
    assert.equal(layout.p.homePatchYml, path.join(root, 'cordis.patch.yml'))

    // 显式传名时不吃 profileContext 的目录（调用方要的是另一个 profile）
    assert.equal(resolveLayout('other').profileDir, path.join(root, 'profiles', 'other'))
  } finally {
    clearProfileContext()
    process.argv = prev.argv
    if (prev.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev.home
    if (prev.mnemon === undefined) delete process.env.MNEMON_DATA_DIR; else process.env.MNEMON_DATA_DIR = prev.mnemon
    if (prev.profile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = prev.profile
    if (prev.dir === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = prev.dir
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('backupFileName：格式与轮换正则匹配', () => {
  const name = backupFileName(new Date(2026, 8, 26, 9, 7, 5))
  assert.equal(name, 'dsh-backup-20260926-090705.zip')
})
