import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const MAX_VERSION = 999

export type SaveResult = {
  readonly savedPath: string
  readonly versioned: boolean
  readonly message: string
}

export async function saveGeneratedImage(out: string, directory: string, data: Uint8Array): Promise<SaveResult> {
  const requestedPath = path.isAbsolute(out) ? out : path.resolve(directory, out)
  await mkdir(path.dirname(requestedPath), { recursive: true })
  const savedPath = await writeNonOverwrite(requestedPath, data)
  const versioned = savedPath !== requestedPath
  const versionNote = versioned
    ? ` (the requested path ${requestedPath} already existed; the new image was versioned to avoid overwriting it)`
    : ""
  return {
    savedPath,
    versioned,
    message: `Generated image saved to ${savedPath}${versionNote}.`,
  }
}

async function writeNonOverwrite(requestedPath: string, data: Uint8Array): Promise<string> {
  const directory = path.dirname(requestedPath)
  const extension = path.extname(requestedPath)
  const stem = path.basename(requestedPath, extension)
  for (let version = 1; version <= MAX_VERSION; version++) {
    const candidate = version === 1 ? requestedPath : path.join(directory, `${stem}-v${version}${extension}`)
    try {
      await writeFile(candidate, data, { flag: "wx" })
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  throw new Error(`Could not find a free output path for ${requestedPath}.`)
}
