import os from "node:os"
import path from "node:path"

export function e2eEnvironment(
  input: { root: string; configDirectory: string; password: string; isMaxSelf?: string },
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: parent.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
    TMPDIR: parent.TMPDIR ?? os.tmpdir(),
    LANG: parent.LANG ?? "en_US.UTF-8",
    ...(parent.SystemRoot ? { SystemRoot: parent.SystemRoot } : {}),
    OPENCODE_CONFIG_DIR: input.configDirectory,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DB: path.join(input.root, "opencode.db"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENAI_API_KEY: "e2e-image-key",
    OPENCODE_PASSWORD: input.password,
    OPENCODE_TEST_HOME: input.root,
    HOME: input.root,
    XDG_CONFIG_HOME: path.join(input.root, "xdg-config"),
    XDG_DATA_HOME: path.join(input.root, "xdg-data"),
    XDG_CACHE_HOME: path.join(input.root, "xdg-cache"),
    XDG_STATE_HOME: path.join(input.root, "xdg-state"),
  }
  if (input.isMaxSelf !== undefined) environment.IS_MAX_SELF = input.isMaxSelf
  return environment
}
