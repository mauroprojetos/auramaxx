# Open-source game engine in your terminal

Work in progress.

Open-source packages to brainrot auramaxx with your agent while vibecoding.

## Packages

<!--
### [`auramaxxsh/`](./auramaxxsh)

**The open-source Apple Keychain for your agent.** Securely share passwords, API keys, and credit cards with any AI agents. Set up once, use everywhere — works across Claude Code, Cursor, Codex, OpenClaw, and any MCP and Skills compatible agent.

```bash
npx auramaxx
```
-->

### [@auraindustry/aurajs](https://www.npmjs.com/package/@auraindustry/aurajs) (work in progress)

**Game engine from your terminal.** Just `auramaxx play <mygame>` to play.

Website: [aurajs.gg](https://aurajs.gg)

```bash
npm install -g auramaxx
auramaxx create my-game
cd my-game
npm run dev

# play an example
auramaxx play aurasu

# or
npx aurasu play
```

| Platform | Package |
|----------|---------|
| macOS ARM | [`@aurajs/darwin-arm64`](https://github.com/Aura-Industry/aurajs-darwin-arm64) |
| macOS x64 | [`@aurajs/darwin-x64`](https://github.com/Aura-Industry/aurajs-darwin-x64) |
| Linux x64 | [`@aurajs/linux-x64`](https://github.com/Aura-Industry/aurajs-linux-x64) |
| Windows x64 | [`@aurajs/win32-x64`](https://github.com/Aura-Industry/aurajs-win32-x64) |

### [`examples/`](./examples)

Example games built with AuraMaxxJS.

### [`skills/`](./skills)

Agent skills for AuraMaxx (Claude Code, Codex, OpenClaw).
