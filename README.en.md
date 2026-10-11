<div align="center">

# 💾 dsh-backup

**Backup & restore plugin for DeepSeek Harness** — workspaces, full conversations, attachments, settings and dsh-mnemon memory data in one ZIP; restore as-is after a new machine, a reinstall or an upgrade.

[简体中文](README.md) | English

![Version](https://img.shields.io/badge/version-0.2.0-4c7ef3?style=flat-square)
![Format](https://img.shields.io/badge/format-DshBackup%20v1-2b6cb0?style=flat-square)
![CI](https://github.com/having5548/dsh-backup/actions/workflows/ci.yml/badge.svg?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d6?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

</div>

---

## Highlights

- **Byte-exact conversations** — session files (`session.vN.jsonl[.zstd]`) are copied verbatim, never unpacked or rewritten. Old generations are upgraded by the harness's own migration chain when opened; future formats keep working the same way.
- **dsh-mnemon fidelity** — `~/.mnemon` (runtime / documents / data) is backed up byte-exact; a replace-restore puts context injection back to exactly what it was. Merge-restore follows the official Pack semantics.
- **Rescue console** — every disk backup ships with a zero-dependency `rescue.mjs` and double-click launchers, so you can restore even when DSH won't boot.
- **Auto backup & rotation** — scheduled backups to a local folder with `.sha256` sidecars and keep-N rotation; survives restarts.
- **`/backup` slash command** — `/backup`, `/backup restore latest --dry-run`, `/backup auto 12`, `/backup doctor` right from the chat.
- **Credential redaction** — secret-looking values in `settings.yaml` are replaced by placeholders on export; restore keeps your local real values automatically.
- **Encrypted credential store** — `~/.dsh/.credentials.yaml` (API keys + the connection cookie-signing secret) is a file where *every* line is a secret, so redaction is meaningless for it. Set a passphrase under Settings and it is sealed with AES-256-GCM + scrypt into `payload/credentials/.credentials.yaml.enc`; without a passphrase the component is skipped entirely rather than exported in the clear. The container carries a plaintext sha256, so a wrong passphrase fails *before* your local file is touched.
- **Editable backup folder & retention** — both are now fields in the settings panel, validated by an actual probe write when you save.
- **Preview before restore** — a dry-run plan shows exactly what will be added / overwritten / kept, plus missing-plugin detection. All writes go through staging → CRC verification → atomic commit → rollback with `.bak`.
- **Merge / replace modes** — merge only fills what's missing; replace overwrites matching files (never deletes extras) and keeps `.bak` copies.

## Install

> This repository is a fork of [having5548/dsh-backup](https://github.com/having5548/dsh-backup).
> **It is not published to npm** — the package name `@having5548/dsh-backup` belongs to the
> original author's npm scope, which this fork cannot publish to. Distribution is via the GitHub
> repository itself. The package name is kept as-is, so installing this fork **replaces** the
> existing plugin under the same dependency name in your profile.

```bash
# recommended — straight from the GitHub repo (follows main; the lockfile pins the commit):
dsh plugin --profile desktop add github:gaodayihao/dsh-backup

# fallback — only for machines without git: install the Release tarball instead
# (if it fails with ERR_PNPM_MISSING_TARBALL_INTEGRITY, see the note in README.md):
dsh plugin --profile web add https://github.com/gaodayihao/dsh-backup/releases/latest/download/having5548-dsh-backup.tgz

# or local build:
npm pack                                   # build having5548-dsh-backup-<version>.tgz
dsh plugin --profile web add having5548-dsh-backup-<version>.tgz
```

> The profile name depends on the front end: the **desktop app uses `desktop`**, the older CLI uses `web`.

Restart `dsh web`, then open **Settings → Backup & Restore** or type `/backup`.

## The DshBackup v1 format

A zip containing `manifest.json` (+ sha256 in `checksums.json`), an optional `redaction.json`, and `payload/` with `sessions/`, `sessions-archive/`, `storages/workspace.json`, `storages/session_projcache/`, `attachments/`, `settings/settings.yaml`, `credentials/.credentials.yaml.enc`, `profile/`, `mnemon/{runtime,documents,data}/`, `extensions/`. Every entry is CRC-verified on import; a higher `formatVersion` is rejected explicitly instead of being applied blindly.

## Why mnemon injection stays identical

All injected context comes from three directories under `~/.mnemon`. Replace-restore writes them back byte-for-byte after validating the index↔file and bodies↔database correspondences, so `system-prompt/assemble` and `agent/pre-step` see exactly the same memory snapshot as before the backup.

## Development

```bash
npm install
node --test test/local-test.mjs        # core: zip roundtrip, merge semantics, e2e
node --test test/v02-test.mjs          # v0.2: redaction, doctor, disk backup, rescue console
node --test test/credentials-test.mjs  # v0.6: credential container, encrypted export/restore
node --test test/route-harness.mjs     # HTTP routes end to end
node scripts/verify-version.mjs        # the three version sites must agree
```

MIT — see [LICENSE](LICENSE). Chinese documentation with full details: [README.md](README.md).
