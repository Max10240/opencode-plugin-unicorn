export const toolDescriptions = {
  image_gen: "Generate or edit one image and save it to a file without overwriting existing files.",
  show_img:
    "Show a server-side image to the user without adding it to model context. Supports PNG, JPEG, GIF and WebP up to 20 MiB.",
  send_message_across_sessions:
    "Send a user message to another online OpenCode session. Use only for cross-session messaging; never between a main agent and its subagents.",
  decrypt_sensitive:
    "Decrypt a single ocsec1 file under $TMPDIR into a new file with the configured private key only when the user explicitly requests it. Never output plaintext or key material; always write the result to out and report only its path. Keep out under $TMPDIR.",
  sensitive_key_info: "Show the configured public key and fingerprint without exposing private key material.",
  list_online_sessions: "List other online OpenCode sessions across working directories.",
  register_sensitive_file:
    "Register an existing file as protected. The file is read locally for redaction; its contents are never output.",
}
