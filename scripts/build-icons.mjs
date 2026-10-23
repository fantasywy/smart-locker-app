#!/usr/bin/env node
// Build-time icon pipeline (#60).
//
//   lucide-static@1.61.0 (devDependency)
//        │  read icons/<glyph>.svg
//        ├── miniprogram/assets/tabbar/<route>.png        81×81 RGBA, content box 72, stroke 2
//        │   miniprogram/assets/tabbar/<route>-active.png
//        └── miniprogram/components/icon/icons.generated.ts
//              semantic key → tone → base64 data URI (colors baked in)
//
// Runtime code never imports Lucide. The generated table is the only runtime artifact.
//
// Usage:
//   pnpm icons:build   write artifacts
//   pnpm verify:icons  regenerate in memory and byte-compare (scripts/verify-icons.mjs)

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initWasm, Resvg } from '@resvg/resvg-wasm'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const manifestPath = join(here, 'icons', 'manifest.json')
const variablesPath = join(repoRoot, 'miniprogram', 'styles', '_variables.scss')
const tabbarDir = join(repoRoot, 'miniprogram', 'assets', 'tabbar')
const generatedPath = join(repoRoot, 'miniprogram', 'components', 'icon', 'icons.generated.ts')

/** The component's public tone whitelist (spec §11). `main` exists only for tabBar. */
export const ICON_TONES = ['primary', 'sub', 'weak', 'danger', 'white']

const TABBAR_SIZE = 81
const CONTENT_BOX = 72
const LUCIDE_VIEWBOX = 24
const STROKE_WIDTH = 2

let wasmReady = false

async function initResvg() {
  if (wasmReady) return
  const wasm = await readFile(join(repoRoot, 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm'))
  await initWasm(wasm)
  wasmReady = true
}

/** Read the only token source and return a token-name → lowercase hex map. */
async function readTokens() {
  const scss = await readFile(variablesPath, 'utf8')
  const tokens = new Map()
  for (const line of scss.split('\n')) {
    const match = /^\s*\$([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(line)
    if (match?.[1] && match[2]) tokens.set(match[1], match[2].toLowerCase())
  }
  return tokens
}

function resolveColor(tokenMap, tone, toneTokens) {
  const token = toneTokens[tone]
  if (!token) throw new Error(`manifest has no token for tone "${tone}"`)
  if (token.startsWith('#')) return token
  const name = token.replace(/^\$/, '')
  const value = tokenMap.get(name)
  if (!value) throw new Error(`token ${token} not found in miniprogram/styles/_variables.scss`)
  return value
}

function innerMarkup(svgSource) {
  const withoutComment = svgSource.replace(/<!--[\s\S]*?-->/g, '')
  const match = /<svg\b[^>]*>([\s\S]*)<\/svg>/.exec(withoutComment)
  if (!match?.[1]) throw new Error('Lucide SVG does not contain a root <svg>')
  return match[1].replace(/>\s+</g, '><').trim()
}

function uiSvg(inner, color) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ` +
    `fill="none" stroke="${color}" stroke-width="${STROKE_WIDTH}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
  )
}

function tabbarSvg(inner, color) {
  const offset = (TABBAR_SIZE - CONTENT_BOX) / 2
  const scale = CONTENT_BOX / LUCIDE_VIEWBOX
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TABBAR_SIZE}" height="${TABBAR_SIZE}" ` +
    `viewBox="0 0 ${TABBAR_SIZE} ${TABBAR_SIZE}">` +
    `<g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" ` +
    `stroke="${color}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" ` +
    `stroke-linejoin="round">${inner}</g></svg>`
  )
}

function routeOf(pagePath) {
  const parts = pagePath.split('/').filter(Boolean)
  const route = parts.at(-1)
  if (!route) throw new Error(`cannot derive route from pagePath "${pagePath}"`)
  return route
}

function dataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

