# CLI

Use the CLI for day-to-day credential, auth, and runtime operations with the fastest feedback loop.  
Start with the common commands, then move to admin and troubleshooting commands as needed.

## Commands

The most common commands. All use the `aura` alias (or `npx auramaxx`).

| Command | Description |
|---------|-------------|
| `aura get <name>` | Read a credential (`--json` for full payload) |
| `aura set <name> <value>` | Create or update a secret |
| `aura list` | List credential names |
| `aura share <name>` | Create a shareable secret gist link |
| `aura inject <name> [-- <cmd>]` | Save to env var and optionally run command |
| `aura del <name>` | Delete a credential |

> **Note:** when `aura get` is authenticated via the local socket path, it verifies/decrypts the secret but does not export it to your parent shell env.
> For command injection (or custom env var names), use `aura inject <name> --env MY_VAR -- <your-command>`.

## Fast Path

If your agent is unlocked, secret reads work immediately via CLI or MCP:

```bash
aura get OURSECRET
# or
npx auramaxx get OURSECRET
```

## First Success (Run In Order)

```bash
aura status
aura list
aura set OURSECRET 123
aura get OURSECRET
aura share OURSECRET --expires-after 24h
```

If `status` fails, see [TROUBLESHOOTING.md](../how-to-auramaxx/TROUBLESHOOTING.md).
`status` checks both services: API server (`http://localhost:4242`) and dashboard UI (`http://localhost:4747`).

## Admin Commands

Essential admin commands for setup and maintenance.

| Command | Description |
|---------|-------------|
| `aura start` | Start Aura services (service-first bootstrap on default start) |
| `aura restart` | Restart Aura services (stop + start) |
| `aura status` | Check runtime health |
| `aura service <install\|status\|uninstall>` | Manage OS login auto-start registration |
| `aura init` | Advanced/recovery setup flow (most users should run `start`) |
| `aura nuke` | Destructive local reset (agents + DB + local state) |
| `aura mcp` | Start MCP server for Claude Code, Cursor, etc. |
| `aura skill` | Install AuraMaxx skills for Claude/Codex/OpenClaw |
| `aura auth` | Request/poll agent auth approvals |

Service backend by platform:
- macOS: `launchd`
- Linux: `systemd --user`
- Windows: Startup folder script (`%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup`)

Default `aura start` behavior:
- Prefers OS service orchestration (`install -> launch -> health check`) for default starts.
- If service install/bootstrap fails on first run, falls back to direct process start.
- If service is already installed but cannot launch/health-check, `start` exits with guidance instead of manually spawning a competing runtime.
- Explicit modes (`--debug`, `--dev`, `--headless`, `--background`) continue to use direct process startup.
- On every `start`, AuraMaxx runs best-effort skill sync (`aura skill --all --yes`) and MCP config sync (`aura mcp --install`) so installed clients stay updated.
- These startup syncs do not support env-based opt-out toggles.
- `start` does not auto-start cron. Run `aura cron` explicitly when needed.

Default `aura init` behavior:
- Uses the same service-first orchestration contract as default `aura start`.
- Explicit modes (`--debug`, `--dev`, `--background`) continue to use direct process startup for setup flows.
- `init` does not auto-start cron.

Run `aura --help --all` to see all commands including advanced admin (stop, lock, unlock, doctor, restore, etc.).

## Stopping Servers

```bash
aura stop
```

Stops all running AuraMaxx processes:

- **Wallet server** (`server/index.ts` on port 4242)
- **Dashboard** (`next start` on port 4747 when a production build is available; falls back to `next dev`)
- **Cron server** (`server/cron/index.ts`) only if it is running explicitly

Also cleans up temp files (CLI lock file, local IPC socket/pipe path).

This does **not** affect the MCP server — that runs in its own stdio process managed by the client (Claude Code, Cursor, etc.) that started it.

## Runtime Logs

When Aura services run in background/detached mode, runtime logs are streamed to:

- `.logs/server.log` (wallet API server)
- `.logs/dashboard.log` (Next.js dashboard)
- `.logs/cron.log` (only when `aura cron` is running)

