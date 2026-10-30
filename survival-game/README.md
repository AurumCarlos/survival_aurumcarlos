# Low-Poly Survival — engine architecture

Browser survival game: Three.js rendering, cannon-es physics, TypeScript strict, ECS architecture.
Runs with **zero downloaded assets** — every mesh is procedural low-poly geometry, and any `.glb`
you add to `public/assets/` replaces it.

```bash
npm install
npm run dev             # play at http://localhost:5173
npm test                # headless checks: survival balance + refactor systems (no browser needed)
npm run typecheck       # full strict type-check
npm run typecheck:core  # proves the simulation layer has no Three/Cannon imports
```

Controls use physical key positions (`KeyboardEvent.code`), so **WASD lands on ZQSD on AZERTY**.
Shift sprint · C crouch · Space jump · hold E harvest · I/Tab inventory · 1–6 hotbar ·
LMB swing · RMB throw spear · B build mode (R/wheel piece, LMB place, X demolish) · E door · Esc or P pause.

## Folder architecture

```
src/
  app/         App (composition root + state orchestration), GameStateMachine, GameSession
  core/        Engine-free runtime: ECS World, GameLoop, Input, Lifecycle, ObjectPool,
               SpatialHash, EventBus, TimeSlice
  components/  Plain-data ECS components
  data/        Schema, item & recipe tables
  entities/    Entity factories — engine-free
  persistence/ WorldSnapshot (JSON schema, capture/validate/apply), SaveStore (IndexedDB)
  systems/     Game rules, engine-free and unit-testable
    ai/          BehaviorTree, AISystem, PerceptionSystem, AILodSystem
    ai/nav/      NavGrid, FlowField, FlowFieldService (the PathProvider API)
    player/      PlayerAnimation (state machine + pose), PlayerAnimationSystem
    inventory/   InventoryGrid, CraftingEngine, CraftingSystem
  world/       Noise, TerrainGenerator, MapConfig, TerrainService + terrain.worker, codec,
               WorldPopulator (resources/creatures with stable IDs)
  physics/     cannon-es world, physics step, combat/projectiles
  render/      Renderer, interpolation, chunked visuals (time-sliced), culling, ViewModel overlay
  assets/      AssetLoader + manifest
  ui/          MainMenu (menu/config/loading/pause/game over), HUD, InventoryUI
scripts/       simulate-night.ts (survival balance), verify-systems.ts (refactor checks)
```

Dependency rule: `render/`, `physics/` and `app/` may import from `systems/`, `world/` and
`persistence/`, never the reverse.

## 1. Game state management

`GameStateMachine` (pure) owns the states `menu → config → loading → paused ⇄ playing → gameover`.
Illegal or repeated transitions are ignored, which absorbs double-clicks and key spam. Async work
(terrain generation, world build, loading a save) takes a **ticket** when it starts and commits
only if `ticket.stillValid()`; any transition invalidates outstanding tickets, so a generation that
finishes after the player pressed Cancel is discarded and its scene disposed.

`App` holds the long-lived services (renderer and its single WebGL context, input, lifecycle, save
store, terrain service, asset cache). Each game is a `GameSession` with its own `World`,
`EventBus`, physics, systems and UI, created when loading completes and disposed on quit, death or
a new game. The configuration screen validates map size (128–512 m, snapped to the 32 m chunk) and
seed (numeric or text, hashed) before anything starts.

## 2. Player animation

`systems/player/PlayerAnimation.ts` is a pure state machine:
`holstered → equipping → ready → swing | harvest | throw → ready`, plus `unequipping`.
Gameplay systems never apply effects on button press: Combat and Interaction write a request,
and the effect happens on the clip's **impact frame** (`player:action-impact` event). The axe hits
when it visibly lands, harvest yield arrives with the swing, and the spear leaves the hand on
release.

The tool clipping fix has two parts:
- **Visibility:** the tool is drawn only in equipping/ready/action/unequipping. Sprinting, opening
  the inventory, switching hotbar slot or dying lowers it out of view and then hides it.
- **Rendering:** `render/ViewModel.ts` draws the hand and tool in a second pass with its own
  camera after clearing the depth buffer, so they can never intersect trees or terrain.

## 3. Flow-field pathfinding and AI LOD

The terrain worker also builds a `NavGrid` (1 m cells). Blocked cells are trunks and boulders
inflated by the creature radius, water, slopes above 0.45, and the map border. Obstacle sizes come
from the same function the physics colliders use, so the AI and physics agree on what is solid.

