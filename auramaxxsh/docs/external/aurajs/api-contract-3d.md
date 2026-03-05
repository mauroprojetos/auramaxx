# AuraJS 3D API Contract

This is the external API contract for AuraJS 3D surfaces.

## Scope

3D contract covers:
- scene camera and lighting setup
- mesh and material creation
- draw3d submission from JavaScript

## Camera

```js
aura.camera3d.setPosition(0, 2, 6)
aura.camera3d.lookAt(0, 1, 0)
aura.camera3d.setFov(60)
aura.camera3d.setNearFar(0.1, 1000)
```

## Lights

```js
aura.light.setAmbient(0.2, 0.2, 0.25)
aura.light.setDirectional({
  direction: [0.3, -1.0, 0.2],
  color: [1.0, 0.98, 0.9],
  intensity: 1.0,
})
```

## Mesh and Material

```js
const cube = aura.mesh.cube({ size: 1 })
const mat = aura.material.standard({
  baseColor: [0.9, 0.2, 0.2, 1.0],
  metallic: 0.2,
  roughness: 0.7,
})
```

## Rendering

```js
aura.draw3d.beginFrame()
aura.draw3d.drawMesh(cube, mat, {
  position: [0, 0, 0],
  rotation: [0, aura.time.now(), 0],
  scale: [1, 1, 1],
})
aura.draw3d.endFrame()
```

## Runtime Notes

- AuraJS uses native GPU backends through `wgpu`.
- JavaScript controls game logic and scene state.
- Native runtime handles GPU execution and platform integration.

## Versioning

This external 3D contract tracks the public AuraJS 3D surface.
Behavioral or signature changes are released as explicit contract updates.
