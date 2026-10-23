// Minimal PNG reader for tests that guard committed image artifacts.
//
// Only the subset the repo produces is supported: 8-bit RGBA, non-interlaced.
// It exists so `test/startup/skeleton.test.ts` can assert **pixels** (tabBar
// colors) rather than trusting the build script's in-memory output.

import { inflateSync } from 'node:zlib'

export interface DecodedPng {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlace: number
  /** Straight (non-premultiplied) RGBA pixels, row-major. */
  pixels: Buffer
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function decodePng(buffer: Buffer): DecodedPng {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('not a PNG file')

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []
  let sawIhdr = false
  let sawIend = false

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8] ?? 0
      colorType = data[9] ?? 0
      interlace = data[12] ?? 0
      sawIhdr = true
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      sawIend = true
      break
    }
    offset += 12 + length
  }

  if (!sawIhdr) throw new Error('PNG missing IHDR')
  if (!sawIend) throw new Error('PNG missing IEND')
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType}`)
  }

  const bytesPerPixel = 4
  const stride = width * bytesPerPixel
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(width * height * bytesPerPixel)
  let rawOffset = 0

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset] ?? -1
    rawOffset += 1
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rawOffset] ?? 0
      rawOffset += 1
      const index = y * stride + x
      const left = x >= bytesPerPixel ? pixels[index - bytesPerPixel] ?? 0 : 0
      const up = y > 0 ? pixels[index - stride] ?? 0 : 0
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[index - stride - bytesPerPixel] ?? 0 : 0
      let decoded: number
      switch (filter) {
        case 0:
          decoded = value
          break
        case 1:
          decoded = value + left
          break
        case 2:
          decoded = value + up
          break
        case 3:
          decoded = value + Math.floor((left + up) / 2)
          break
        case 4:
          decoded = value + paeth(left, up, upLeft)
          break
        default:
          throw new Error(`unsupported PNG filter ${filter}`)
      }
      pixels[index] = decoded & 0xff
    }
  }

  return { width, height, bitDepth, colorType, interlace, pixels }
}

export interface AlphaBBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function alphaBBox(png: DecodedPng): AlphaBBox {
  let minX = png.width
  let minY = png.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const alpha = png.pixels[(y * png.width + x) * 4 + 3] ?? 0
      if (alpha === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { minX, minY, maxX, maxY }
}

/** Every fully opaque pixel must be exactly `hex` (no second color bleeds in). */
export function opaqueColors(png: DecodedPng): string[] {
  const colors = new Set<string>()
  for (let i = 0; i < png.pixels.length; i += 4) {
    if ((png.pixels[i + 3] ?? 0) !== 255) continue
    colors.add(
      `#${(png.pixels[i] ?? 0).toString(16).padStart(2, '0')}${(png.pixels[i + 1] ?? 0)
        .toString(16)
        .padStart(2, '0')}${(png.pixels[i + 2] ?? 0).toString(16).padStart(2, '0')}`,
    )
  }
  return [...colors]
}
