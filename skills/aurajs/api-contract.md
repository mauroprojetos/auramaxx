# AuraJS Core API Contract

This is the external API contract for AuraJS core runtime surfaces.

## Scope

Core contract covers:
- lifecycle callbacks
- window and input APIs
- 2D rendering APIs
- assets, audio, storage, timer, math, collision
- platform helpers exposed to game code

This contract is for public integration and day-to-day game development.

## Lifecycle

AuraJS calls these when present:

```js
aura.setup = async function () {}
aura.update = function (dt) {}
aura.draw = function () {}
aura.onResize = function (w, h) {}
aura.onFocus = function () {}
aura.onBlur = function () {}
```

## Window

```js
aura.window.setTitle("My Game")
aura.window.setSize(1280, 720)
aura.window.setFullscreen(false)
aura.window.getSize()      // { width, height }
aura.window.getPixelRatio()
aura.window.getFPS()
```

## Input

```js
aura.input.isKeyDown("arrowright")
aura.input.isKeyPressed("space")
aura.input.isKeyReleased("escape")
```

## Draw2D

```js
aura.draw2d.clear(20, 20, 30)
aura.draw2d.rectFill(100, 100, 120, 80, aura.rgb(1, 0, 0))
aura.draw2d.sprite(aura.assets.image("player.png"), 320, 240)
aura.draw2d.text("Hello", 24, 24, { size: 18, color: aura.Color.WHITE })
```

## Assets and Audio

```js
await aura.assets.load(["player.png", "theme.ogg"])
const image = aura.assets.image("player.png")
aura.audio.play("theme.ogg", { loop: true, volume: 0.7 })
```

## Storage

```js
aura.storage.save("save1", { level: 3, score: 4200 })
const save = aura.storage.load("save1")
```

## Math and Timer

```js
aura.math.clamp(value, 0, 1)
aura.math.lerp(a, b, t)
aura.timer.after(1.0, () => {})
aura.timer.every(0.5, () => {})
```

## Collision

```js
aura.collision.rectRect(ax, ay, aw, ah, bx, by, bw, bh)
aura.collision.circleCircle(ax, ay, ar, bx, by, br)
```

## Optional Modules

Optional namespaces are available only when enabled in config:
- `modules.physics`
- `modules.network`
- `modules.multiplayer`

If disabled, calls return deterministic guidance errors.

## Versioning

This external contract is stable for current AuraJS docs.
Breaking API changes are introduced only with explicit versioned updates.
