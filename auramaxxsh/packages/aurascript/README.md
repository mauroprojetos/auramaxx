# AuraJS

> **Alpha status:** AuraJS is currently in alpha. It is not safe for production use yet.

Publish and play directly from your terminal.

Write one JavaScript game and build native binaries for macOS, Linux, and Windows.

```bash
npx auramaxx play <mygame>
```

## Install

```bash
npm install -g auramaxx
```

## Create a New Game

```bash
auramaxx create my-game
# or
aura create my-game
cd my-game
npm run dev
```

## Play a Game

```bash
auramaxx play aurasu
# or
npx aurasu play
```

## Publish and Play Your Game

In a scaffolded AuraJS game, use:

```bash
# publish (alias to: npx auramaxx publish)
npm run publish

# run your packaged game entrypoint
npm run play
```

Default package naming follows `aurajs/<yourname>` (published as `@aurajs/<yourname>` unless you change it).

## Platform Packages

| Platform | Package |
|----------|---------|
| macOS ARM | [`@aurajs/darwin-arm64`](https://github.com/Aura-Industry/aurajs-darwin-arm64) |
| macOS x64 | [`@aurajs/darwin-x64`](https://github.com/Aura-Industry/aurajs-darwin-x64) |
| Linux x64 | [`@aurajs/linux-x64`](https://github.com/Aura-Industry/aurajs-linux-x64) |
| Windows x64 | [`@aurajs/win32-x64`](https://github.com/Aura-Industry/aurajs-win32-x64) |

## API Docs

- Core API: [`docs/api-contract-v1.md`](./docs/api-contract-v1.md)
- 3D API: [`docs/api-contract-3d-v2.md`](./docs/api-contract-3d-v2.md)

# Why AuraJS

**Write JS. Ship native.**

Everything Unity and C++ give you: native GPU rendering, real binaries, platform APIs, with the language 20 million developers already know.

---

## Features

JS handles logic, native handles performance. No compromises on either side.

### Sub-second hot reload

Save your file, game restarts instantly. No compile step, no domain reload. Unity takes 5 to 30 seconds per change. AuraJS takes less than one.

### Native GPU rendering

`wgpu` talks directly to Vulkan, Metal, and DirectX 12. No browser, no ANGLE translation, no compositor. Real draw calls to real drivers.

### 2MB binaries

An empty Unity game ships at 50 to 100MB. AuraJS ships at the size of your assets plus a ~5MB runtime. Games download in seconds.

### State is JSON

Game state is plain JS objects. Save games, multiplayer sync, replays, spectating, and modding are straightforward because your data is already serializable.

### AI-native API

Flat global API, no class hierarchies, no imports. An AI agent can hold the entire API in context and generate a complete working app in one prompt.

### Platform built in

Wallet, social, auth, credential vault, cloud saves, all from `aura.platform.*`. Zero integration work. No third-party SDKs.

### KB-sized patches

Updates swap the JS bundle, not the binary. Game updates go from hundreds of megabytes to kilobytes. Push fixes in seconds.

### Mods are free

The game is JS. Mods are JS. Users write mods in the same language the game is written in. No Lua bridge, no plugin framework. It just works.

### 20 million developers

JS is the most widely known programming language on earth. Your platform's potential developer pool dwarfs Unity's C# or C++ ecosystems.

### Multiplayer is sync JSON

State is already plain objects. Multiplayer is sending those objects. No Netcode framework, no Mirror, no RPC system. Sync your state, done.

### Zero config builds

No `cmake`, no webpack, no build system. `aura build` outputs a native binary. No toolchain, no SDK, no Rust installation required.

---

## AuraJS vs the alternatives

|  | AuraJS | Unity | C / C++ | Electron |
|---|---|---|---|---|
| Hot reload | **<1s** | 5-30s | recompile | <1s |
| Min binary size | **~2 MB** | ~80 MB | ~1 MB | ~150 MB |
| GPU access | **native** | native | native | WebGL |
| Developer pool | **20M+** | 5M | 3M | 20M+ |
| AI code gen quality | **excellent** | decent | poor | decent |
| Multiplayer | **sync JSON** | Netcode | custom | sync JSON |
| Modding | **native** | framework | Lua/etc | native |
| Patch size | **KBs** | MBs-GBs | full binary | KBs |
| Platform APIs | **built in** | - | - | - |
| Vendor lock-in | **none** | heavy | none | Chromium |
| Build config | **zero** | editor | cmake | webpack |

---

## This is a complete game

One file. No imports. No config. No build step. Just logic.

```js
let x = 400, y = 300, speed = 200

aura.setup = async function () {
  await aura.assets.load(["player.png", "coin.wav"])
}

aura.update = function (dt) {
  if (aura.input.isDown("arrowright")) x += speed * dt
  if (aura.input.isDown("arrowleft"))  x -= speed * dt
  if (aura.input.isDown("arrowup"))    y -= speed * dt
  if (aura.input.isDown("arrowdown"))  y += speed * dt
}

aura.draw = function () {
  aura.draw2d.clear(20, 20, 30)
  aura.draw2d.image(aura.assets.image("player.png"), x, y)
  aura.draw2d.text(`Position: ${x}, ${y}`, 10, 10, {
    color: aura.colors.white, size: 16
  })
}
```

---

## Get started

```bash
# install
npm install -g auramaxx

# create
auramaxx create my-game && cd my-game

# run
npm run dev
```
