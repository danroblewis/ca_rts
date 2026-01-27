# Refactoring Plan: CA RTS Game

## Current State (January 2026)

### Completed Refactors
- `main.js` reduced from **2,947 → 1,588 lines** (46% reduction)
- **9 modules** extracted with clean interfaces
- **112 unit tests** covering all extracted modules

### Extracted Modules

| Module | Lines | Purpose | Dependencies |
|--------|-------|---------|--------------|
| `utils/GameUtils.js` | ~200 | Pure utility functions, constants | None |
| `game/Camera.js` | 297 | Camera state and controls | None |
| `game/GameState.js` | 521 | Centralized game state | GameUtils |
| `game/MapGenerator.js` | 152 | Deterministic map generation | GameUtils |
| `game/GridActions.js` | 277 | Grid manipulation | GameUtils |
| `game/ActionApplier.js` | 286 | Apply game actions to grid | GameUtils |
| `game/RollbackManager.js` | 261 | Rollback netcode & replay | Logger |
| `input/InputHandler.js` | 418 | Input handling | Camera, Logger |
| `ui/GameUI.js` | 255 | HUD elements | None |
| `ui/MatchmakingDialog.js` | 217 | Matchmaking UI | None |
| `audio/AudioManager.js` | 208 | Audio init & controls | AudioEngine |

### Test Coverage

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `gameutils.test.js` | 20 | Constants, PRNG, packing, selection |
| `camera.test.js` | 13 | Zoom, pan, clamp, coord conversion |
| `gridactions.test.js` | 19 | Unit marking, factories, demolish |
| `mapgenerator.test.js` | 12 | Determinism, content, edge cases |
| `actionapplier.test.js` | 18 | All action types, state changes |
| `rollbackmanager.test.js` | 15 | Checkpoints, replay, rollback |
| `audiomanager.test.js` | 15 | Init, mute, button UI |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         main.js                              │
│  - GPU/Shader initialization                                 │
│  - Simulation loop (GPU compute)                             │
│  - Render loop (WebGL)                                       │
│  - Network event wiring                                      │
│  - Speed controls                                            │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ RollbackManager │  │   ActionApplier │  │  NetworkSync    │
│ ✅ Extracted    │  │   ✅ Extracted  │  │  (existing)     │
│                 │  │                 │  │                 │
│ - checkpoints   │  │ - applyAction() │  │ - WebSocket     │
│ - actionQueue   │  │ - place_factory │  │ - State sync    │
│ - rollback()    │  │ - demolish      │  │ - Heartbeat     │
│ - replay()      │  │ - unit_command  │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │                    │
         ▼                    ▼
┌─────────────────┐  ┌─────────────────┐
│   GridActions   │  │   AudioManager  │
│   ✅ Extracted  │  │   ✅ Extracted  │
│                 │  │                 │
│ - markUnits     │  │ - init()        │
│ - placeFactory  │  │ - toggle()      │
│ - demolish      │  │ - update()      │
└─────────────────┘  └─────────────────┘
```

---

## What Remains in main.js

The remaining **1,588 lines** contain code tightly coupled to runtime state:

### GPU/Shader Management (~200 lines)
- Shader loading and compilation
- Shader mode switching (metaball/debug)
- Can't extract without passing GPU context everywhere

### Simulation Loop (~150 lines)
- `simulationStep()` - GPU compute dispatch
- Speed controls and TPS tracking
- Action queue processing during simulation
- Tightly integrated with rollback system

### Render Loop (~150 lines)
- `renderLoop()` - WebGL rendering
- Shader uniform setup
- Input state for UI rendering
- Audio update integration

### Network Callbacks (~400 lines)
- Connection/disconnection handlers
- Speed sync and tick catchup
- State sync receive/apply
- Player join/leave logic

### Multiplayer UI (~150 lines)
- Network indicator
- Join/watch room
- Auto-connect logic

---

## Future Refactoring Options

### Option 1: Event-Based Architecture
Extract network callbacks into an event emitter pattern:

```javascript
class GameEventBus {
    on(event, handler) { }
    emit(event, data) { }
}

