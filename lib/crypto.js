// ============================================================================
// dsh-backup —— 凭据加密容器（零第三方依赖，只用 node:crypto）
//
// `$DSH_HOME/.credentials.yaml` 是「整文件皆为密钥」的文件（5 个 API key +
// client-connection 的 cookie 签名密钥），通用脱敏对它没有意义——脱敏是
// 逐行替换值，而这个文件里没有一行可以留在明文里。因此它单独走一条对称
// 加密通道，密码由用户提供，明文永不进入备份包。
//
// 包内落点：payload/credentials/.credentials.yaml.enc
//
// 容器格式（JSON，UTF-8）：
//   {
//     "format": "dsh-backup-credentials",
//     "version": 1,
//     "kdf":    { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "keylen": 32, "salt": "<b64>" },
//     "cipher": { "name": "aes-256-gcm", "iv": "<b64>", "tag": "<b64>" },
//     "plaintext": { "name": ".credentials.yaml", "bytes": 632, "sha256": "<hex>" },
//     "ciphertext": "<b64>"
//   }
//
// 设计要点：
//   - AES-256-GCM 提供完整性：容器被改一个字节，final() 就直接抛错，
//     不会出现「半解密」后覆盖本机凭据的事故。
//   - plaintext.sha256 让「解密是否正确」在覆盖本机文件之前就能被证明，
//     而不是覆盖完才发现密码错了。
//   - 密码缺失时调用方必须跳过该组件，绝不退化成明文备份（见 store.js）。
// ============================================================================

import crypto from 'node:crypto'

export const CREDENTIALS_FORMAT = 'dsh-backup-credentials'
export const CREDENTIALS_ZIP_PATH = 'payload/credentials/.credentials.yaml.enc'
export const CREDENTIALS_BASENAME = '.credentials.yaml'
export const CREDENTIALS_MIN_PASSPHRASE = 8

const SALT_BYTES = 16
const IV_BYTES = 12
const KEYLEN = 32
// scrypt 参数：N=2^15, r=8 → 128*N*r = 32 MiB，必须把 maxmem 提到默认 32 MiB
// 之上，否则 node 直接抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。
const KDF_PARAMS = { N: 1 << 15, r: 8, p: 1 }
const KDF_MAXMEM = 96 * 1024 * 1024

/** 凭据容器的可预期错误（密码错、容器损坏、格式不符）——调用方按业务错误处理。 */
export class CredentialsCryptoError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CredentialsCryptoError'
  }
}

export function hasPassphrase(passphrase) {
  return typeof passphrase === 'string' && passphrase.length > 0
}

/** 导出前的密码底线校验；返回 null 表示通过，否则返回给用户看的原因。 */
export function checkPassphraseStrength(passphrase) {
  const pass = String(passphrase == null ? '' : passphrase)
  if (pass.length === 0) return '未设置凭据加密密码，凭据组件将被跳过'
  if (pass.length < CREDENTIALS_MIN_PASSPHRASE) return `凭据加密密码至少 ${CREDENTIALS_MIN_PASSPHRASE} 位`
  return null
}

function deriveKey(passphrase, salt, { N, r, p, keylen }) {
  return crypto.scryptSync(Buffer.from(String(passphrase), 'utf8'), salt, keylen, {
    N, r, p, maxmem: KDF_MAXMEM,
  })
}

/**
 * 加密凭据文件内容。
 * @param {Buffer|string} plaintext 原始字节
 * @param {string} passphrase 用户密码
 * @returns {Buffer} 容器字节（UTF-8 JSON）
 */
export function encryptCredentials(plaintext, passphrase) {
  if (!hasPassphrase(passphrase)) throw new CredentialsCryptoError('未提供凭据加密密码')
  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')

  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)
  const key = deriveKey(passphrase, salt, { ...KDF_PARAMS, keylen: KEYLEN })

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()])
  const tag = cipher.getAuthTag()

  const envelope = {
    format: CREDENTIALS_FORMAT,
    version: 1,
    kdf: { name: 'scrypt', ...KDF_PARAMS, keylen: KEYLEN, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64') },
    plaintext: {
      name: CREDENTIALS_BASENAME,
      bytes: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
    },
    ciphertext: ciphertext.toString('base64'),
  }
  return Buffer.from(JSON.stringify(envelope, null, 2), 'utf8')
}

/**
 * 解密凭据容器。任何失败都抛 CredentialsCryptoError，绝不返回半成品字节。
 * @param {Buffer|string} envelope 容器字节
 * @param {string} passphrase 用户密码
 * @returns {Buffer} 原始字节
 */
export function decryptCredentials(envelope, passphrase) {
  if (!hasPassphrase(passphrase)) throw new CredentialsCryptoError('未提供凭据解密密码')

  let env
  try {
    env = JSON.parse(Buffer.isBuffer(envelope) ? envelope.toString('utf8') : String(envelope))
  } catch {
    throw new CredentialsCryptoError('凭据容器不是合法 JSON')
  }
  if (!env || typeof env !== 'object') throw new CredentialsCryptoError('凭据容器为空或类型错误')
  if (env.format !== CREDENTIALS_FORMAT) {
    throw new CredentialsCryptoError(`凭据容器格式不符：${env.format || '未知'}（期望 ${CREDENTIALS_FORMAT}）`)
  }
  if (Number(env.version) > 1) {
    throw new CredentialsCryptoError(`凭据容器版本过新：v${env.version}（本插件支持到 v1），请升级 dsh-backup 后再导入`)
  }

  const kdf = env.kdf && typeof env.kdf === 'object' ? env.kdf : {}
  const cipherSpec = env.cipher && typeof env.cipher === 'object' ? env.cipher : {}
  if (kdf.name !== 'scrypt') throw new CredentialsCryptoError(`不支持的 KDF：${kdf.name || '未知'}`)
  if (cipherSpec.name !== 'aes-256-gcm') throw new CredentialsCryptoError(`不支持的加密算法：${cipherSpec.name || '未知'}`)

  const keylen = Number(kdf.keylen) || KEYLEN
  const params = { N: Number(kdf.N), r: Number(kdf.r), p: Number(kdf.p), keylen }
  if (!Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) {
    throw new CredentialsCryptoError('凭据容器的 KDF 参数缺失或非法')
  }
  // 防「参数炸弹」：容器由外部提供，不允许它把 scrypt 内存推到 1 GiB 以上
  if (128 * params.N * params.r > KDF_MAXMEM) {
    throw new CredentialsCryptoError('凭据容器的 KDF 参数超出本机允许上限，拒绝解密')
  }

  const salt = Buffer.from(String(kdf.salt || ''), 'base64')
  const iv = Buffer.from(String(cipherSpec.iv || ''), 'base64')
  const tag = Buffer.from(String(cipherSpec.tag || ''), 'base64')
  const ciphertext = Buffer.from(String(env.ciphertext || ''), 'base64')
  if (salt.length === 0 || iv.length === 0 || tag.length === 0) {
    throw new CredentialsCryptoError('凭据容器的 salt / iv / tag 缺失')
  }

  const key = deriveKey(passphrase, salt, params)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)

  let plain
  try {
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // GCM 校验失败：密码错，或容器被篡改/截断
    throw new CredentialsCryptoError('密码不正确，或凭据容器已损坏（GCM 校验失败）')
  }

  const expect = env.plaintext && env.plaintext.sha256
  if (expect) {
    const got = crypto.createHash('sha256').update(plain).digest('hex')
    if (got !== String(expect).toLowerCase()) {
      throw new CredentialsCryptoError('解密结果与容器内记录的 sha256 不符，拒绝使用')
    }
  }
  return plain
}
