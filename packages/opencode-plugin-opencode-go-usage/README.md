# @max10240/opencode-plugin-opencode-go-usage

Show OpenCode Go usage for **every OpenCode Console account** signed in to the current server.

## Usage

Install the plugin and open the TUI command:

```text
/usage-opencode-go
```

The dialog shows, for each account:

- 5-hour allowance (`rolling`)
- weekly allowance
- monthly total allowance

Each window shows the used and remaining percentage, a progress bar, and its reset time in local time. The active
account is marked and listed first. A warning line appears when any window is at or above 90% but not yet limited.
Press `?` for keyboard help and `r` to refresh.

The command is enabled by default only when the current OpenCode server has an `opencode` credential. Adding an
account with `/connect` enables it without restarting; removing the last account hides it again.

## Options

```jsonc
{
  "plugins": [{
    "package": "@max10240/opencode-plugin-opencode-go-usage",
    "options": {
      "enabled": "auto",
      "keybind": false
    }
  }]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `"auto"` | `"auto"` enables the command when an OpenCode Console credential exists. `true` always enables it; `false` disables the plugin. |
| `keybind` | `false` | Optional keyboard shortcut for the command. There is no default binding. |

The standalone plugin also honors `features.opencodeGoUsage: false`. In Unicorn, use
`features.opencodeGoUsage: false` instead.

## Accounts and privacy

OpenCode stores credentials in the server's SQLite database. Multiple OpenCode Console accounts can coexist there;
only one is active. This plugin reads all of them and queries each account's Go allowance independently.

- Tokens stay in the server plugin. The TUI only receives account labels, workspaces, percentages, and reset times.
- Expired OAuth credentials are refreshed through OpenCode's credential API.
- `auth.json` is only a legacy import source and is not read directly. Add accounts through `/connect` in the same
  server to make them visible here.
- One unavailable account does not hide the others.

## Scope

This plugin shows the Go allowance only. It does not show OpenCode Console dollar budgets or model budgets; use the
built-in `/usage` command for those. The Go usage endpoint is an internal OpenCode endpoint and may change.