`FlowFieldService` implements `PathProvider`, which is the AI's only navigation API:

```ts
interface PathProvider {
  steer(fromX, fromZ, goalX, goalZ, out): boolean; // unit direction, or false = hold position
  isWalkable(x, z): boolean;
  beginTick(): void;
}
```

How it routes:
- **Open ground:** if an exact grid line test (DDA) says the straight line is clear, the creature
  walks straight.
- **Otherwise:** it reads a cached flow field keyed by goal cell. The field is built with Dijkstra
  over a window of 32, 64 or 112 cells, with no corner-cutting between trunks.
- **Sharing:** every wolf chasing the player reads the same field, and patrol waypoints reuse theirs.
- **Budget:** at most 3 fields are built per tick, so a sudden pack chase is spread over frames.

`AISystem` turns toward the returned direction, refuses moves into blocked cells (sliding along one
axis), and gives up on unreachable targets after 2.5 s without progress.

`AILodSystem` runs first each tick. A creature is dormant (no perception, behaviour or movement,
state frozen) when **all** of these hold:
- `Cullable.visible` is false (off-screen or too far, written by the render culling pass);
- it is more than 32 m from the player;
- it is not chasing, hunting, attacking or fleeing.

Freezing purely on the camera frustum would let a wolf stop mid-chase whenever you turn your
back, so those two extra conditions keep gameplay intact.

## 4. Threading and persistence

**Terrain worker:** `world/terrain.worker.ts` generates heights, slopes, props and the nav grid.
The result goes back as transferred typed arrays, with props packed 8 floats each.
`TerrainService` handles the worker:
- it uses one worker per request, killed on cancel;
- it ignores replies whose request id doesn't match;
- if workers can't start, it falls back to the main thread through the same codec, so worlds are
  bit-identical either way.

**Main-thread loading work:** static colliders and chunk meshes are time-sliced at 6–8 ms per
frame, and also yield when the tab is hidden (where `requestAnimationFrame` stops).

**Saves:** `persistence/WorldSnapshot.ts` defines the JSON world schema. A save stores the map
seed and size (terrain is regenerated deterministically) plus only what changed:
- player position, vitals, inventory, hotbar and effects;
- clock;
- depleted resources, referenced by stable prop index;
- carcasses, campfires and shelters;
- creatures with their behaviour-tree blackboard.

A typical save is 5–10 KB. `Infinity` (condition-based effects) is encoded explicitly because
`JSON.stringify` would turn it into `null`. Loading validates every field and names the bad path;
there is also a version and migration hook.

**Storage (`SaveStore`):**
- **IndexedDB** (resolved on transaction commit) for manual saves, autosave every 60 s of play,
  save on pause, and save when the tab is hidden.
- **On refresh:** `pagehide` writes a **synchronous** emergency copy to localStorage and sets a
  sessionStorage flag. On boot the newest valid save wins and the game resumes automatically, at
  the same position.
- **Fallbacks:** corrupt saves are skipped in favour of the next newest; without IndexedDB, saves
  fall back to memory and the menu warns about it.
- **Permadeath:** dying deletes the save.

## 5. Island, building, fixes

**Island.** `TerrainGenerator` multiplies the terrain by a noise-wobbled radial mask: land in the
middle (about 45 % of the map), a sandy shelf, then sea floor 6 m down. The ocean plane extends 8×
past the map so the horizon is water. Below 1.3 m of water the player swims: they float with eyes
above the surface at 2.4 m/s, get wet (cold), and invisible walls stop them at the map edge.

**Building** (`systems/building/`, pure rules; physics/render/nav are adapters listening to
`building:*` events):

| Piece | Cost | Rule |
|---|---|---|
| Foundation | 4 wood, 3 stone | 3×3 m cell; matches a neighbour's height; pillar up to 3.5 m; not on water, trees or rocks |
| Wall | 4 wood | on a cell edge, on a foundation or ceiling |
| Doorway | 4 wood, 2 fiber | wall with a door; E opens or closes it |
| Ceiling / floor | 4 wood | rests on a wall below; 1 cell of overhang; is the floor of the next storey |

- **Demolishing:** demolishing (X) refunds half of the cost, and anything that loses its support
  collapses with it.
- **Shelter:** an enclosed room (flood-filled through open edges) insulates by 0.45, plus 0.45 more
  when fully roofed.
