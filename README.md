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

## 9. Tree species, ARK resources, stations, storage, stairs

- **Seven tree species** (`world/TreeSpecies.ts`): fir, spruce, pine, oak, birch, redwood, and palms
  on the upper beach.
  - Species are picked from three slow noise fields, so they grow in groves that blend at the edges,
    with the odd tree of another kind inside: a mix, but not a uniform one. On a 256 m island the
    mix is roughly 25–35 % fir, then spruce, pine, oak, birch, and a few redwood groves.
  - Trees are drawn 25 % taller without thicker trunks (`TREE_HEIGHT_STRETCH`), so the forest is as
    walkable as before.
  - Prop positions are unchanged (species come from hashes, not the RNG), so old saves keep their
    resource IDs.
- **ARK resources.** Items now include wood, thatch, stone, flint, fiber, hide, pelt, keratin,
  chitin, metal ore, obsidian, crystal, oil, silica pearls, black pearls, sulfur, salt, rare
  flowers and mushrooms, and the six berries.
  - New nodes are appended after the old props:
    - inland outcrops of metal, obsidian and crystal (pickaxe required);
    - oil rocks, salt crusts and shell beds on the shore;
    - fish shoals in the lagoon;
    - rare flowers in clearings.
  - Yields depend on the tool, ARK-style: thatch by hand and wood with the axe; a sickle triples
    fiber and berries.
  - Carcasses depend on the species: wolves give pelts, boars keratin, and deer and boars prime
    meat.
- **Placed structures** (`data/stations.ts`): storage box (24 slots), large storage box (60),
  mortar & pestle, smithy, refining forge, cooking pot, preserving bin and fabricator.
  - Press E on one to open its inventory next to yours. Click an item to move it across; "Pick up"
    returns an empty structure to your bag.
  - Fires, forges and pots cook or smelt whatever is inside while lit, burning wood, thatch or
    sparkpowder from the same inventory (`StationSystem`). Burnt wood leaves charcoal.
  - The preserving bin needs no fuel. The fabricator must be powered with gasoline.
- **Crafting menu rework** (`ui/InventoryUI.ts`):
  - category tabs, search, and a recipe list sorted by what you can make now;
  - a detail card with ingredients (have/need), the required station, stats and time, plus Craft
    ×1 / ×5;
  - station chips that light up when you are in range;
  - a "Cook & Smelt" reference tab.
  - About 40 recipes (tools, metal tools, bow and arrows, armour, structures, refining, food and
    medicine) and 16 cooking/smelting recipes.
- **Weapons and armour:**
  - Metal hatchet, pick and sickle, pike, sword, wooden club, and a bow with stone arrows (60 % of
    arrows can be picked up again).
  - Cloth, hide, fur, chitin and flak armour reduce creature damage by up to half (`wearable.armor`).
  - A GPS shows your coordinates.
- **Campfires and structures land on buildings:** placement casts down onto the floor or foundation
  instead of using terrain height (`physics/Placement.ts`), and never through a wall.
- **Stairs** (4 wood): a straight flight filling one cell and climbing one storey toward where you
  look. The player is snapped onto the flight surface (no ramp to slide down), and the stairs hold
  up the landing ceiling at the top.
  - Placement is refused if a wall blocks the top, if there is a ceiling over the stairwell, or if a
    bed is in the same cell.
- **Saves v4:** structures with their contents, fire state and smelting progress, and carcass
  species. v3 saves still load, and the bag grows from 8×5 to 10×6.

## 10. Damage fix, mountains and caves, crocodile, bear, multiple saves

- **"Constant damage for no reason":**
  - The red screen flashed every time *any* animal noticed you (deer included), not when you were
    hurt. It now flashes only on a real hit, with a message naming the attacker
    (`player:damaged`).
  - Wolves could bite through floors (attack range ignored height). Attacks now need the same
    level (±1.6 m).
  - The climate was temperate (3 °C mornings, −8 °C nights), so you slowly froze. The island is
    now tropical (about 13–30 °C), and the cold is in the mountains: −0.4 °C per metre of altitude.
  - When health drops from hunger, thirst, cold, bleeding or poisoning, a message says why.
- **Generator v2** (new worlds; older saves keep regenerating the flat island they were made on,
  via `MapConfig.gen`):
  - **Mountains:** 1–3 craggy peaks (about 20 m on Small, 40 m on Medium, 55 m on Huge maps).
  - **The beach stays flat all round:** the relief fades in 8–34 m inland of it.
  - **Biomes:** beach, forest, jungle (oaks, palms, redwoods, mushrooms), meadow (open grass,
    berries), highlands (pines, stone, ore) and snowy peaks (bare, cold, crystals). Each has its own
    ground colour, trees and undergrowth.
  - **Caves:** one per mountain, a flat chamber carved into the flank under a rock dome with
    stalactites, crystals, a metal vein and bones. A graded ramp leads to the mouth. The roof is
    solid, so you can walk over it. Inside, it's dry and sheltered.
