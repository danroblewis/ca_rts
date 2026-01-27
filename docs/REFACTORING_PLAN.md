# Refactoring Plan: CA RTS Game

## Current State (January 2026)

### Completed Refactors
- `main.js` reduced from 2,947 → 2,059 lines (30% reduction)
- 8 modules extracted with clean interfaces

### Extracted Modules

| Module | Purpose | Dependencies |
|--------|---------|--------------|
| `utils/GameUtils.js` | Pure utility functions, constants | None |
| `game/Camera.js` | Camera state and controls | None |
| `game/GameState.js` | Centralized game state | GameUtils |
| `game/MapGenerator.js` | Deterministic map generation | GameUtils |
| `game/GridActions.js` | Grid manipulation | GameUtils |
| `input/InputHandler.js` | Input handling | Camera, Logger |
| `ui/MatchmakingDialog.js` | Matchmaking UI | None |
| `ui/GameUI.js` | HUD elements | None |

---

## Future Refactoring: RollbackManager

### Overview
The rollback netcode (~500 lines) handles multiplayer state synchronization. It's currently tightly coupled to:
- Simulation loop (needs to run simulation steps)
- Grid data (needs to save/restore checkpoints)
- Network callbacks (triggered by remote actions)
- Game state (factory counts, player state)

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         main.js                              │
│  - Simulation loop                                           │
│  - Render loop                                               │
│  - Network event wiring                                      │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ RollbackManager │  │   ActionApplier │  │  NetworkSync    │
│                 │  │                 │  │  (existing)     │
│ - checkpoints   │  │ - applyAction() │  │                 │
│ - actionQueue   │  │ - place_factory │  │                 │
│ - rollback()    │  │ - demolish      │  │                 │
│ - replay()      │  │ - unit_command  │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### RollbackManager Interface

```javascript
class RollbackManager {
    constructor(options) {
        this.checkpointBuffer = options.checkpointBuffer;
        this.actionQueue = options.actionQueue;
        this.gridSize = options.gridSize;
        
        // Callbacks for external operations
        this.onRestoreCheckpoint = options.onRestoreCheckpoint;  // (data, tick) => void
        this.onSimulationStep = options.onSimulationStep;        // () => void
        this.onApplyAction = options.onApplyAction;              // (action, playerId) => void
    }
    
    // Save a checkpoint at the current tick
    saveCheckpoint(tick, gridData) { }
    
    // Add an action to the queue
    addAction(tick, playerId, type, data, isLocal) { }
    
    // Check if rollback is needed and perform it
    processIncomingAction(action, playerId, actionTick, currentTick) { }
    
    // Replay actions from checkpoint to current tick
    replayFromCheckpoint(checkpointTick, targetTick) { }
    
    // Get actions that should be applied at a given tick
    getActionsAtTick(tick) { }
    
    // Garbage collect old checkpoints and actions
    cleanup(oldestNeededTick) { }
}
```

### ActionApplier Interface

```javascript
class ActionApplier {
    constructor(options) {
        this.gridSize = options.gridSize;
        this.getGridData = options.getGridData;      // () => Float32Array
        this.setGridData = options.setGridData;      // (data) => void
        this.onStateChange = options.onStateChange;  // (changes) => void
    }
    
    // Apply a single action to the grid
    applyAction(action, playerId) {
        switch (action.type) {
            case 'place_factory': return this.placeFactory(action, playerId);
            case 'demolish': return this.demolish(action, playerId);
            case 'unit_command': return this.unitCommand(action, playerId);
            case 'unit_selection': return this.unitSelection(action, playerId);
            case 'clear_selection': return this.clearSelection(action, playerId);
        }
    }
    
    // Individual action handlers
    placeFactory(action, playerId) { }
    demolish(action, playerId) { }
    unitCommand(action, playerId) { }
}
```

### Migration Steps

1. **Create ActionApplier first** (lower risk)
   - Extract `applyAction()` function from main.js
   - Keep it as a standalone module
   - Test thoroughly with multiplayer

2. **Create RollbackManager** (higher risk)
   - Wrap CheckpointBuffer and ActionQueue
   - Add rollback/replay orchestration
   - Inject callbacks for simulation steps

3. **Update main.js**
   - Replace direct checkpoint/action calls with RollbackManager
   - Wire up callbacks
   - Test multiplayer sync thoroughly

### Key Challenges

1. **Circular Dependencies**
   - RollbackManager needs to trigger simulation steps
   - Simulation step needs to check action queue
   - Solution: Use callbacks/dependency injection

2. **State Synchronization**
   - Factory counts must stay in sync with grid
   - Solution: ActionApplier emits state change events

3. **Determinism**
   - Replay must produce identical results
   - Solution: All randomness uses seeded PRNG in shaders

---

## Future Refactoring: SimulationManager

### Overview
The simulation loop (~200 lines) could be extracted to improve testability.

### Proposed Interface

```javascript
class SimulationManager {
    constructor(options) {
        this.grid = options.grid;
        this.simShader = options.simShader;
        this.gridSize = options.gridSize;
        
        // Callbacks
        this.onBeforeStep = options.onBeforeStep;  // () => void
        this.onAfterStep = options.onAfterStep;    // (tick) => void
    }
    
    // Run a single simulation step
    step() { }
    
    // Run multiple steps (for fast-forward)
    fastForward(numSteps) { }
    
    // Get current simulation time
    getTick() { }
    
    // Set simulation time (after checkpoint restore)
    setTick(tick) { }
}
```

---

## Testing Strategy

### Unit Tests (Jest)
- `GameUtils.js` - Pure functions, easy to test
- `Camera.js` - State management
- `GridActions.js` - Grid manipulation (mock grid data)
- `MapGenerator.js` - Deterministic output
- `GameUI.js` - DOM manipulation (jsdom)
- `InputHandler.js` - Event handling (mock canvas)

### Integration Tests
- Factory placement → network sync → remote apply
- Selection → command → network sync
- Checkpoint save → action receive → rollback → replay

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
├── main.js                 # Entry point, loops, wiring
├── game/
│   ├── Camera.js           # ✅ Extracted
│   ├── GameState.js        # ✅ Extracted
│   ├── GridActions.js      # ✅ Extracted
│   ├── MapGenerator.js     # ✅ Extracted
│   ├── RollbackManager.js  # 🔜 Future
│   ├── ActionApplier.js    # 🔜 Future
│   └── SimulationManager.js # 🔜 Future
├── input/
│   └── InputHandler.js     # ✅ Extracted
├── ui/
│   ├── GameUI.js           # ✅ Extracted
│   └── MatchmakingDialog.js # ✅ Extracted
├── utils/
│   ├── GameUtils.js        # ✅ Extracted
│   └── Logger.js           # ✅ Existing
├── network/
│   ├── NetworkSync.js      # Existing
│   └── ActionQueue.js      # Existing
├── gpu/
│   ├── GPU.js              # Existing
│   ├── CAGrid.js           # Existing
│   └── CheckpointBuffer.js # Existing
└── audio/
    └── AudioEngine.js      # Existing
```

---

## Notes for Future Development

1. **Don't break multiplayer** - Test after every change
2. **Prefer callbacks over imports** - Avoids circular deps
3. **Keep main.js as orchestrator** - It wires everything together
4. **Test determinism** - Same seed + same actions = same result

