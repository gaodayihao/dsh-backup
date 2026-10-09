// ============================================================================
// dsh-backup v0.6.0 新能力测试：
//   1. 凭据加密容器（AES-256-GCM + scrypt）的往返与各种失败路径
//   2. 导出侧：无密码必须跳过凭据（绝不明文），有密码必须只落密文
//   3. 凭据与插件自身设置不得被 extensions 动态组件扫进备份
//   4. 导入侧：预检试开、合并跳过、覆盖恢复 + .bak、密码错不动本机文件
//   5. 救援控制台：dry-run 不落暂存、凭据可解密、无密码时跳过密文
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
  encryptCredentials, decryptCredentials, CredentialsCryptoError,
  CREDENTIALS_ZIP_PATH, CREDENTIALS_FORMAT,
} from '../lib/crypto.js'
import {
  assembleBackupZip, planImport, extractPayload, applyImport,
  resolveLayout, COMPONENTS, dynamicExtensionSources,
} from '../lib/store.js'
import { ZipReader } from '../lib/zip.js'
import { rescueRestore } from '../rescue/rescue.mjs'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-cred-'))
}

function write(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

const PASSPHRASE = 'correct horse battery staple'
const SECRET_BODY = [
  'version: 1',
  'records:',
  '  client-connection/browser-session:',
  '    kind: browser-session',
  '    payload:',
  '      version: 1',
  '      secret: SUPER-SECRET-COOKIE-SIGNING-KEY',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-do-not-leak-me-0123456789',
].join('\n')

/** 造一套最小假 dsh home：会话 + 凭据 + 插件设置 + 一个第三方插件数据目录。 */
function makeFakeHome(root, name, { credentials = SECRET_BODY, extensions = true } = {}) {
  const home = path.join(root, name)
  const mnemon = path.join(root, name + '-mnemon')
  process.env.DSH_HOME = home
  process.env.MNEMON_DATA_DIR = mnemon

  write(path.join(home, 'sessions', '--H-demo--', '11111111-1111-4111-8111-111111111111', 'session.v3.jsonl.zstd'),
    Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), crypto.randomBytes(32)]))
  write(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
    tables: { workspaces: {} },
  }))
  write(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } } }))
  if (credentials !== null) write(path.join(home, '.credentials.yaml'), credentials)
  // 插件自身设置：里面存着凭据加密密码与备份目录 —— 绝不能被扫进备份
  write(path.join(home, 'dsh-backup-settings.json'), JSON.stringify({ credentialsPassphrase: 'LOCAL-ONLY-PASSPHRASE', destination: 'E:\\dsh-backups' }))
  if (extensions) write(path.join(home, 'task-board', 'ledger.json'), '{"local":"B"}')

  return { home, mnemon }
}

async function exportToBuffer(layout, componentIds, opts = {}) {
  const chunks = []
  const sink = { async write(c) { chunks.push(c) } }
  const result = await assembleBackupZip(layout, new Set(componentIds), { sink, ...opts })
  return { zip: Buffer.concat(chunks), ...result }
}

async function openZip(fileAbs) {
  const reader = new ZipReader(fileAbs)
  await reader.open()
  return reader
}

