// ============================================================================
// dsh-backup —— 发布前版本号一致性校验（AGENTS.md 发布清单第 1 条）
//
// 三处版本号必须同步，否则会出现「npm 上是 0.6.0，插件自报 0.5.0」这种
// 极难排查的错位：
//   package.json            version
//   lib/index.js            PLUGIN_VERSION
//   lib/store.js            PLUGIN_VERSION_TAG
//
// 用法：
//   node scripts/verify-version.mjs            # 只校验三处一致
//   node scripts/verify-version.mjs v0.6.0     # 额外校验与 git tag 一致
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
const pick = (rel, re) => {
  const m = re.exec(read(rel))
  if (!m) throw new Error(`${rel} 里找不到版本号（期望匹配 ${re}）`)
  return m[1]
}

const versions = {
  'package.json': JSON.parse(read('package.json')).version,
  'lib/index.js': pick('lib/index.js', /PLUGIN_VERSION\s*=\s*'([^']+)'/),
  'lib/store.js': pick('lib/store.js', /PLUGIN_VERSION_TAG\s*=\s*'([^']+)'/),
}

// package-lock.json 也带版本号；AGENTS 的三处清单没提它，但漏改会让
// npm 在 CI 里重写 lockfile，diff 里凭空多出一堆噪声。
if (fs.existsSync(path.join(repoRoot, 'package-lock.json'))) {
  versions['package-lock.json'] = JSON.parse(read('package-lock.json')).version
}

const unique = new Set(Object.values(versions))
if (unique.size !== 1) {
  console.error('❌ 版本号不一致：')
  for (const [file, v] of Object.entries(versions)) console.error(`   ${file.padEnd(20)} ${v}`)
  process.exit(1)
}

const version = Object.values(versions)[0]
console.log(`✅ ${Object.keys(versions).length} 处版本号一致：${version}`)

const tagArg = process.argv[2]
if (tagArg) {
  const tag = String(tagArg).replace(/^v/, '')
  if (tag !== version) {
    console.error(`❌ git tag (${tag}) 与 package.json (${version}) 不一致`)
    process.exit(1)
  }
  console.log(`✅ git tag 与版本号一致：v${version}`)
}