- **Crocodile** (`ApexModels.ts`, `ApexSystem.ts`, `ApexAnimation.ts`): 1 per 128 m of map edge.
  - Body: about 5 m long, with a 6-segment tail, a hinged jaw with interlocking teeth, raised eyes
    with slit pupils, osteoderm rows and sprawled legs with claws.
  - It patrols the lagoon and lurks with only its eyes above water. It stalks swimmers or anyone at
    the water's edge, then lunges, snaps and shakes its head.
  - It follows you a few metres up the beach, never far, and slides back.
  - Animation: swimming is a travelling wave down the tail with the legs folded back; on land it
    high-walks with an S-bend of the spine.
- **Bear:** one asleep at the back of every cave.
  - Walk in, come close, or hit it, and it wakes, rears up and roars (about 2 s to react), then
    charges at a gallop and swipes.
  - It gives up about 38 m from its cave and goes home to sleep. Some nights it wanders near the
    entrance.
  - Rig: spine pivoting at the hips, 2-joint legs, jaw, and shaggy fur. Animations: walk, gallop,
    sleep, rear and roar, swipe.
  - Drops pelt, prime meat and hide; the crocodile drops keratin.
- **Several saves:**
  - Every world has its own slot and name (set when you create it).
  - Main menu → *Load game* lists all worlds, where you can load, rename, duplicate, export to a
    file, delete (confirmed), or import a file.
  - Pause menu: *Save game* or *Save as new…*.
  - Dying deletes only that world's save. The save written on page close goes to the right world.

## 11. Smooth predators, moving in menus, bed respawn, breeding

- **Crocodile and bear animation fixes:**
  - **Shaking and wrong facing:** the apex brain copied only the previous position, not the
    previous rotation, so the renderer kept blending from a stale orientation every frame.
  - **Left/right jitter:** when its target was right behind it, the creature flipped its turn
    direction each tick. Turns now keep their direction (`ApexSystem.turn`).
  - **Zigzag paths:** the bear's flow-field direction is now smoothed.
  - **Stopping in the middle of nowhere:**
    - The crocodile now swims around sandbanks with a sticky detour instead of pushing into them.
    - A progress watchdog picks a new target when a crocodile or bear stops moving.
    - When the flow field isn't built yet, the bear walks straight instead of freezing.
    - The crocodile pauses to lurk less often and for less time.
- **Move while a panel is open:** inventory, crafting, storage boxes and stations don't stop you.
  Movement keys stay live (`Input.setMovementOnly`); clicks and other actions go to the UI. The
  pause menu still pauses the game.
- **Respawn at a bed:** if you have built a bed, dying shows "Respawn at your bed".
  - Everything you carried (bag, hotbar, armour) stays in a bag where you fell; press E on it.
    It disappears once it is empty.
  - You wake up next to the bed you last slept in, at 70 health.
  - The world's save is kept. Without a bed, death is still final for that world.
- **Breeding** (`BreedingSystem`):
  - Deer, boars and wolves with two adults close together have 1–3 babies near the mother every
    so often, up to 1.4× the starting population. A species reduced to a single adult never comes
    back.
  - Babies are born at about 45 % of an adult's size and grow over 9–15 minutes. Size, health and
    speed increase as they grow.
  - Young wolves are timid and don't bite until they are more than half grown.
  - A message tells you when one is born nearby. Growth is saved.

## Verification

- `npm test`: 29 survival + 46 refactor + 52 island/building + 14 gameplay + 41 crafting/stations + 43 wildlife/terrain/saves/respawn/breeding + 29 world/physics checks (real cannon-es), all passing. They cover:
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

- Spears and arrows in flight or lying on the ground are not saved; those in the hotbar or bag are.
- Not included from ARK: Element, organic polymer, honey, seeds and farming, sand/clay (Scorched Earth), and guns (gunpowder is craftable but has no use yet).
- Creatures more than 112 cells from their goal hold position rather than path (it doesn't happen
  with current perception ranges).
- The viewmodel is pose-based (procedural keyframes), not skinned animation. `viewModelPose()` is
  the single place to swap in an animation mixer.
- The first frame after loading compiles shaders; `renderer.compile()` during loading would hide it.