async function assertLucideVersion(manifest) {
  const pkg = JSON.parse(
    await readFile(join(repoRoot, 'node_modules', 'lucide-static', 'package.json'), 'utf8'),
  )
  if (pkg.version !== manifest.lucideVersion) {
    throw new Error(
      `lucide-static version drift: manifest pins ${manifest.lucideVersion}, installed ${pkg.version}`,
    )
  }
}

async function readGlyph(manifest, glyph) {
  const svg = await readFile(
    join(repoRoot, 'node_modules', 'lucide-static', 'icons', `${glyph}.svg`),
    'utf8',
  )
  return innerMarkup(svg)
}

function renderGenerated(entries) {
  const lines = [
    '// AUTO-GENERATED FILE — DO NOT EDIT.',
    '// Regenerate with: pnpm icons:build',
    '// Source: scripts/icons/manifest.json. Icon artwork: Lucide 1.61.0 (ISC).',
    '// See THIRD_PARTY_NOTICES.md for the full license text.',
    '',
    `export const ICON_TONES = [${ICON_TONES.map((tone) => `'${tone}'`).join(', ')}] as const`,
    '',
    'export type IconTone = (typeof ICON_TONES)[number]',
    '',
    'export const ICON_DATA = {',
  ]
  for (const key of Object.keys(entries).sort()) {
    lines.push(`  '${key}': {`)
    for (const tone of ICON_TONES) {
      lines.push(`    ${tone}: '${entries[key][tone]}',`)
    }
    lines.push('  },')
  }
  lines.push('} as const', '', 'export type IconName = keyof typeof ICON_DATA', '')
  return lines.join('\n')
}

/**
 * Generate every artifact in memory. Deterministic: same inputs → identical bytes.
 * @returns {Promise<{ pngs: Map<string, Buffer>, generated: string }>}
 */
export async function buildArtifacts() {
  await initResvg()
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await assertLucideVersion(manifest)
  const tokenMap = await readTokens()
  const toneTokens = manifest.tones ?? {}
  const glyphCache = new Map()

  const entries = {}
  for (const [key, entry] of Object.entries(manifest.icons)) {
    const inner = glyphCache.get(entry.lucide) ?? (await readGlyph(manifest, entry.lucide))
    glyphCache.set(entry.lucide, inner)
    entries[key] = {}
    for (const tone of ICON_TONES) {
      const color = resolveColor(tokenMap, tone, toneTokens)
      entries[key][tone] = dataUri(uiSvg(inner, color))
    }
  }

  const pngs = new Map()
  const routes = new Set()
  for (const item of manifest.tabbar) {
    const route = routeOf(item.pagePath)
    if (routes.has(route)) throw new Error(`duplicate tabBar route "${route}"`)
    routes.add(route)
    const inner = glyphCache.get(item.lucide) ?? (await readGlyph(manifest, item.lucide))
    glyphCache.set(item.lucide, inner)
    for (const [suffix, tone] of [
      ['', item.normal],
      ['-active', item.active],
    ]) {
      const color = resolveColor(tokenMap, tone, toneTokens)
      const rendered = new Resvg(tabbarSvg(inner, color)).render()
      if (rendered.width !== TABBAR_SIZE || rendered.height !== TABBAR_SIZE) {
        throw new Error(`unexpected raster size ${rendered.width}×${rendered.height}`)
      }
      pngs.set(join(tabbarDir, `${route}${suffix}.png`), Buffer.from(rendered.asPng()))
    }
  }

  return { pngs, generated: renderGenerated(entries) }
}

export async function writeArtifacts() {
  const { pngs, generated } = await buildArtifacts()
  await mkdir(tabbarDir, { recursive: true })
  for (const [file, bytes] of pngs) await writeFile(file, bytes)
  await mkdir(dirname(generatedPath), { recursive: true })
  await writeFile(generatedPath, generated, 'utf8')
  return { pngs, generated }
}

async function main() {
  const { pngs } = await writeArtifacts()
  const generated = await readFile(generatedPath)
  process.stdout.write(
    `icons:build wrote ${pngs.size} PNGs and icons.generated.ts (${generated.length} bytes)\n`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}
