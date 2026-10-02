import { crc32, deflateSync } from "node:zlib"

function chunk(kind: string, data: Buffer) {
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length)
  result.write(kind, 4)
  data.copy(result, 8)
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4)
  return result
}

// Deterministic landscape with four colored quadrants, like OpenCode's diff-image fixture.
function landscape() {
  const width = 96
  const height = 48
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc(height * (width * 3 + 1))
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)]
      pixels.set(color, y * (width * 3 + 1) + 1 + x * 3)
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0)),
  ])
}

export const rasterFixtures = [
  { kind: "png", mime: "image/png", width: 96, height: 48, bytes: landscape() },
  // Small JPEG fixture from opencode/packages/ai/test/fixtures/images/edit-source.jpg.
  { kind: "jpeg", mime: "image/jpeg", width: 128, height: 128, bytes: Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgQEBMQExYWFhYWFhoYGhsbGxoaGhobGxsdHR0iIiIdHR0bGx0dICAiIiUmJSMjIiMmJigoKDAwLi44ODpFRVP/xABrAAEBAQEBAQAAAAAAAAAAAAAABwgGBAUBAQAAAAAAAAAAAAAAAAAAAAAQAAICAQEFBwMEAwEAAAAAAAABAwIEEQYFEiFhwXGBUUExE6GRU0LwciLh8bEjEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAgACAAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8Av4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB458iLFjtLNesdK+9rPRf76e4yMiPFivNLbhpHV2s+i7X6LzMhb33xPvabitrWKrfxxa8qrzfnZ+r8EBTc/bPm64USa/LLrz61omvq/AnMu0W9ZXq8q9elFSi+ldTigB2se0W9Ynqsq9ul1S6+tSiYG2b1Vc2Jafli15dXRt/R+BBgBuvHyIcqOssN6yUt7Wq9V/h9HzPYY03RvefdM3HTW0dn/AOkWvKy815WXo/ua+x8iPKhpNFbipJVWq/36r2a8wPaAAAAAAAAAAIDtnnvWLCq+WnyydfSlX9X9iDHZ7QyuXeuW3+m6ou6lUjjAAAAAAAXbYzeDVpcKz5NfLH0ftdLv5P7kJOw2flcW9cRr1k4H3XTr2gbHAAAAAAAAAAGO9oYnFvXLT/VdXXdeqZxhdts8Bq0WZVcmvik6NaujffzX2ISAAAAAADr9wRuXeuGl6ScfhRO3YcgXHYzAdpZcyy/rRfFH1s+dmu5aLxA0MAAAAAAAAAAPDk40WXDJDLXipJXha7V1Xuupj7eu6p91TuORO1Hr8cmnK67LL1Rs8+fk4sOZFaKeOslLe6f/AFP3T8muYGGAXHP2Nkq3bDlV6/jl5WXRXXJ+KROpdxb0ielsOZ/wXGvvRsDkwdXHuLekr0WHMv5V4F97tFDwNjZrtWzJVHX8cb4rvo7acK8NQJtuvdc+9Z1FGtKrT5JNP60r2vyXqbBxMWLCgjgiXDSNaLzfm31b5sYuJBhRKKCOsdF6L1fm37t9WfRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/9k=", "base64") },
  { kind: "gif", mime: "image/gif", width: 1, height: 1, bytes: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64") },
  { kind: "webp", mime: "image/webp", width: 1, height: 1, bytes: Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64") },
] as const
