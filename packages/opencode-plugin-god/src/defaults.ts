/**
 * Built-in prompt sources. Paths are URL-encoded and resolved against the
 * configured source base, so the plugin works without any user configuration.
 * Only model IDs that map to an existing file are listed; everything else
 * falls back to DEFAULT_FALLBACK_PATH.
 */
export const FALLBACK_MODEL_KEY = "*"

export const DEFAULT_SOURCE_BASE = "https://raw.githubusercontent.com/togg53192-cmd/jailbreaks/main/"

export const DEFAULT_MODEL_PATHS: Readonly<Record<string, string>> = {
  "big-pickle": "0x8D%20jailbreaks/BigPickle-opencode.md",
  "deepseek-v3": "DeepSeek/deepseek%20v3.md",
  "deepseek-v4.1-flash": "DeepSeek/deepseekv4.1%20and%20v4.1-1017.md",
  "gemini-4-argon": "Google/Gemini-4-Argon.md",
  "gemini-4-carbon": "Google/Gemini-4-Carbon.md",
  "glm-5.2": "Zhipu%20AI/glm-5.2.md",
  "glm-5.3-flash": "Zhipu%20AI/glm-5-3-flash.md",
  "grok-4.7": "xAI/grok-4.7.md",
  "grok-build-0.1": "xAI/Grok%20build.md",
  hy4: "Tencent/hy4-agents.md",
  "kimi-k2": "Moonshot%20AI/kimi-k2.md",
  "kimi-k3": "Moonshot%20AI/kimi-k3-agents.md",
  "longcat-2.5": "Meituan/longcat-agents.md",
  "longcat-2.5-preview": "Meituan/longcat-agents.md",
  "mimo-v2.6-pro": "Xiaomi/mimo-2.6-agents.md",
  "mistral-large-4": "Mistral/Mistral-Large-4.md",
  "muse-spark-1-3": "Meta/Muse%20spark%201.3.md",
  "muse-wonder": "Meta/Muse-wonder.md",
  "nemotron-3-ultra": "modemnakata/nemotron-3-ultra.md",
  "qwen4-max": "Alibaba/Qwen-4-max.md",
  "space-bunny": "Stealth%20Models/spacebunny-agents.md",
  "step-5-preview": "StepFun/Step-5-preview.md",
}

/** Matched in order when no exact model ID is present. */
export const DEFAULT_FAMILY_PATHS: ReadonlyArray<readonly [string, string]> = [
  ["claude-opus", "Anthropic/opus%20v2.md"],
  ["claude-sonnet", "Anthropic/Sonnet%20v2.md"],
]

export const DEFAULT_FALLBACK_PATH = "Stealth%20Models/Unified.md"
