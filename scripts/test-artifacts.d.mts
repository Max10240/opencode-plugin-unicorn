export type InstallArchive = {
  manifest: { name: string; version: string; [key: string]: any }
  file: string
}
export type Archive = InstallArchive & {
  directory: string
  packed: { filename: string; version: string; files: Array<{ path: string }> }
}
type Run = (args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean }) => Promise<string>
type Lease = { root: string; fingerprint: string; archives?: Array<Archive & { digest: string }> }
type Manifest = { name: string; private: boolean; dependencies: Record<string, string> }
export function ensureBuilt(root?: string, options?: { env?: NodeJS.ProcessEnv; run?: Run }): Promise<Lease>
export function verifyBuild(root: string, manifest: Lease): Promise<void>
export function packWorkspace(destination: string, options?: { root?: string; env?: NodeJS.ProcessEnv; run?: Run }): Promise<Archive[]>
export function dependencyKey(archives: InstallArchive[], runtime: Record<string, unknown>): string
export function archivePackage(archives: InstallArchive[], install: string): Promise<Manifest>
export function refreshLocalIntegrities(lock: any, archives: InstallArchive[], manifest: Manifest): Promise<any>
export function installerEnvironment(install: string, parent?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function installArchives(archives: InstallArchive[], install: string, options?: { cache?: string; fresh?: boolean; run?: Run; runtime?: Record<string, unknown> }): Promise<{ cached: boolean; key: string }>