/** 写 zip 到磁盘并返回带 reader 的句柄（含自动清理）。 */
async function withZip(zipBuf, fn) {
  const dir = tmpRoot()
  const abs = path.join(dir, 'backup.zip')
  fs.writeFileSync(abs, zipBuf)
  const reader = await openZip(abs)
  try {
    return await fn(reader, abs)
  } finally {
    await reader.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function runImport(reader, layout, mode, componentIds, credentialsPassphrase) {
  const components = new Set(componentIds)
  const manifestEntry = reader.entries.find((e) => e.name === 'manifest.json')
  const manifest = JSON.parse((await reader.readEntry(manifestEntry)).toString('utf8'))
  const plan = await planImport(reader, { layout, mode, components, manifest, checksums: null, credentialsPassphrase })
  const { stagingRootDsh, stagingRootMnemon, extracted } = await extractPayload(reader, reader.entries, layout, null, false)
  let report
  try {
    report = await applyImport(reader, { layout, mode, components, manifest, extracted, plan, credentialsPassphrase })
  } finally {
    fs.rmSync(stagingRootDsh, { recursive: true, force: true })
    fs.rmSync(stagingRootMnemon, { recursive: true, force: true })
  }
  return { plan, report }
}

const ALL = COMPONENTS.map((c) => c.id)
const execFileAsync = promisify(execFile)
const RESCUE_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'rescue', 'rescue.mjs',
)

// ---------------------------------------------------------------------------
// 1. 加密容器本体
// ---------------------------------------------------------------------------

test('凭据容器：加密 → 解密字节级往返', () => {
  const plain = Buffer.from(SECRET_BODY, 'utf8')
  const env = encryptCredentials(plain, PASSPHRASE)
  assert.ok(Buffer.isBuffer(env))
  const parsed = JSON.parse(env.toString('utf8'))
  assert.equal(parsed.format, CREDENTIALS_FORMAT)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.kdf.name, 'scrypt')
  assert.equal(parsed.cipher.name, 'aes-256-gcm')
  assert.equal(parsed.plaintext.bytes, plain.length)
  // 明文绝不能出现在容器里
  assert.ok(!env.toString('utf8').includes('SUPER-SECRET-COOKIE-SIGNING-KEY'))
  assert.ok(!env.toString('utf8').includes('sk-do-not-leak-me'))
  assert.deepEqual(decryptCredentials(env, PASSPHRASE), plain)
})

test('凭据容器：每次加密的 salt/iv 都不同（同一明文两次结果不同）', () => {
  const plain = Buffer.from(SECRET_BODY, 'utf8')
  const a = JSON.parse(encryptCredentials(plain, PASSPHRASE).toString('utf8'))
  const b = JSON.parse(encryptCredentials(plain, PASSPHRASE).toString('utf8'))
  assert.notEqual(a.kdf.salt, b.kdf.salt)
  assert.notEqual(a.cipher.iv, b.cipher.iv)
  assert.notEqual(a.ciphertext, b.ciphertext)
})

test('凭据容器：密码错误抛可预期错误，且不返回半成品字节', () => {
  const env = encryptCredentials(Buffer.from(SECRET_BODY, 'utf8'), PASSPHRASE)
  assert.throws(() => decryptCredentials(env, 'wrong passphrase'), (err) => {
    assert.ok(err instanceof CredentialsCryptoError)
    assert.match(err.message, /密码不正确|GCM/)
    return true
  })
})

test('凭据容器：密文被改一个字节 → GCM 校验失败（不会解出坏数据）', () => {
  const env = JSON.parse(encryptCredentials(Buffer.from(SECRET_BODY, 'utf8'), PASSPHRASE).toString('utf8'))
  const ct = Buffer.from(env.ciphertext, 'base64')
  ct[0] = ct[0] ^ 0x01
  env.ciphertext = ct.toString('base64')
  assert.throws(() => decryptCredentials(Buffer.from(JSON.stringify(env), 'utf8'), PASSPHRASE), CredentialsCryptoError)
})

test('凭据容器：明文 sha256 对不上 → 拒绝返回', () => {
  const env = JSON.parse(encryptCredentials(Buffer.from(SECRET_BODY, 'utf8'), PASSPHRASE).toString('utf8'))
  env.plaintext.sha256 = 'f'.repeat(64)
  assert.throws(
    () => decryptCredentials(Buffer.from(JSON.stringify(env), 'utf8'), PASSPHRASE),
    /sha256/,
  )
})

test('凭据容器：KDF 参数炸弹被拒绝（不允许外部容器把 scrypt 内存推到上限外）', () => {
  const env = JSON.parse(encryptCredentials(Buffer.from(SECRET_BODY, 'utf8'), PASSPHRASE).toString('utf8'))
  env.kdf.N = 1 << 24
  assert.throws(
    () => decryptCredentials(Buffer.from(JSON.stringify(env), 'utf8'), PASSPHRASE),
    /KDF 参数超出/,
  )
})