For live tailing:

```bash
tail -f .logs/server.log .logs/dashboard.log
```

## Examples

```bash
# Check services
aura status

# Credentials
aura list                                                 # List credential names
aura get OURSECRET                                        # Read a credential
aura set OURSECRET 123                                    # Create or update a credential value
aura set GITHUB_LOGIN hunter2 --type login                # Store as login credential (password field)
aura share OURSECRET --expires-after 24h                  # Create a shareable secret gist link
aura del OURSECRET                                        # Delete a credential

# Inject secret into a command
aura inject OURSECRET --env HIDETHIS -- printenv HIDETHIS # Execute command with injected secret env var

# Auth and approvals
aura auth request --agent-id codex --profile dev
aura auth request --agent-id codex --profile dev --json             # default no-wait; includes reqId + approvalScope + claimAction + retryAction + ordered instructions
aura auth request --agent-id codex --profile dev --wait             # legacy wait/poll behavior
aura auth request --profile dev --action '{"endpoint":"/send","method":"POST","body":{"to":"0x...","amount":"0.01"}}'
aura auth claim <reqId> --json                                         # canonical claim path; auto-retries transient pending polls (default: 3 retries, 250ms interval)
aura auth claim <reqId> --pending-retries 8 --pending-retry-interval-ms 200 --json
aura get OURSECRET --reqId <reqId>                                     # strict retry path; fails with missing_or_expired_claim if claim not bound

# Advanced
aura api GET /health --no-auth                            # Call any API endpoint
aura doctor                                               # Run diagnostics
```

Sensitive output defaults:

- In local socket mode, `aura get` verifies/decrypts and prints a `SECRET DECRYPTED` banner; it does not persist env vars in your parent shell.
- In local socket mode, `aura get --danger-plaintext` prints the plaintext secret in terminal output (unsafe; avoid in shared/logged shells).
- Outside local socket mode, sensitive fields return encrypted output by default.
- To auto-decrypt sensitive output, set `AUTO_DECRYPT=true` and `AURA_AGENT_PASSWORD=<password>`.
- Approval-required JSON payloads now include typed action contracts:
  - `claimAction`: `{ transport: "cli", kind: "command", command }`
  - `retryAction`: `{ transport: "cli", kind: "command", command }`

## All Commands

Full list visible via `aura --help --all`. Summary:

| Command | Description |
|---------|-------------|
| `start` | Start Aura services (includes bootstrap/setup) |
| `restart` | Restart running servers (stop + start) |
| `stop` | Stop running servers |
| `status` | Check runtime health |
| `service` | Manage OS auto-start registration |
| `init` | Advanced/recovery setup flow |
| `nuke` | Destructive local reset (agents + DB + local state) |
| `unlock` / `lock` | Unlock or lock agents |
| `mcp` | Start MCP server for Claude Code, Cursor, etc. |
| `skill` | Install AuraMaxx skills for agents |
| `auth` | Request/poll agent auth approvals |
| `actions` | Internal: human actions and token management (use `auth` instead) |
| `approve` | Admin-only shortcut: approve a pending action by id |
| `api` | Call any wallet API endpoint from CLI |
| `doctor` | Run diagnostics |
| `restore` | Restore backup + run migrations |
| `app` | Manage installed apps |
| `apikey` | List/validate/set/delete API keys |
| `env` | Load env vars from agent via .aura file |
| `shell-hook` | Auto-load .aura env vars on cd (like direnv) |
| `experimental` | Toggle dev feature flags |
| `cron` | Run cron server standalone |
| `secret` | Run commands with injected secret env vars |
| `release-check` | Run pre-release checklist (diff audit, sanity, privacy scan, security routes) |
| `token` | Preview profile-based token policy |
| `wallet` | Wallet API wrappers (status, assets, swap, send, fund) |

## Next Steps

- Builder / AI integration -> [MCP.md](./MCP.md)
- Operator / Security -> [security.md](../why-auramaxx/security.md)
