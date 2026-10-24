#!/usr/bin/env node
// npm 组件构建产物验收脚本 —— 断言 `usingComponents` 引用的每个 npm 组件都真的落盘。
//
// 为什么需要它：`miniprogram_npm/` 是 gitignore 的构建产物，必须由微信开发者工具的
// 「工具 → 构建 npm」生成。漏掉这一步（或构建被 pnpm 的符号链接布局悄悄做残）时，
// 开发者工具只在启动模拟器时抛一大段「路径下未找到组件」，看不出根因；本脚本把同一
// 事实提前成一条可判定的断言。
//
// 判据：对 miniprogram 里每个 .json 的 usingComponents，若引用 npm 包（不以 "/" 或 "."
// 开头），则在构建产物目录中必须能找到 <pkg>/<sub>.js + .json + .wxml。
// 本地组件（"/components/..."）不归本脚本管。
//
// 用法：node scripts/verify-npm-build.mjs
// 退出码 0 = 全过；1 = 有缺失（打印组件、引用它的文件、期望路径、修复命令）。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectConfig = JSON.parse(readFileSync(join(repoRoot, 'project.config.json'), 'utf8'))
const miniprogramRoot = resolve(repoRoot, projectConfig.miniprogramRoot ?? 'miniprogram/')

// 「构建 npm」的落盘位置由 packNpmRelationList 决定，缺省是 miniprogramRoot 下的
// miniprogram_npm/。这里按配置推导，避免脚本和工具的认知分叉。
const npmDistDir = (() => {
  const relation = (projectConfig.setting?.packNpmRelationList ?? [])[0]
  if (!relation?.miniprogramNpmDistDir) return miniprogramRoot
  return resolve(repoRoot, relation.miniprogramNpmDistDir)
})()

function walkJson(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'miniprogram_npm' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walkJson(path, out)
    else if (name.endsWith('.json')) out.push(path)
  }
  return out
}

// 组件存在 = 同一路径下 js（或 ts）+ json + wxml 三件套齐全。缺 wxml 的构建产物在
// 开发者工具里同样报「未找到组件」，所以不能用「只要 js 在」蒙混过去。
function componentMissing(base) {
  const has = (ext) => existsSync(`${base}${ext}`)
  const missing = []
  if (!has('.js') && !has('.ts')) missing.push('.js')
  for (const ext of ['.json', '.wxml']) if (!has(ext)) missing.push(ext)
  return missing
}

// 开发者工具对 npm 组件的候选路径：<pkg>/<sub> 与 <pkg>/<sub>/index。
function npmCandidates(spec) {
  const match = spec.match(/^(@[^/]+\/[^/]+)\/(.+)$/) ?? spec.match(/^([^@/][^/]*)\/(.+)$/)
  if (!match) return []
  const [, pkg, sub] = match
  const base = join(npmDistDir, 'miniprogram_npm', pkg, sub)
  return [base, join(base, 'index')]
}

const npmRoot = join(npmDistDir, 'miniprogram_npm')
if (!existsSync(npmRoot)) {
  console.error(`[FAIL] 构建产物目录不存在：${relative(repoRoot, npmRoot)}`)
  console.error('       修复：微信开发者工具 → 工具 → 构建 npm（先 pnpm install）')
  process.exit(1)
}

const failures = []
let checked = 0

for (const file of walkJson(miniprogramRoot)) {
  const { usingComponents = {} } = JSON.parse(readFileSync(file, 'utf8'))
  for (const [name, spec] of Object.entries(usingComponents)) {
    if (spec.startsWith('/') || spec.startsWith('.')) continue
    checked++

    const candidates = npmCandidates(spec)
    const resolved = candidates.find((base) => componentMissing(base).length === 0)
    if (resolved) continue

    // 报告最有信息量的那个候选：目录存在就报缺哪个文件，目录不存在就报期望路径。
    const existing = candidates.find((base) => existsSync(`${base}.js`))
    const detail = existing
      ? `${relative(repoRoot, existing)} 缺少 ${componentMissing(existing).join(' / ')}`
      : `期望 ${relative(repoRoot, candidates[0])}.js，目录不存在`
    failures.push(`[FAIL] ${relative(repoRoot, file)} → "${name}": "${spec}"\n       ${detail}`)
  }
}

// 构建产物自己也有依赖：相对 usingComponents（"../overlay/index"）和相对 require
// （"../mixins/transition"）。漏拷一个 mixin 时页面引用检查照样通过，运行期才抛
// module is not defined —— 所以对产物内部的依赖再验一遍。
function walkFiles(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walkFiles(path, ext, out)
    else if (name.endsWith(ext)) out.push(path)
  }
  return out
}

for (const file of walkJson(npmRoot)) {
  const { usingComponents = {} } = JSON.parse(readFileSync(file, 'utf8'))
  for (const [name, spec] of Object.entries(usingComponents)) {
    if (!spec.startsWith('.')) continue
    checked++
    const base = resolve(dirname(file), spec)
    const missing = componentMissing(base)
    if (missing.length > 0) {
      failures.push(
        `[FAIL] ${relative(repoRoot, file)} → "${name}": "${spec}"\n       ${relative(repoRoot, base)} 缺少 ${missing.join(' / ')}`
      )
    }
  }
}

for (const file of walkFiles(npmRoot, '.js')) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    const spec = match[1]
    checked++
    const base = resolve(dirname(file), spec)
    if (!existsSync(`${base}.js`) && !existsSync(join(base, 'index.js'))) {
      failures.push(
        `[FAIL] ${relative(repoRoot, file)} → require("${spec}")\n       期望 ${relative(repoRoot, base)}.js，文件不存在（构建产物不完整）`
      )
    }
  }
}

if (failures.length > 0) {
  for (const line of failures) console.error(line)
  console.error(`\n${failures.length}/${checked} 个 npm 组件/模块引用无法解析。`)
  console.error('修复：微信开发者工具 → 工具 → 构建 npm；若已完成，检查 .npmrc 的 node-linker=hoisted 是否生效。')
  process.exit(1)
}

console.log(`[ok] ${checked} 个组件/模块引用全部落在 ${relative(repoRoot, npmRoot)}`)
