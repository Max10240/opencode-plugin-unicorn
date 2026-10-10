import { rm } from "node:fs/promises"

for (const name of ["global-config.js", "global-config.d.ts"]) {
  await rm(new URL(`./dist/src/${name}`, import.meta.url), { force: true })
}
