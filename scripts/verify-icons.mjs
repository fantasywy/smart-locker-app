#!/usr/bin/env node
// Verify committed icon artifacts without writing anything (#60).
//
// 1. Regenerate every artifact in memory and byte-compare with git-tracked files.
// 2. Validate each tabBar PNG: IHDR 81×81, 8-bit RGBA, non-interlaced, transparent
//    background, content box ≤ 72, fully opaque pixels exactly the expected token color.
// 3. Validate each map marker PNG: 48×48 RGBA, transparent background, opaque pixels
//    exactly `{ availability token, $color-bg-card }` (fill + white ring).
// 4. Validate `app.json` tabBar `color` / `selectedColor` equal `$color-text-weak` /
//    `$color-text-main`.
//
// This is NOT chained into `verify:tokens` (spec §12): icon drift and token drift
// should fail independently.

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { buildArtifacts } from './build-icons.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const miniprogramDir = join(repoRoot, 'miniprogram')
const tabbarDir = join(miniprogramDir, 'assets', 'tabbar')
const mapDir = join(miniprogramDir, 'assets', 'map')
const manifestPath = join(here, 'icons', 'manifest.json')
const generatedPath = join(miniprogramDir, 'components', 'icon', 'icons.generated.ts')
const variablesPath = join(miniprogramDir, 'styles', '_variables.scss')
const appJsonPath = join(miniprogramDir, 'app.json')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function rel(path) {
  return relative(repoRoot, path)
}

