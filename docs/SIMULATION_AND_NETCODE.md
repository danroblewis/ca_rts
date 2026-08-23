# Simulation pipeline & multiplayer netcode

This document describes how a simulation tick runs on the GPU, how two
browsers are kept on an identical timeline, and how both are tested.

## 1. One simulation tick

```
                 ┌──────────────────────────────────────────────────────┐
  state S_t ───▶ │ apply_actions.wgsl  (only if the tick has actions)   │ ──▶ S_t'
                 └──────────────────────────────────────────────────────┘
                 ┌──────────────────────────────────────────────────────┐
      S_t' ────▶ │ sim_prepass.wgsl   intent texture + block mask + hash │
                 └──────────────────────────────────────────────────────┘
                 ┌──────────────────────────────────────────────────────┐
      S_t' ────▶ │ mining_game.wgsl   trait-based CA update             │ ──▶ S_{t+1}
   + intents     └──────────────────────────────────────────────────────┘
```

All three are compute passes recorded into one command encoder per tick
(`Game.simulationStep()`), submitted once. **Nothing on the frame path waits
on the GPU.** The only readbacks are:

* the state hash (16 KB, every `hashInterval` = 60 ticks, `mapAsync` handled
  asynchronously), and
* the factory count for the win condition (every 5 s, in its own interval).

Input validation (`handlePlaceFactory` etc.) downloads the grid once per
click; that is the only other readback and it is off the tick path.

### 1.1 Actions are applied on the GPU

`src/game/ActionPipeline.js` + `src/shaders/ca/v2/apply_actions.wgsl` apply a
tick's actions (place_factory, demolish, unit_selection, unit_command,
clear_selection) per cell, in order. The CPU `ActionApplier` is kept as the
reference implementation for validation and tests; the unit test suite
verifies the GPU pass matches it bit-for-bit (`actionpipeline.test.js`).

Selections are part of the synced grid, so even local drag-selection goes
through the action path (it becomes visible after the input delay).

### 1.2 The prepass and the activity mask (performance)

The original single-pass shader evaluated every trait for every cell and
re-evaluated neighbours' decisions from scratch — `findExplodingMissileAffecting`
alone loaded 121 texels per cell per tick, and an empty cell next to a unit
re-ran that unit's 11×11 vision scans up to 9 times.

`sim_prepass.wgsl` computes, once per cell:

* a unit's movement direction, a resource's movement direction, a factory
  cell's "built" flag — packed into a `r32uint` **intent** texture
  (`core/intent.wgsl`), and
* a per-8×8-block **activity mask** (bitmask of cell types present) plus a
  per-block **state hash**.