test('凭据容器：空密码 / 非容器输入都被明确拒绝', () => {
  assert.throws(() => encryptCredentials(Buffer.from('x'), ''), /未提供凭据加密密码/)
  assert.throws(() => decryptCredentials(Buffer.from('not json'), PASSPHRASE), /不是合法 JSON/)
  assert.throws(() => decryptCredentials(Buffer.from('{"format":"other"}'), PASSPHRASE), /格式不符/)
})

// ---------------------------------------------------------------------------
// 2. 导出侧
// ---------------------------------------------------------------------------

test('导出：未设置密码时凭据组件被跳过，绝不落明文，且 manifest 里有提示', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'a')
    const layout = resolveLayout()
    const { zip, manifest, credentials } = await exportToBuffer(layout, ALL, { credentialsPassphrase: '' })

    await withZip(zip, async (reader) => {
      const names = reader.entries.map((e) => e.name)
      assert.ok(!names.includes(CREDENTIALS_ZIP_PATH), '没有密码时不应出现凭据条目')
      assert.ok(!names.some((n) => n.startsWith('payload/credentials/')), '不应有任何凭据 payload')
      // 明文也绝不能以别的名字漏出去
      for (const e of reader.entries) {
        if (e.name.endsWith('/')) continue
        const buf = await reader.readEntry(e)
        assert.ok(!buf.includes('SUPER-SECRET-COOKIE-SIGNING-KEY'), `明文泄漏在 ${e.name}`)
      }
    })

    assert.equal(credentials.requested, true)
    assert.equal(credentials.included, false)
    assert.equal(credentials.reason, 'no-passphrase')
    // 逐组件统计随 manifest 一起落包，跳过原因必须是可追溯的
    assert.equal(manifest.components.credentials.skipped, 'no-passphrase')
    assert.ok((manifest.notices || []).some((n) => /凭据/.test(n)), 'manifest 应记录跳过原因')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('导出：设置密码后凭据只以密文入包，checksums 记密文长度', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'a')
    const layout = resolveLayout()
    const { zip, credentials, manifest } = await exportToBuffer(layout, ALL, { credentialsPassphrase: PASSPHRASE })

    assert.equal(credentials.included, true)
    assert.equal(manifest.components.credentials.encrypted, 'aes-256-gcm/scrypt')
    assert.ok(!(manifest.notices || []).some((n) => /凭据/.test(n)))

    await withZip(zip, async (reader) => {
      const entry = reader.entries.find((e) => e.name === CREDENTIALS_ZIP_PATH)
      assert.ok(entry, '应有凭据条目')
      const buf = await reader.readEntry(entry)
      assert.ok(!buf.toString('utf8').includes('SUPER-SECRET-COOKIE-SIGNING-KEY'))
      assert.deepEqual(decryptCredentials(buf, PASSPHRASE).toString('utf8'), SECRET_BODY)

      const checksums = JSON.parse((await reader.readEntry(reader.entries.find((e) => e.name === 'checksums.json'))).toString('utf8'))
      assert.equal(checksums.files[CREDENTIALS_ZIP_PATH].encrypted, true)
      // 记的必须是密文长度，不是磁盘上明文的长度
      assert.equal(checksums.files[CREDENTIALS_ZIP_PATH].size, entry.uncompressed)
      assert.notEqual(checksums.files[CREDENTIALS_ZIP_PATH].size, Buffer.byteLength(SECRET_BODY))
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('导出：本机没有 .credentials.yaml 时报 absent，不是静默成功', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'a', { credentials: null })
    const layout = resolveLayout()
    const { credentials } = await exportToBuffer(layout, ALL, { credentialsPassphrase: PASSPHRASE })
    assert.equal(credentials.requested, true)
    assert.equal(credentials.included, false)
    assert.equal(credentials.reason, 'absent')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. 不得被 extensions 扫走
// ---------------------------------------------------------------------------

test('extensions 动态组件：不扫 .credentials.yaml，也不扫 dsh-backup-settings.json', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'a')
    const layout = resolveLayout()
    const names = dynamicExtensionSources(layout).map((s) => path.basename(s.abs))
    assert.ok(!names.includes('.credentials.yaml'), '.credentials.yaml 不得进 extensions')
    assert.ok(!names.includes('dsh-backup-settings.json'), 'dsh-backup-settings.json（存着密码）不得进 extensions')
    assert.ok(names.includes('task-board'), '正常第三方插件数据仍应被扫到')

    // 整包验证：即使勾选 extensions，也不允许出现这两个文件
    const { zip } = await exportToBuffer(layout, ALL, { credentialsPassphrase: PASSPHRASE })
    await withZip(zip, async (reader) => {
      const all = reader.entries.map((e) => e.name)
      assert.ok(!all.some((n) => n.includes('dsh-backup-settings.json')), '插件设置不应入包')
      const credEntries = all.filter((n) => n.includes('.credentials.yaml'))
      assert.deepEqual(credEntries, [CREDENTIALS_ZIP_PATH], '凭据只允许出现在加密路径')
      // 且那个路径上的内容必须是密文
      const buf = await reader.readEntry(reader.entries.find((e) => e.name === CREDENTIALS_ZIP_PATH))
      assert.ok(!buf.toString('utf8').includes('LOCAL-ONLY-PASSPHRASE'), '本机设置里的密码不得随凭据入包')
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. 导入侧
// ---------------------------------------------------------------------------

test('预检：凭据组件报告能否解密（三种情形）', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'src')
    const srcLayout = resolveLayout()
    const { zip } = await exportToBuffer(srcLayout, ALL, { credentialsPassphrase: PASSPHRASE })

    // (1) 给了正确密码
    await withZip(zip, async (reader) => {
      const manifest = JSON.parse((await reader.readEntry(reader.entries.find((e) => e.name === 'manifest.json'))).toString('utf8'))
      const plan = await planImport(reader, { layout: resolveLayout(), mode: 'replace', components: new Set(ALL), manifest, credentialsPassphrase: PASSPHRASE })
      assert.equal(plan.components.credentials.decryptable, true)
      assert.equal(plan.components.credentials.kdf, 'scrypt')
      assert.equal(plan.components.credentials.algorithm, 'aes-256-gcm')
      assert.equal(plan.components.credentials.action, 'replaced')
    })

    // (2) 密码错
    await withZip(zip, async (reader) => {
      const manifest = JSON.parse((await reader.readEntry(reader.entries.find((e) => e.name === 'manifest.json'))).toString('utf8'))
      const plan = await planImport(reader, { layout: resolveLayout(), mode: 'replace', components: new Set(ALL), manifest, credentialsPassphrase: 'nope' })
      assert.equal(plan.components.credentials.decryptable, false)
      assert.match(plan.components.credentials.decryptError, /密码不正确|GCM/)
      assert.ok(plan.warnings.some((w) => /凭据库/.test(w)), '应给出可见告警')
    })

    // (3) 没给密码
    await withZip(zip, async (reader) => {
      const manifest = JSON.parse((await reader.readEntry(reader.entries.find((e) => e.name === 'manifest.json'))).toString('utf8'))
      const plan = await planImport(reader, { layout: resolveLayout(), mode: 'replace', components: new Set(ALL), manifest, credentialsPassphrase: '' })
      assert.equal(plan.components.credentials.needsPassphrase, true)
      assert.equal(plan.components.credentials.decryptable, false)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('导入：合并模式跳过凭据（整文件替换语义），本机凭据不变', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'src')
    const { zip } = await exportToBuffer(resolveLayout(), ALL, { credentialsPassphrase: PASSPHRASE })

    makeFakeHome(root, 'dst', { credentials: 'version: 1\nrefs:\n  LOCAL: keep-me\n' })
    const dstLayout = resolveLayout()
    await withZip(zip, async (reader) => {
      const { report } = await runImport(reader, dstLayout, 'merge', ALL, PASSPHRASE)
      assert.equal(report.components.credentials.action, 'skippedMergeMode')
    })
    assert.equal(fs.readFileSync(path.join(dstLayout.dshHome, '.credentials.yaml'), 'utf8'), 'version: 1\nrefs:\n  LOCAL: keep-me\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('导入：覆盖模式解密恢复凭据，原文件留 .bak', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'src')
    const { zip } = await exportToBuffer(resolveLayout(), ALL, { credentialsPassphrase: PASSPHRASE })

    const localBody = 'version: 1\nrefs:\n  LOCAL: old-value\n'
    makeFakeHome(root, 'dst', { credentials: localBody })
    const dstLayout = resolveLayout()
    const credPath = path.join(dstLayout.dshHome, '.credentials.yaml')

    await withZip(zip, async (reader) => {
      const { report } = await runImport(reader, dstLayout, 'replace', ALL, PASSPHRASE)
      assert.equal(report.components.credentials.action, 'replaced')
      assert.equal(report.components.credentials.applied, 1)
      assert.equal(report.ok, true, JSON.stringify(report.errors))
    })

    assert.equal(fs.readFileSync(credPath, 'utf8'), SECRET_BODY)
    const baks = fs.readdirSync(dstLayout.dshHome).filter((f) => f.startsWith('.credentials.yaml.bak-dshbackup-'))
    assert.equal(baks.length, 1, '应留下一个 .bak')
    assert.equal(fs.readFileSync(path.join(dstLayout.dshHome, baks[0]), 'utf8'), localBody)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('导入：密码错误不碰本机凭据（报错但零改动）', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'src')
    const { zip } = await exportToBuffer(resolveLayout(), ALL, { credentialsPassphrase: PASSPHRASE })

    const localBody = 'version: 1\nrefs:\n  LOCAL: must-survive\n'
    makeFakeHome(root, 'dst', { credentials: localBody })
    const dstLayout = resolveLayout()
    const credPath = path.join(dstLayout.dshHome, '.credentials.yaml')

    await withZip(zip, async (reader) => {
      const { report } = await runImport(reader, dstLayout, 'replace', ALL, 'the-wrong-password')
      assert.equal(report.components.credentials.action, 'error')
      assert.ok(report.errors.some((e) => /凭据库/.test(e)))
      assert.equal(report.ok, false)
    })

    assert.equal(fs.readFileSync(credPath, 'utf8'), localBody, '本机凭据必须原封不动')
    assert.equal(fs.readdirSync(dstLayout.dshHome).filter((f) => f.includes('.credentials.yaml.bak-')).length, 0, '不应产生 .bak')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('导入：未提供密码时跳过凭据并给出可见告警，本机凭据不变', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'src')
    const { zip } = await exportToBuffer(resolveLayout(), ALL, { credentialsPassphrase: PASSPHRASE })

    const localBody = 'version: 1\nrefs:\n  LOCAL: untouched\n'
    makeFakeHome(root, 'dst', { credentials: localBody })
    const dstLayout = resolveLayout()

    await withZip(zip, async (reader) => {
      const { report } = await runImport(reader, dstLayout, 'replace', ALL, '')
      assert.equal(report.components.credentials.action, 'skippedNoPassphrase')
      assert.ok(report.warnings.some((w) => /凭据组件已跳过/.test(w)))
    })
    assert.equal(fs.readFileSync(path.join(dstLayout.dshHome, '.credentials.yaml'), 'utf8'), localBody)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. 救援控制台
// ---------------------------------------------------------------------------

test('救援：--dry-run 不落任何暂存字节（旧版会把整包解到暂存区却不清理）', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'src')
    const { zip } = await exportToBuffer(resolveLayout(), ALL, { credentialsPassphrase: PASSPHRASE })

    const targetHome = path.join(root, 'restore-home')
    fs.mkdirSync(targetHome, { recursive: true })
    const zipAbs = path.join(root, 'b.zip')
    fs.writeFileSync(zipAbs, zip)

    const r = await rescueRestore(zipAbs, { dryRun: true, home: targetHome, mnemonRoot: path.join(root, 'restore-mnemon') })
    assert.ok(r.plan.created.length > 0, '预演应报告将要还原的文件')
    assert.equal(fs.existsSync(path.join(targetHome, '.dsh-backup-staging')), false, '预演不得留下暂存目录')
    assert.equal(fs.existsSync(path.join(targetHome, '.credentials.yaml')), false, '预演不得写入任何文件')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('救援：给了密码则解密恢复凭据；不给密码则跳过密文（绝不把密文当凭据写入）', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'src')
    const { zip } = await exportToBuffer(resolveLayout(), ALL, { credentialsPassphrase: PASSPHRASE })
    const zipAbs = path.join(root, 'b.zip')
    fs.writeFileSync(zipAbs, zip)

    // (1) 没有密码 → 跳过，且文件不存在
    const homeA = path.join(root, 'home-no-pass')
    fs.mkdirSync(homeA, { recursive: true })
    const ra = await rescueRestore(zipAbs, { home: homeA, mnemonRoot: path.join(root, 'mn-a') })
    assert.equal(ra.plan.credentials.present, true)
    assert.equal(ra.plan.credentials.restored, false)
    assert.equal(ra.plan.credentials.reason, 'no-passphrase')
    assert.equal(fs.existsSync(path.join(homeA, '.credentials.yaml')), false)

    // (2) 密码错 → 跳过，且文件不存在（不能写出一个 dsh 读不了的凭据文件）
    const homeB = path.join(root, 'home-bad-pass')
    fs.mkdirSync(homeB, { recursive: true })
    const rb = await rescueRestore(zipAbs, { home: homeB, mnemonRoot: path.join(root, 'mn-b'), credentialsPassphrase: 'wrong' })
    assert.equal(rb.plan.credentials.restored, false)
    assert.match(rb.plan.credentials.reason, /密码不正确|GCM/)
    assert.equal(fs.existsSync(path.join(homeB, '.credentials.yaml')), false)

    // (3) 密码对 → 解出原始明文
    const homeC = path.join(root, 'home-ok')
    fs.mkdirSync(homeC, { recursive: true })
    const rc = await rescueRestore(zipAbs, { home: homeC, mnemonRoot: path.join(root, 'mn-c'), credentialsPassphrase: PASSPHRASE })
    assert.equal(rc.plan.credentials.restored, true)
    assert.equal(fs.readFileSync(path.join(homeC, '.credentials.yaml'), 'utf8'), SECRET_BODY)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('救援 CLI：credentials 子命令判定密码（命令行与环境变量两条通道，且不写文件）', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'src')
    const { zip } = await exportToBuffer(resolveLayout(), ALL, { credentialsPassphrase: PASSPHRASE })
    const zipAbs = path.join(root, 'b.zip')
    fs.writeFileSync(zipAbs, zip)

    const good = await execFileAsync(process.execPath, [RESCUE_SRC, 'credentials', zipAbs, '--passphrase', PASSPHRASE])
    assert.match(good.stdout, /✅/)

    const bad = await execFileAsync(process.execPath, [RESCUE_SRC, 'credentials', zipAbs, '--passphrase', 'nope'])
      .then(() => { throw new Error('密码错时应当以非零退出') }, (err) => err)
    assert.match(String(bad.stdout || ''), /❌/)

    const viaEnv = await execFileAsync(process.execPath, [RESCUE_SRC, 'credentials', zipAbs], {
      env: { ...process.env, DSH_BACKUP_CREDENTIALS_PASSPHRASE: PASSPHRASE },
    })
    assert.match(viaEnv.stdout, /✅/)

    // 只校验，不写任何文件
    assert.equal(fs.existsSync(path.join(root, '.credentials.yaml')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('救援 CLI：restore --passphrase 解出真实凭据', async () => {
  const root = tmpRoot()
  try {
    makeFakeHome(root, 'src')
    const { zip } = await exportToBuffer(resolveLayout(), ALL, { credentialsPassphrase: PASSPHRASE })
    const zipAbs = path.join(root, 'b.zip')
    fs.writeFileSync(zipAbs, zip)
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })

    const out = await execFileAsync(process.execPath, [RESCUE_SRC, 'restore', zipAbs, '--force',
      '--home', target, '--mnemon', path.join(root, 'mn'), '--passphrase', PASSPHRASE])
    assert.match(out.stdout, /凭据库 .credentials.yaml：已解密并恢复/)
    assert.equal(fs.readFileSync(path.join(target, '.credentials.yaml'), 'utf8'), SECRET_BODY)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
