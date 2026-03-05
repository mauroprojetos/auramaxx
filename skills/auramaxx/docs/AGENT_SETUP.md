# Agent Setup

Set up AuraMaxx by installing skills or MCP config for your client, then verify with one successful command.  
If setup fails, go directly to [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

Easiest path: install the skill in your workspace.

```bash
# set up globally for common agents
npx -y auramaxx skill

cd <your-codebase>
npx -y skills add Aura-Industry/auramaxx
```

---

## What are you using?

| Client | Setup |
|--------|-------|
| 🦞 OpenClaw | [Skills](#skills) |
| 🤖 Claude Code | [Skills](#skills) |
| 📟 Codex CLI | [Skills](#skills) |
| 🖥️ Claude Desktop | [MCP](#mcp) |
| 🖱️ Cursor IDE | [MCP](#mcp) |
| 🏄 Windsurf | [MCP](#mcp) |
| 🚀 Antigravity | [MCP](#mcp) |
| 🔌 VS Code + Continue | [MCP](#mcp) |
| 🧩 Any MCP client | [MCP](#mcp) |

---

## Skills

Skills give your agent built-in knowledge of AuraMaxx commands and workflows.

Install all at once:

```bash
auramaxx skill
```

In an interactive terminal, `auramaxx skill` shows an arrow-key selector
(`all compatible agents`, `codex only`, `claude only`, `openclaw only`, `cancel`)
with `all compatible agents` as default.

Or install per client:

### 🤖 Claude Code

```bash
auramaxx skill --claude

# Or manually, from your project:
mkdir -p .claude/skills
cd .claude/skills
npx -y skills add Aura-Industry/auramaxx
```

Installs to `~/.claude/skills/auramaxx`.

### 📟 Codex CLI

```bash
auramaxx skill --codex

# Or manually, from anywhere:
mkdir -p ~/.codex/skills
cd ~/.codex/skills
npx -y skills add Aura-Industry/auramaxx
```

Installs to `~/.codex/skills/auramaxx`.

### 🦞 OpenClaw

```bash
auramaxx skill --openclaw

# Or manually, install globally for all OpenClaw agents:
mkdir -p ~/.openclaw/skills
cd ~/.openclaw/skills
npx -y skills add Aura-Industry/auramaxx
```

Installs to `~/.openclaw/skills/auramaxx`.
OpenClaw resolves workspace-local `skills/` first; for shared skills across agents, keep this in `~/.openclaw/skills` and avoid same-name workspace copies.

### Other clients

```bash
cd <your-codebase>
npx -y skills add Aura-Industry/auramaxx
```

### Verify

```bash
auramaxx skill --doctor
```

---

## MCP

MCP gives your agent direct tool access to the agent (read secrets, write secrets, manage wallets). If your client supports [Skills](#skills), use those instead — they're simpler and don't require a running server connection.

Auto-configure all detected clients at once:

```bash
auramaxx mcp --install
```

Or paste this config block into your client's MCP config:

```json
{
  "mcpServers": {
    "auramaxx": {
      "command": "npx",
      "args": ["auramaxx", "mcp"]
    }
  }
}
```

### 🤖 Claude Code

```bash
claude mcp add auramaxx -- npx auramaxx mcp
```

### 📟 Codex CLI

```bash
codex mcp add auramaxx -- npx auramaxx mcp
```

### Where to paste the config block

- 🖥️ **Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- 🖱️ **Cursor IDE** — MCP settings JSON editor
- 🏄 **Windsurf** — `~/.windsurf/mcp.json`
- 🔌 **VS Code + Continue** — `.vscode/mcp.json` in your project
- 🦞 **OpenClaw** — add stdio server `npx auramaxx mcp` in MCP settings

Restart your client after saving.

---

## Verify

```bash
auramaxx get OURSECRET
```

Then ask your agent:

`Use auramaxx skill to get OURSECRET.`

---

## Agent Approval Workflow

Use this flow whenever a tool call returns `requiresHumanApproval: true`:

1. Agent shows `approveUrl` to human.
2. Human approves in dashboard.
3. Agent claims by `reqId`:
   - CLI: `auramaxx auth claim <reqId> --json`
   - MCP: call `get_token` with `{ "reqId": "<reqId>" }`
4. Agent retries original command:
   - Temp token flow: include `--reqId <reqId>` once.
   - Session token flow: retry immediately; future calls can omit `reqId`.

---

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
