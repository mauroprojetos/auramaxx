# AuraJS API Contract (Complete)

This is the combined external contract reference for AuraJS.

Use this as the single-file source when you want one document for prompts, integrations, or onboarding.

## Contract Index

- Core contract: `docs/external/contract-core.md`
- 3D contract: `docs/external/contract-3d.md`

## Runtime Model

- JavaScript defines game logic and state.
- AuraJS native host executes rendering, input, audio, and platform integration.
- Build targets are native desktop outputs for macOS, Linux, and Windows.

## Core Surface Summary

### Lifecycle

```js
aura.setup = async function () {}
aura.update = function (dt) {}
aura.draw = function () {}
aura.onResize = function (w, h) {}
aura.onFocus = function () {}
aura.onBlur = function () {}
```

### Window

```js
aura.window.setTitle("My Game")
aura.window.setSize(1280, 720)
aura.window.setFullscreen(false)
aura.window.getSize()
aura.window.getPixelRatio()
aura.window.getFPS()
```

### Input

```js
aura.input.isKeyDown("arrowright")
aura.input.isKeyPressed("space")
aura.input.isKeyReleased("escape")
```

### Draw2D

```js
aura.draw2d.clear(20, 20, 30)
aura.draw2d.rectFill(100, 100, 120, 80, aura.rgb(1, 0, 0))
aura.draw2d.sprite(aura.assets.image("player.png"), 320, 240)
aura.draw2d.text("Hello", 24, 24, { size: 18, color: aura.Color.WHITE })
```

### Assets, Audio, Storage

```js
await aura.assets.load(["player.png", "theme.ogg"])
aura.audio.play("theme.ogg", { loop: true, volume: 0.7 })
aura.storage.save("save1", { level: 3, score: 4200 })
const save = aura.storage.load("save1")
```

### Math, Timer, Collision

```js
aura.math.clamp(value, 0, 1)
aura.math.lerp(a, b, t)
aura.timer.after(1.0, () => {})
aura.timer.every(0.5, () => {})
aura.collision.rectRect(ax, ay, aw, ah, bx, by, bw, bh)
aura.collision.circleCircle(ax, ay, ar, bx, by, br)
```

## 3D Surface Summary

### Camera

```js
aura.camera3d.setPosition(0, 2, 6)
aura.camera3d.lookAt(0, 1, 0)
aura.camera3d.setFov(60)
aura.camera3d.setNearFar(0.1, 1000)
```

### Lights

```js
aura.light.setAmbient(0.2, 0.2, 0.25)
aura.light.setDirectional({
  direction: [0.3, -1.0, 0.2],
  color: [1.0, 0.98, 0.9],
  intensity: 1.0,
})
```

### Mesh, Material, Draw3D

```js
const cube = aura.mesh.cube({ size: 1 })
const mat = aura.material.standard({
  baseColor: [0.9, 0.2, 0.2, 1.0],
  metallic: 0.2,
  roughness: 0.7,
})

aura.draw3d.beginFrame()
aura.draw3d.drawMesh(cube, mat, {
  position: [0, 0, 0],
  rotation: [0, aura.time.now(), 0],
  scale: [1, 1, 1],
})
aura.draw3d.endFrame()
```

## Optional Modules

Optional namespaces require explicit config enablement:

- `modules.physics`
- `modules.network`
- `modules.multiplayer`

When disabled, related calls return deterministic guidance errors.

## Versioning

- This file is the complete external contract view.
- Detailed split references remain in:
  - `contract-core.md`
  - `contract-3d.md`
- Breaking API changes should ship with explicit contract updates.