- **Physics and AI:** walls and closed doors block the player, spears and creature line of sight.
  In the nav grid they block creatures, so a wolf can't get into a closed house but walks in
  through an open door.
- **Saves:** buildings are saved (snapshot v2). Saves from before the island are refused with a
  message, because their seed now generates different terrain.

**Fixes.**
- **Crafting:** crafts are a queue that keeps running while you move. Previously moving cancelled
  the craft, which in practice happened as soon as the inventory was closed. Cooking pauses away
  from the fire, and ✕ refunds a queued craft.
- **Hit feedback:** a hit turns the creature red, the crosshair becomes an X (red on a kill), and
  the creature is knocked back 0.7 m. Melee now targets what is under the crosshair.
- **Animal speeds:** wolf 5.4 m/s (was 7.8), deer 6.3 (9), boar 4.6 (6.5). Sprinting at 7.5 m/s
  outruns all of them; walking at 4.2 m/s doesn't outrun a wolf.
- **"Freeze" on key 4:** on AZERTY, key 4 types `'`, which opens Firefox's quick-find bar. That bar
  takes the keyboard, so the game stops receiving input. The browser default is now blocked for
  game keys (digit row, `'`, `/`, Space, Tab, arrows).
- **Crouch:** Ctrl was removed from crouch, because Ctrl+W (crouch + forward) closes the tab.

## 6. Desert island generation

`world/TerrainGenerator.ts` builds the terrain in zones, measured in metres from the coastline along
the radius, so the beach keeps the same width all the way round:

| Zone | Shape |
|---|---|
| Sea | 9 m knee-deep turquoise lagoon, then the floor drops 0.3 m per metre to 6 m |
| Beach | 12–26 m of white sand all round; rises only 0.45 m; no trees, just driftwood, a few rocks and dune grass |
| Forest | low hills (highest point ≈ 4–6 m), very dense firs (~7 per 100 m²), small clearings, undergrowth between trunks |
| Ponds | 1–3 freshwater ponds in hollows: the drinking water (the sea is no longer drinkable) |

- **Spawn:** you start on the beach facing the forest, with the sea behind you.
- **Detail:** 1.33 m per terrain quad (2.25× the polygons of before). Rocks and bushes have more
  facets. The sea floor darkens with depth under clear water, which gives the shallow-to-deep
  gradient.
- **Firs at real scale:** a scale-1 fir is 16 m tall, with a 0.64 m trunk and a crown starting
  2–3.4 m up. The crown is 10–13 overlapping whorls, widest ≈ 1/3 of the height. Mature trees
  are 12–20 m, and one in five is a young fir of 5–10 m.
- **Tree LOD:** trees in chunks farther than 55 m switch to an 80-triangle version (256 up close).
- **Performance:** about 400k triangles and 390 draw calls per frame from the spawn point,
  shadows included.

**Physics performance fix.** Static trunk and rock colliders are now one compound body per 32 m
chunk instead of one body per tree. cannon-es clears a collision matrix with an entry per *pair*
of bodies every step, so cost grows with bodies². Measured with 6,300 trees, one body per tree
cost 300 ms per step; compound bodies cost 0.5 ms.

## 7. Tools, hunting, reach, alt-tab freeze, costs

- **Tools.** Each resource has a best tool: axe → tree, pickaxe → rock, spear → carcass. The
  right tool gives ×2.5 yield per hit, half the hits, and swings 1.4× faster. Another tool gives
  ×0.75, bare hands ×0.5 with slower swings. For example, rock by hand gives 3 stone in 4.4 s;
  with the pickaxe, 9 stone in 1.3 s.
  - Crafted tools go straight into a free hotbar slot.
  - Holding E on a resource takes the right tool out automatically if it's on the hotbar.
  - The prompt says which tool is best. Berries and fiber don't care what you hold.
  - Tuning lives in `HARVEST_TUNING` (`systems/InteractionSystem.ts`).
- **Meat.** Carcasses can now be butchered by hand (about 3 meat), or with the spear (about 7).
  Before, a spear was required and harvesting by hand failed silently. A toast explains it on
  each kill.
- **Reach.** Fist 3 m, tools 3.5 m, spear 4 m (was 2.2 m), measured from the eye.
  - Knockback reduced to 0.4 m, so the follow-up hit is still in reach.
  - Harvest reach is 3.2 m (was 2.8 m).
  - Values are in `data/combat.ts`.
