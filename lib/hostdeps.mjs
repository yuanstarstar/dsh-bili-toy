/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`
 * ============================================================================
 * 🔴 为什么要有它：
 *   `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` 在 package.json 里是 optional peer，
 *   桌面版 profile（`autoInstallPeers: false`）**不会装它们** ⇒ 裸 import 会让整条插件不激活，
 *   DSH 只留一句 `warning: 1 entry did not activate … failed to import`。
 * ⭐ 策略：① 先从宿主树解析（跟宿主用同一份）；② 拿不到退到自己依赖；③ schemastery 彻底拿不到
 *   就返回 null（插件照常加载，只是没有 Config），**绝不因为一个 import 让整条插件不激活**。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }

  // 桌面版：DSH Desktop\resources\app\node_modules\@deepseek-ai
  try {
    if (process.resourcesPath) push(join(process.resourcesPath, 'app', 'node_modules', '@deepseek-ai'))
  } catch { /* 忽略 */ }
  try { push(join(dirname(process.execPath), 'resources', 'app', 'node_modules', '@deepseek-ai')) } catch { /* 忽略 */ }

  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  // profile 树：有些机器上这些包被别的插件 hoist 到 profile 根
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

async function fromHostTree(name, log) {
  const fails = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(`${name}：从宿主树取到`)
      return mod
    } catch (e) { fails.push(`${e?.code || 'ERR'}`) }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${[...new Set(fails)].slice(0, 3).join(' ')}）`)
  return null
}

/** 兜底：自己的等价实现（宿主的 defineTool 会做 spec→JSONSchema 转换，这套 parameters 本来就是标准 JSON Schema） */
function localDefineTool(options, log) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  check(options.parameters, 'parameters')
  check(options.output?.schema, 'output.schema')
  log?.(`dsh-tools 拿不到 —— 用本地等价实现顶上（工具 ${options.name}）`)
  return options
}

export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  let zMod = await fromHostTree('schemastery', log)
  if (!zMod) {
    try { zMod = await import('@deepseek-ai/schemastery'); log('schemastery：用自己依赖里那份') } catch (e) {
      log(`⚠️ schemastery 彻底拿不到（${e?.code || ''}）—— 没有 Config，设置页降级（插件本体照常跑）`)
    }
  }
  const z = zMod?.default ?? zMod ?? null

  let dtMod = await fromHostTree('dsh-tools', log)
  if (!dtMod) {
    try { dtMod = await import('@deepseek-ai/dsh-tools'); log('dsh-tools：用自己依赖里那份') } catch {
      log('dsh-tools 拿不到 —— 用本地等价实现顶上')
      dtMod = null
    }
  }
  const defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, log))

  return { z, defineTool, notes }
}
