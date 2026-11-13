export const INTEGRATION_ID = "opencode"
export const DEFAULT_SERVER = "https://opencode.ai/console"
export const REQUEST_TIMEOUT_MS = 10_000
export const REQUEST_CONCURRENCY = 3

export type ConnectionLike =
  | { readonly type: "credential"; readonly id: string; readonly label: string }
  | { readonly type: "env"; readonly name: string }

export type CredentialLike =
  | {
      readonly type: "oauth"
      readonly access: string
      readonly metadata?: Record<string, unknown>
    }
  | {
      readonly type: "key"
      readonly key: string
      readonly metadata?: Record<string, unknown>
    }
  | {
      readonly type: "external"
      readonly metadata?: Record<string, unknown>
    }

export interface UsageSource {
  get(input: { readonly integrationID: string }): Promise<{ readonly connections: ReadonlyArray<ConnectionLike> } | undefined>
  active(): Promise<ConnectionLike | undefined>
  resolve(connection: ConnectionLike): Promise<CredentialLike | undefined>
}

export type Meter = {
  readonly percent: number
  readonly limited: boolean
  readonly resetsAt: number
}

export type Usage = {
  readonly rolling: Meter
  readonly weekly: Meter
  readonly monthly: Meter
}

export type AccountState = "ok" | "not_subscribed" | "needs_auth" | "unsupported" | "error"

export type AccountRef = {
  readonly id: string
  readonly label: string
  readonly active: boolean
}