function readTokens(scss) {
  const tokens = new Map()
  for (const line of scss.split('\n')) {
    const match = /^\s*\$([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(line)
    if (match?.[1] && match[2]) tokens.set(match[1], match[2].toLowerCase())
  }
  return tokens
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Minimal 8-bit RGBA, non-interlaced PNG decoder (the only shape this repo emits). */
function decodePng(buffer, file) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${rel(file)}: not a PNG`)
  let offset = 8
  let ihdr = null
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (!ihdr) throw new Error(`${rel(file)}: missing IHDR`)
  if (ihdr.bitDepth !== 8 || ihdr.colorType !== 6) {
    throw new Error(
      `${rel(file)}: expected 8-bit RGBA, got bitDepth=${ihdr.bitDepth} colorType=${ihdr.colorType}`,
    )
  }
  if (ihdr.interlace !== 0) throw new Error(`${rel(file)}: interlaced PNG not supported`)
  if (ihdr.compression !== 0 || ihdr.filter !== 0) {
    throw new Error(`${rel(file)}: unsupported PNG compression/filter method`)
  }

  const bpp = 4
  const stride = ihdr.width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(ihdr.width * ihdr.height * bpp)
  let rawOffset = 0
  for (let y = 0; y < ihdr.height; y += 1) {
    const filterType = raw[rawOffset]
    rawOffset += 1
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[rawOffset]
      rawOffset += 1
      const index = y * stride + x
      const left = x >= bpp ? pixels[index - bpp] : 0
      const up = y > 0 ? pixels[index - stride] : 0
      const upLeft = y > 0 && x >= bpp ? pixels[index - stride - bpp] : 0
      let value
      switch (filterType) {
        case 0:
          value = encoded
          break
        case 1:
          value = encoded + left
          break
        case 2:
          value = encoded + up
          break
        case 3:
          value = encoded + Math.floor((left + up) / 2)
          break
        case 4:
          value = encoded + paeth(left, up, upLeft)
          break
        default:
          throw new Error(`${rel(file)}: unsupported PNG filter ${filterType}`)
      }
      pixels[index] = value & 0xff
    }
  }
  return { ...ihdr, pixels }
}

function inspectPng(png, file, expectedColor) {
  const errors = []
  if (png.width !== 81 || png.height !== 81) {
    errors.push(`${rel(file)}: expected 81×81, got ${png.width}×${png.height}`)
  }
  let minX = png.width
  let minY = png.height
  let maxX = -1
  let maxY = -1
  const colors = new Set()
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (y * png.width + x) * 4
      const alpha = png.pixels[index + 3]
      if (alpha === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (alpha === 255) {
        colors.add(
          `#${png.pixels[index].toString(16).padStart(2, '0')}${png.pixels[index + 1]
            .toString(16)
            .padStart(2, '0')}${png.pixels[index + 2].toString(16).padStart(2, '0')}`,
        )
      }
    }
  }

  if (maxX < 0) errors.push(`${rel(file)}: image is fully transparent`)
  const contentWidth = maxX - minX + 1
  const contentHeight = maxY - minY + 1
  if (contentWidth > 72 || contentHeight > 72) {
    errors.push(`${rel(file)}: content box ${contentWidth}×${contentHeight} exceeds 72`)
  }
  if (minX < 4 || minY < 4 || maxX > 76 || maxY > 76) {
    errors.push(
      `${rel(file)}: content bbox ${minX},${minY}–${maxX},${maxY} escapes the 72px content box`,
    )
  }
  for (const corner of [
    [0, 0],
    [png.width - 1, 0],
    [0, png.height - 1],
    [png.width - 1, png.height - 1],
  ]) {
    const alpha = png.pixels[(corner[1] * png.width + corner[0]) * 4 + 3]
    if (alpha !== 0) errors.push(`${rel(file)}: corner ${corner.join(',')} is not transparent`)
  }
  const found = [...colors].sort()
  if (found.length !== 1 || found[0] !== expectedColor) {
    errors.push(
      `${rel(file)}: opaque colors ${found.join(', ') || '(none)'} != ${expectedColor}`,
    )
  }
  return errors
}

/**
 * 地图 marker —— 48×48、透明底、两种不透明色（状态色 + 白描边）。
 *
 * 与 tabBar 分开校验：marker 是地图原生组件消费的图片，尺寸与内容盒规则不同；
 * 合并成一条会让「81×81 的 tabBar 图标」与「48×48 的水滴」互相迁就。
 */
function inspectMarkerPng(png, file, fill, ring) {
  const errors = []
  if (png.width !== 48 || png.height !== 48) {
    errors.push(`${rel(file)}: expected 48×48, got ${png.width}×${png.height}`)
  }
  for (const corner of [
    [0, 0],
    [png.width - 1, 0],
    [0, png.height - 1],
    [png.width - 1, png.height - 1],
  ]) {
    const alpha = png.pixels[(corner[1] * png.width + corner[0]) * 4 + 3]
    if (alpha !== 0) errors.push(`${rel(file)}: corner ${corner.join(',')} is not transparent`)
  }
  const colors = new Set()
  for (let i = 0; i < png.pixels.length; i += 4) {
    if (png.pixels[i + 3] !== 255) continue
    colors.add(
      `#${png.pixels[i].toString(16).padStart(2, '0')}${png.pixels[i + 1]
        .toString(16)
        .padStart(2, '0')}${png.pixels[i + 2].toString(16).padStart(2, '0')}`,
    )
  }
  // 抗锯齿会在 fill 与白描边之间留下整条混色带 —— 它们都是两种 token 色的线性混合，
  // 因此判据是「两种 token 色都在，且没有第三种色相」而不是「只有两种色值」。
  const channelsOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const [fillChannels, ringChannels] = [channelsOf(fill), channelsOf(ring)]
  const bounds = fillChannels.map((value, index) => {
    const other = ringChannels[index]
    return [Math.min(value, other), Math.max(value, other)]
  })
  for (const color of colors) {
    const channels = channelsOf(color)
    const blended = channels.every(
      (value, index) => value >= bounds[index][0] && value <= bounds[index][1],
    )
    if (!blended) errors.push(`${rel(file)}: opaque color ${color} is outside fill/ring blend`)
  }
  if (!colors.has(fill) || !colors.has(ring)) {
    errors.push(`${rel(file)}: missing fill ${fill} or ring ${ring}`)
  }
  return errors
}

async function main() {
  const errors = []
  const expected = await buildArtifacts()
  const tokens = readTokens(await readFile(variablesPath, 'utf8'))
  const weak = tokens.get('color-text-weak')
  const main = tokens.get('color-text-main')
  if (!weak || !main) throw new Error('tabBar tokens not found in _variables.scss')

  // 1) exactly the generated artifact set, byte-for-byte.
  const actualFiles = existsSync(tabbarDir) ? (await readdir(tabbarDir)).sort() : []
  const expectedFiles = [...expected.pngs.keys()].map((file) => basename(file)).sort()
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    errors.push(
      `${rel(tabbarDir)}: files ${actualFiles.join(', ') || '(none)'} != ${expectedFiles.join(', ')}`,
    )
  }

  for (const [file, bytes] of expected.pngs) {
    let actual
    try {
      actual = await readFile(file)
    } catch {
      errors.push(`${rel(file)}: missing artifact`)
      continue
    }
    if (!actual.equals(bytes)) errors.push(`${rel(file)}: bytes differ from regenerated output`)
    const suffix = file.endsWith('-active.png') ? '-active' : ''
    const expectedColor = suffix === '' ? weak : main
    try {
      errors.push(...inspectPng(decodePng(actual, file), file, expectedColor))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(message.startsWith(rel(file)) ? message : `${rel(file)}: ${message}`)
    }
  }

  // 2) map marker artifacts: exactly the manifest set, byte-identical, two-color pins.
  const actualMarkerFiles = existsSync(mapDir) ? (await readdir(mapDir)).sort() : []
  const expectedMarkerFiles = [...expected.mapPngs.keys()].map((file) => basename(file)).sort()
  if (JSON.stringify(actualMarkerFiles) !== JSON.stringify(expectedMarkerFiles)) {
    errors.push(
      `${rel(mapDir)}: files ${actualMarkerFiles.join(', ') || '(none)'} != ` +
        `${expectedMarkerFiles.join(', ')}`,
    )
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const ring = tokens.get('color-bg-card')
  if (!ring) throw new Error('$color-bg-card not found in _variables.scss')
  for (const [file, bytes] of expected.mapPngs) {
    let actual
    try {
      actual = await readFile(file)
    } catch {
      errors.push(`${rel(file)}: missing artifact`)
      continue
    }
    if (!actual.equals(bytes)) errors.push(`${rel(file)}: bytes differ from regenerated output`)
    const key = basename(file).replace(/^marker-|\.png$/g, '')
    const tokenName = manifest.mapMarkers?.[key]?.replace(/^\$/, '')
    const fill = tokenName === undefined ? undefined : tokens.get(tokenName)
    if (fill === undefined) {
      errors.push(`${rel(file)}: no token for marker "${key}" in manifest`)
      continue
    }
    try {
      errors.push(...inspectMarkerPng(decodePng(actual, file), file, fill, ring))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(message.startsWith(rel(file)) ? message : `${rel(file)}: ${message}`)
    }
  }

  // 3) generated manifest is current.
  let generated
  try {
    generated = await readFile(generatedPath)
  } catch {
    errors.push(`${rel(generatedPath)}: missing artifact`)
  }
  if (generated && generated.toString('utf8') !== expected.generated) {
    errors.push(`${rel(generatedPath)}: bytes differ from regenerated output`)
  }

  // 4) app.json colors stay tied to the tokens (native config can't read SCSS).
  const appJson = JSON.parse(await readFile(appJsonPath, 'utf8'))
  const tabBar = appJson.tabBar ?? {}
  if (tabBar.color !== weak) errors.push(`app.json tabBar.color ${tabBar.color} != ${weak}`)
  if (tabBar.selectedColor !== main) {
    errors.push(`app.json tabBar.selectedColor ${tabBar.selectedColor} != ${main}`)
  }

  if (errors.length > 0) {
    process.stderr.write(`verify:icons failed (${errors.length}):\n`)
    for (const entry of errors) process.stderr.write(`  • ${entry}\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write(
    `verify:icons ok: ${expected.pngs.size} tabBar PNGs (81×81 RGBA), ` +
      `${expected.mapPngs.size} map markers (48×48 RGBA), generated manifest, app.json colors\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