`mining_game.wgsl` then reads neighbour intents instead of recomputing them and
ORs the 3×3 blocks around its block (covering ±8 cells, more than any
trait's range) to skip whole trait evaluations when nothing relevant is
nearby. Every skipped evaluation would have returned "nothing happened", so
the result is **bit-identical** to the original shader. The original is
frozen under `src/shaders/ca/v2ref/` and `simequivalence.test.js` compares the
two tick by tick on populated maps (including a 512² map).

Measured on an Apple M-series GPU, 512², ~300 units: 2.4 ms → 0.6 ms per tick.

### 1.2.1 The missile feature is off by default

`SimParams.flags` bit 0 enables the factory → missile transformation. It is
off in the game (`SimulationPipeline` default) because a factory surrounded
by eight of its own depositing units — a perfectly normal situation — turned
into a missile, which the win condition read as "lost all bases". The rest of
the missile code is kept and the missile unit tests enable the flag. The
reference shader carries the same gate so the equivalence tests stay exact.

### 1.3 Rendering cost and the quality ladder

The CA is 512² but the metaball render shader runs per screen pixel; on a
retina display at DPR 2 that is ~6 M pixels per frame and was the actual
frame-rate limiter. Rendering therefore adapts while the simulation never
does (`src/rendering/QualityManager.js`):

| level   | shader   | tier | scale (× DPR) | minimap | ms/frame* |
|---------|----------|------|---------------|---------|-----------|
| ultra   | metaball | 3 full kernels + procedural rock textures + unit trails | 1.5 | yes | ~32 |
| high    | metaball | 3    | 1.0  | yes | ~16 |
| medium  | metaball | 2 (3×3 kernels) | 1.0 | no | ~13 |
| lite    | metaball | 1 (flat rock shading, no trail frame) | 1.0 | no | ~7 |
| low     | metaball | 1    | 0.75 | no | ~4 |
| minimal | debug    | –    | 1.0  | no | ~2 |
| potato  | debug    | –    | 0.5  | no | ~2 |

\* Apple M-series, 1512×982 window.

The tier is passed to the shader as `RenderParams.quality`. In **auto** mode
the manager steps down one level when fps stays below 55 for 2 s and steps
up when fps stays ≥ 58 *and* the estimated GPU time per frame is under 10 ms
for 10 s (the renderer measures `queue.onSubmittedWorkDone()` latency every
few frames). A step up that is followed by a step down within 20 s blocks that
level for 2 minutes, so the quality cannot oscillate. Changes are never
closer than 3 s apart. The "Quality" dropdown (or `?quality=auto|ultra|…|potato`)
overrides it; the legacy `?perf=1` and `?shader=debug` map to medium/minimal.

To test on a fast machine the game can be made artificially slow:
`?gpuload=N` / `window.setGpuLoad(N)` adds a synthetic compute pass of N
loop iterations × 65k threads per frame (`shaders/gpu_load.wgsl`), and
`?cpuload=MS` / `window.setCpuLoad(MS)` busy-waits the main thread for MS
per frame. `e2e/quality.spec.js` calibrates a load that makes ultra too slow
and verifies the ladder recovers the frame rate, alone and for one
constrained client in a lockstep game.

## 2. Lockstep multiplayer

Rollback (checkpoints + replay) was removed. Both clients now run an
**input-delay lockstep**:

* Every tick, each client emits an input frame `{ tick, actions }` for tick
  `current + inputDelay` (`LockstepSync.emitFramesThrough`). Frames are
  emitted on the clock even while the client is blocked, so two clients
  waiting on each other can never deadlock.
* A client may simulate tick `T` only when it holds every peer's frame for
  `T` (`LockstepSync.canSimulate`). Frames are per-tick and contiguous, so
  out-of-order delivery is handled by tracking the highest contiguous tick.
* Local actions are never applied immediately: they ride in the next
  emitted frame and are applied at that tick on every client
  (`Game.scheduleAction`). Same actions, same ticks, same deterministic GPU
  simulation ⇒ identical grids.
* `inputDelay` adapts to the measured round trip (`NetworkManager.onPong`):
  6 ticks (100 ms) on a LAN, up to 90 ticks under very high latency. Latency
  below the delay never stalls; above it, the faster client waits (the
  timelines stay locked, the frame rate does not drop because rendering is
  independent of ticks).
* A slow machine simply bounds the other client: nobody can run more than
  `inputDelay` ticks ahead of a peer.

### 2.1 Joining and resync

When a player joins, the host adds it as a peer (stalling at its current
tick `T`), snapshots the grid at `T` together with every input frame it knows
for ticks ≥ `T`, and sends it (binary `sync` message: zlib grid + JSON header
with `counters` and `frames`). The joiner applies the snapshot, starts
emitting frames from `T`, and both proceed. Actions issued during the
handshake are kept as pending local actions and ride in the first frame.

Gaps (a lost or never-delivered frame) are recovered by a NACK: a client
stalled for > 1 s asks the peer to re-send frames from the first missing
tick (`request_inputs`); every client keeps ~1800 ticks of its own frames.

### 2.2 Divergence detection

The prepass hashes every tick's input state per block; every 60 ticks a
client reads the hash back (asynchronously) and sends it to its peers
(`hash` message). A mismatch marks `game.desyncDetected`, and a non-host
requests a fresh snapshot from the host. With identical hardware this never
triggers; it is the safety net for GPUs with different float behaviour.

### 2.3 Messages (server.py relays them)

| type              | direction          | payload |
|-------------------|--------------------|---------|
| `inputs`          | client → all       | `{ playerId, frames: [{tick, actions}] }` |
| `hash`            | client → players   | `{ playerId, tick, hash }` |
| `request_inputs`  | client → target    | `{ requestingPlayerId, targetPlayerId, fromTick }` |
| `request_state`   | client → host      | host answers with a `sync` snapshot |
| `sync` (binary)   | host → others      | header `{ simTime, counters, frames, action: {type:'snapshot'} }` + zlib grid |
| `ping` / `pong`   | client ↔ server    | RTT measurement for the adaptive input delay |
| `joined`, `player_joined`, `player_left` | server → clients | now carry `hostId` |

## 3. Tests

* **Unit / GPU suite** (`test.html`, `src/tests/run-tests.js`):
  * `lockstepsync.test.js` – the lockstep state machine with a simulated
    two-client network (latency, reordering, changing delay, hash exchange).
  * `actionpipeline.test.js` – GPU action pass vs CPU `ActionApplier`.
  * `simequivalence.test.js` – optimised shader vs reference shader.
  * `sync.test.js` – two headless clients with the real GPU simulation and
    real `LockstepSync` under latency/jitter/reordering/loss, slow peers,
    all action types, 2000/5000-tick runs, snapshot join.
  * `performance.test.js` – tick cost, reference vs optimised.
* **e2e** (`e2e/`, Playwright, two real Chrome WebGPU clients):
  * `lockstep.spec.js` – the acceptance tests: a 5-minute game with many
    interlaced actions from both players (fps ≥ 50 on both, timelines
    within the input delay, zero hash mismatches, identical grids at the
    end), latency / asymmetric latency / slow-peer variants, join-handshake
    and mid-game rejoin, retina-scale fps, tick cost.
  * `sync.spec.js` – the pre-existing scenario tests (now passing without
    rollback). They place factories at fixed coordinates on a
    server-randomised map, so an individual run can be seed-flaky.

Run: `python3 server.py --port 8765` (HTTPS with the repo's self-signed
cert — WebGPU needs a secure context), then
`cd e2e && E2E_PORT=8765 npx playwright test` (Playwright ignores the
certificate warning), and open `https://localhost:8765/test.html` for the
unit suite.