- **Alt-tab freeze in Firefox.** Firefox fires window `blur` *before* releasing pointer lock.
  - The loop was already paused for the blur, so the 'user' pause was never reported: no pause
    menu, and nothing could clear it.
  - The loop now reports every pause-reason change.
  - Resume also clears a leftover blur/hidden pause, and any click or key counts as focus.
- **Building costs halved.** Foundation 2 wood + 1 stone, wall 2 wood, doorway 2 wood + 1 fiber,
  ceiling 2 wood. Demolishing refunds half, rounded up.

## 8. Felled trees, building movement, tools, animals, beds

- **Felled trees and mined boulders stop being solid.** Each one now has its own shape inside its
  chunk's compound body, removed on depletion and restored on regrowth
  (`PhysicsWorld.setPropSolid`). Before, the shape stayed there forever.
  - Nav-grid trunk obstacles are per-cell counts (`NavGridData.obstacles`), removed the same way,
    so creatures path through the stump.
  - Regrowth waits until the player isn't standing on the spot, and depleted props loaded from a
    save are cleared too.
- **No more slowdown on or near buildings.** Buildings and map bounds had no physics material, so
  they used cannon's default contact friction of 0.3, which fought the velocity-driven controller.
  - Measured: 0 m/s at a foundation edge and 2.2 m/s along a wall. Default friction is now 0:
    4.1 m/s in both cases.
  - New step assist: you walk up foundation edges (≤ 0.7 m) without jumping
    (`PhysicsWorld.canStepUp`).
- **Tools redesigned:** leather grip, plant-fiber lashing, knapped flint heads (curved axe blade
  extruded from a profile, two-pronged pickaxe, leaf-shaped spear point), sleeve and thumb on the
  hand.
  - **Torch:** resin-cloth head, unlit flickering flame, and a `PointLight` in the world (range
    20 m) that follows your hand.
  - The light always stays in the scene, at intensity 0 when unused, so equipping a torch never
    triggers a shader recompile.
- **Animals:** about twice as many (256 m map: 7 wolves, 16 deer, 7 boars).
  - New multi-part, counter-shaded models: antlered deer with white rump, wolf with chest ruff and
    bushy tail, boar with tusks and a bristle ridge.
  - `CreatureAnimationSystem` swings the legs in a diagonal gait with real ground speed, and
    bobs/sways head and tail. Deer and boars graze when idle.
- **Bed** (build mode, 3 wood + 4 fiber): goes on a foundation or floor, with the headboard
  against the aimed edge. Press E on it from 19:00 to 06:00 to sleep until 06:30.
  - `SleepSystem` fast-forwards the night in 1 s steps through environment, fires, regrowth,
    crafting and metabolism (activity `sleeping`: energy refills).
  - Refused in daytime, or if a predator nearby is hunting or aware of you.
  - Sleeping outside on a cold night can kill you, so put the bed in a roofed house.

## Verification

- `npm test`: 29 survival + 46 refactor + 49 island/building + 14 gameplay + 21 world/physics checks (real cannon-es), all passing. They cover:
  - flow fields: around a wall through a gap, and 40 random trips across the real forest with
    zero entries into blocked cells;
  - LOD: dormant creatures freeze and wake in place;
  - the codec is deterministic and cancellation works;
  - save round-trip (stable IDs, Infinity, inventory, AI state), plus corrupt, tampered and
    future-version saves;
  - the animation state machine;
  - rapid toggling of the app state machine;
  - map config validation.
- Strict type-check against three r186 type definitions and cannon-es.
- Headless Chromium, full flow with no runtime errors: menu, config, Generate followed by an
  immediate Cancel, Generate again (worker mode), play, craft and equip an axe through the UI,
  swing, sprint (tool hidden), pause, save to IndexedDB, **refresh** (auto-resumed at the same
  position and inventory), quit to menu (Continue shows the save).
- Loading a 512 m map took 0.9 s with **no main-thread task over 50 ms**. The worker kept main-thread
  stalls under 8 ms, and collider creation (140 ms if done in one go) is time-sliced.

## Known gaps

- Spears in flight or lying on the ground are not saved; spears in the hotbar are.
- Creatures more than 112 cells from their goal hold position rather than path (it doesn't happen
  with current perception ranges).
- The viewmodel is pose-based (procedural keyframes), not skinned animation. `viewModelPose()` is
  the single place to swap in an animation mixer.
- The first frame after loading compiles shaders; `renderer.compile()` during loading would hide it.
