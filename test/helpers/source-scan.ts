// **源码扫描** —— 所有 `miniprogram/` 源码守卫共用的文件收集器。
//
// 为什么共享：`conventions` / `pages` / `content` 三处守卫断言的是同一批源码文件。
// 各写一份递归时，`miniprogram_npm/` 的排除规则、`.d.ts` 的排除规则会悄悄分叉 ——
// 于是一条守卫可能扫到了构建产物、另一条没扫到，结论互相矛盾却都「绿」。
//
// ⚠️ 扫描形状是**明确的**：跳过 `node_modules` / `miniprogram_npm` / 隐藏项；
// `.d.ts` 是声明不是实现，一律排除。

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 递归收集目录下指定后缀的源码文件。 */
export function collectSourceFiles(
  dir: string,
  extensions: readonly string[] = ['.ts'],
): string[] {
  const found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'miniprogram_npm' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full, extensions))
    } else if (!entry.endsWith('.d.ts') && extensions.some((extension) => entry.endsWith(extension))) {
      found.push(full)
    }
  }
  return found
}