// Events: 'player-joined', 'action-received', 'state-sync', etc.
```

**Pros**: Decouples network from game logic
**Cons**: Adds complexity, may hurt debuggability

### Option 2: Simulation Context Object
Pass a context object to simulation functions instead of relying on globals:

```javascript
const simContext = {
    grid, simTime, isMultiplayer, actionQueue,
    rollbackManager, networkSync
};

function simulationStep(ctx) { ... }
```

**Pros**: Makes dependencies explicit, easier testing
**Cons**: Requires threading context through many functions

### Option 3: Stay at Current State
The current architecture is clean enough for a game of this size:
- Core modules are extracted and tested
- Global state is limited to main.js
- GPU code stays in main.js (appropriate for WebGL)

**Pros**: Minimal refactoring risk
**Cons**: main.js still larger than ideal

---

## Testing Strategy

### Unit Tests (Current: 112 tests)
All extracted modules have comprehensive test coverage:
- Pure functions in GameUtils ✅
- Camera state management ✅
- Grid manipulation ✅
- Map generation determinism ✅
- Action application ✅
- Rollback/replay logic ✅
- Audio management ✅

### GPU Tests (Current: 84 tests)
Shader behavior tested via GPU:
- Cell type transitions
- Unit movement
- Mining behavior
- Random number generation

### Manual Testing Checklist
- [ ] Solo: place factory, units spawn, mine resources
- [ ] Solo: select units, command to move
- [ ] Solo: demolish factory
- [ ] Solo: win condition triggers
- [ ] Multi: both players see same map
- [ ] Multi: factory placement syncs
- [ ] Multi: unit commands sync
- [ ] Multi: demolish syncs
- [ ] Multi: periodic sync keeps clients aligned

---

## File Structure

```
src/
├── main.js                 # Entry point, loops, wiring (1,588 lines)
├── game/
│   ├── Camera.js           # ✅ Camera state & controls
│   ├── GameState.js        # ✅ Centralized game state
│   ├── GridActions.js      # ✅ Grid manipulation
│   ├── MapGenerator.js     # ✅ Deterministic map gen
│   ├── ActionApplier.js    # ✅ Apply game actions
│   ├── RollbackManager.js  # ✅ Rollback netcode
│   └── InputHandler.js     # ✅ Input handling
├── ui/
│   ├── GameUI.js           # ✅ HUD elements
│   └── MatchmakingDialog.js # ✅ Matchmaking UI
├── audio/
│   ├── AudioEngine.js      # Existing
│   ├── AudioManager.js     # ✅ Audio controls
│   └── AudioReductionPipeline.js # Existing
├── utils/
│   ├── GameUtils.js        # ✅ Pure utilities
│   └── Logger.js           # Existing
├── network/
│   ├── NetworkSync.js      # Existing
│   └── ActionQueue.js      # Existing
├── gpu/
│   ├── GPU.js              # Existing
│   ├── CAGrid.js           # Existing
│   └── CheckpointBuffer.js # Existing
└── tests/
    ├── gameutils.test.js   # ✅ 20 tests
    ├── camera.test.js      # ✅ 13 tests
    ├── gridactions.test.js # ✅ 19 tests
    ├── mapgenerator.test.js # ✅ 12 tests
    ├── actionapplier.test.js # ✅ 18 tests
    ├── rollbackmanager.test.js # ✅ 15 tests
    └── audiomanager.test.js # ✅ 15 tests
```

---

## Notes for Future Development

1. **Don't break multiplayer** - Test after every change
2. **Prefer callbacks over imports** - Avoids circular deps
3. **Keep main.js as orchestrator** - It wires everything together
4. **Test determinism** - Same seed + same actions = same result
5. **Use dependency injection** - Pass dependencies to constructors
6. **GPU code stays in main.js** - WebGL context is inherently global

---

## Metrics History

| Date | main.js Lines | Modules | Unit Tests |
|------|---------------|---------|------------|
| Start | 2,947 | 0 | 57 (GPU only) |
| Phase 1 | 2,500 | 4 | 57 |
| Phase 2 | 2,059 | 6 | 72 |
| Phase 3 | 1,778 | 8 | 97 |
| Current | 1,588 | 9 | 112 |