export type AccountUsage = AccountRef & {
  readonly state: AccountState
  readonly workspace?: { readonly id: string; readonly name?: string }
  readonly usage?: Usage
  readonly error?: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type UsageDependencies = {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly concurrency?: number
}

export async function listAccountRefs(source: UsageSource): Promise<AccountRef[]> {
  const connections = await readConnections(source)
  const active = await activeID(source)
  return sortAccounts(
    connections.map((connection) => ({
      id: connection.id,
      label: labelFor(connection),
      active: connection.id === active,
    })),
  )
}

export async function listAccountUsage(
  source: UsageSource,
  dependencies: UsageDependencies = {},
): Promise<AccountUsage[]> {
  const connections = await readConnections(source)
  const active = await activeID(source)
  const accounts = await mapLimit(connections, dependencies.concurrency ?? REQUEST_CONCURRENCY, (connection) =>
    readAccount(source, connection, connection.id === active, dependencies),
  )
  return sortAccounts(accounts)
}

export function normalizeServer(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_SERVER
  const server = raw.replace(/^https:\/\/console\.opencode\.ai(?=\/|$)/, DEFAULT_SERVER)
  const url = new URL(server)
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported Console server")
  return server
}

export function parseUsage(value: unknown): Usage {
  if (!isRecord(value) || !isRecord(value.usage)) throw new Error("OpenCode Go returned an unexpected usage response")
  return {
    rolling: parseMeter(value.usage.rolling),
    weekly: parseMeter(value.usage.weekly),
    monthly: parseMeter(value.usage.monthly),
  }
}

async function readConnections(source: UsageSource) {
  const integration = await source.get({ integrationID: INTEGRATION_ID })
  return (integration?.connections ?? []).filter(isCredential)
}

async function activeID(source: UsageSource) {
  try {
    const active = await source.active()
    return active?.type === "credential" ? active.id : undefined
  } catch {
    return undefined
  }
}

async function readAccount(
  source: UsageSource,
  connection: Extract<ConnectionLike, { type: "credential" }>,
  active: boolean,
  dependencies: UsageDependencies,
): Promise<AccountUsage> {
  const base = { id: connection.id, label: labelFor(connection), active }
  let credential: CredentialLike | undefined
  try {
    credential = await source.resolve(connection)
  } catch {
    return {
      ...base,
      state: "needs_auth",
      error: "OpenCode Console sign-in is unavailable. Use /connect to sign in again.",
    }
  }
  if (!credential) {
    return { ...base, state: "error", error: "This credential is no longer available." }
  }
  if (credential.type === "external") {
    return { ...base, state: "unsupported", error: "External credentials do not expose an OpenCode Go workspace." }
  }

  const workspaceID = metadataString(credential.metadata, "orgID")
  if (!workspaceID) {
    return { ...base, state: "unsupported", error: "This account has no OpenCode Console workspace." }
  }
  const workspace = {
    id: workspaceID,
    ...(metadataString(credential.metadata, "orgName")
      ? { name: metadataString(credential.metadata, "orgName") }
      : {}),
  }

  let server: string
  try {
    server = normalizeServer(credential.metadata?.server)
  } catch (error) {
    return { ...base, workspace, state: "error", error: message(error) }
  }

  try {
    const usage = await requestUsage(server, workspaceID, credential, dependencies)
    return { ...base, workspace, state: "ok", usage }
  } catch (error) {
    const failure = error instanceof UsageRequestError ? error : new UsageRequestError("error", message(error))
    return { ...base, workspace, state: failure.state, error: failure.message }
  }
}

async function requestUsage(
  server: string,
  workspaceID: string,
  credential: CredentialLike,
  dependencies: UsageDependencies,
): Promise<Usage> {
  if (credential.type === "external") throw new UsageRequestError("unsupported", "External credentials are not supported.")
  const token = credential.type === "oauth" ? credential.access : credential.key
  const url = `${new URL(server).origin}/zen/go/v1/usage`
  const timeout = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS
  const fetchImpl = dependencies.fetch ?? fetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "x-opencode-org-id": workspaceID,
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    throw new UsageRequestError("error", timedOut ? "Usage request timed out." : "Could not reach OpenCode Go usage.")
  }

  if (response.status === 403) {
    throw new UsageRequestError("not_subscribed", "No OpenCode Go subscription on this workspace.")
  }
  if (response.status === 401) {
    throw new UsageRequestError("needs_auth", "OpenCode Console sign-in is unavailable. Use /connect to sign in again.")
  }
  if (!response.ok) {
    throw new UsageRequestError("error", `OpenCode Go usage returned HTTP ${response.status}.`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new UsageRequestError("error", "OpenCode Go returned an unreadable usage response.")
  }
  try {
    return parseUsage(body)
  } catch (error) {
    throw new UsageRequestError("error", message(error))
  }
}

function parseMeter(value: unknown): Meter {
  if (!isRecord(value)) throw new Error("OpenCode Go returned an invalid usage meter")
  if (value.status !== "ok" && value.status !== "rate-limited") {
    throw new Error("OpenCode Go returned an invalid usage status")
  }
  if (typeof value.percent !== "number" || !Number.isFinite(value.percent)) {
    throw new Error("OpenCode Go returned an invalid usage percentage")
  }
  const resetsAt =
    typeof value.resetsAt === "number"
      ? value.resetsAt
      : typeof value.resetsAt === "string"
        ? Date.parse(value.resetsAt)
        : Number.NaN
  if (!Number.isFinite(resetsAt)) throw new Error("OpenCode Go returned an invalid reset time")
  return {
    percent: Math.max(0, Math.min(100, value.percent)),
    limited: value.status === "rate-limited",
    resetsAt,
  }
}

class UsageRequestError extends Error {
  constructor(
    readonly state: AccountState,
    message: string,
  ) {
    super(message)
  }
}

function labelFor(connection: Extract<ConnectionLike, { type: "credential" }>) {
  return connection.label.trim() || "OpenCode Console"
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isCredential(connection: ConnectionLike): connection is Extract<ConnectionLike, { type: "credential" }> {
  return connection.type === "credential"
}

function sortAccounts<T extends AccountRef>(accounts: T[]) {
  return accounts.toSorted(
    (left, right) =>
      Number(right.active) - Number(left.active) ||
      left.label.localeCompare(right.label) ||
      left.id.localeCompare(right.id),
  )
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const width = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : REQUEST_CONCURRENCY
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await run(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "OpenCode Go usage is unavailable."
}
