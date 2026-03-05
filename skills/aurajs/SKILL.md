# AuraJS Skill

Use this skill when building or modifying AuraJS games.

## Read First
- `api-contract.md` (2D/core surface)
- `api-contract-3d.md` (3D surface)

Do not load these files end-to-end by default.
Use targeted reads: jump to the exact namespace/method you are touching, then apply that contract strictly.

## Contract Workflow
1. Identify the APIs your change touches.
2. Search the relevant contract file for those APIs.
3. Read only those sections and follow signature + validation + error semantics.
4. If examples conflict with contract docs, contract docs win.

## Build Loop
1. Implement the smallest playable mechanic in `src/main.js`.
2. Run `npm run dev` for fast iteration.
3. Validate release behavior with `npm run play`.
4. Publish with `npm run publish` when the package is ready.

## Scaffold Contract
- Use `aura create <name> --template <2d-shooter|3d-platformer|blank>`.
- Aliases accepted by CLI: `2d`, `3d`, `shooter`, `platformer`, `platformers`, `blank`.
- `2d-shooter` and `3d-platformer` scaffolds include `src/starter-utils/` shared modules.
- `blank` intentionally omits `starter-utils` so agents can start from minimal boilerplate.

### Starter-Utils Modules
- `src/starter-utils/core.js`: clamp, input axes, cooldowns, interval spawners, collision primitives.
- `src/starter-utils/wave-director.js`: wave scheduling loop for enemy spawn orchestration.
- `src/starter-utils/enemy-archetypes-2d.js`: enemy archetype catalog + spawn helpers for 2D.
- `src/starter-utils/platformer-3d.js`: checkpoints, goal zones, and moving platform helpers for 3D.

Agents should default to extending these modules before adding one-off utility functions in `src/main.js`.

## Engine Guardrails
- Put initialization in `aura.setup`.
- Put frame-step logic in `aura.update(dt)`.
- Put rendering in `aura.draw`.
- Keep rendering API calls in draw-only paths.
- Use `aura.window.getSize()` for runtime layout.
- Clamp player/world values to avoid drift.

## Vibe Coding Defaults
- Start with one loop and one strong interaction.
- Add juice after core feel works: camera, hit feedback, audio, score.
- Keep systems loosely coupled so AI agents can modify one mechanic at a time.

## Suggested Project Structure
- `src/main.js`: primary loop and gameplay systems.
- `src/starter-utils/`: reusable gameplay helpers for scaffold templates.
- `assets/`: sprites, audio, fonts.
- `skills/`: agent workflows and contract references.
