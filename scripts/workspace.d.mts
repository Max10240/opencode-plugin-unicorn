export const BUILD_MANIFEST: "UNICORN_TEST_BUILD_MANIFEST"
export type WorkspacePackage = { directory: string; manifest: { name: string; version: string; [key: string]: any } }
export function workspacePackages(root: string): Promise<WorkspacePackage[]>
export function buildLevels<T extends { manifest: { name: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } }>(packages: T[]): T[][]
export function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]>
export function treeFiles(directory: string, excluded?: Set<string>): Promise<string[]>
export function buildFingerprint(root: string): Promise<string>
