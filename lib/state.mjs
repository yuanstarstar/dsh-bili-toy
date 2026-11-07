/**
 * lib/state.mjs —— 插件自己的家目录
 * ============================================================================
 * 所有会变的东西都放 `<DSH_HOME>/bili-toy/`，插件包目录保持只读：
 *   credential.json  扫码登录拿到的 cookie（SESSDATA / bili_jct / DedeUserID / buvid3）
 *   settings.json    设置页写入的选项（分类、默认打开方式…）
 *   endpoints.json   运行时探到的真实接口（广场 / 评论 type）—— 探到就存，下次直接用
 *   toy.log          最近的操作日志（排查用）
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

export function homeDir() {
  const root = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(root, 'bili-toy')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 只读就算了，调用方会自己报错 */ }
  return dir
}

export const statePath = (name) => join(homeDir(), name)

export function readJson(file, dflt = null) {
  try {
    if (!existsSync(file)) return dflt
    const raw = readFileSync(file, 'utf8').trim()
    if (!raw) return dflt
    return JSON.parse(raw)
  } catch { return dflt }
}

/** 原子写：先写 .tmp 再 rename，避免写一半被读到 */
export function writeJson(file, value) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  try { renameSync(tmp, file) } catch {
    try { writeFileSync(file, JSON.stringify(value, null, 2), 'utf8') } catch { /* 忽略 */ }
  }
}

export function logLine(tag, msg) {
  try {
    const line = `[${new Date().toISOString()}] ${tag} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`
    appendFileSync(statePath('toy.log'), line, 'utf8')
  } catch { /* 忽略 */ }
}

/** 只留最近 400 行日志，别无限长 */
export function trimLog() {
  try {
    const p = statePath('toy.log')
    if (!existsSync(p)) return
    const lines = readFileSync(p, 'utf8').split('\n')
    if (lines.length > 400) writeFileSync(p, lines.slice(-400).join('\n'), 'utf8')
  } catch { /* 忽略 */ }
}

/* ---------------- 凭证 ---------------- */

const CRED_FIELDS = ['sessdata', 'bili_jct', 'dedeuserid', 'buvid3', 'buvid4', 'uname', 'mid', 'savedAt']

export function loadCred() {
  const c = readJson(statePath('credential.json'), null)
  if (!c || typeof c !== 'object') return null
  const out = {}
  for (const k of CRED_FIELDS) if (c[k] !== undefined && c[k] !== null && c[k] !== '') out[k] = c[k]
  return out.sessdata ? out : null
}

export function saveCred(patch) {
  const next = { ...(loadCred() || {}), ...patch, savedAt: new Date().toISOString() }
  writeJson(statePath('credential.json'), next)
  // cookie 里有登录令牌：Windows 上收紧权限（失败不致命）
  if (process.platform === 'win32' && process.env.USERNAME) {
    try {
      spawnSync('icacls', [statePath('credential.json'), '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore' })
    } catch { /* 忽略 */ }
  }
  return next
}

export function clearCred() {
  try { writeJson(statePath('credential.json'), {}) } catch { /* 忽略 */ }
}

export function hasCred() {
  const c = loadCred()
  return !!(c && c.sessdata)
}

/* ---------------- 设置 ---------------- */

export const DEFAULT_SETTINGS = {
  /** 广场默认分类：all / 推荐 / 游戏 …（数字或字符串都由探测结果决定） */
  category: 'all',
  /** 打开 toy 的方式：browser = 系统浏览器新标签（默认）/ host = 宿主侧不建议 */
  openMode: 'browser',
  /** 评论区默认排序：2 = 热度，0 = 时间 */
  replySort: 2,
  /** 探测到的评论 type（不知道就 0，评论工具会先探再用） */
  replyType: 0,
}

export function loadSettings() {
  const s = readJson(statePath('settings.json'), {})
  return { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...(patch || {}) }
  writeJson(statePath('settings.json'), next)
  return next
}

/* ---------------- 探到的接口 ---------------- */

export function loadEndpoints() {
  const e = readJson(statePath('endpoints.json'), {})
  return e && typeof e === 'object' ? e : {}
}

export function saveEndpoints(patch) {
  const next = { ...loadEndpoints(), ...(patch || {}), updatedAt: new Date().toISOString() }
  writeJson(statePath('endpoints.json'), next)
  return next
}
