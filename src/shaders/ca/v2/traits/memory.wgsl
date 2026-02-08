// Memory Trait - Resource location memory for mobile units
//
// Units can remember where they last found a resource.
// Memory has freshness that decays over time.
// Units can share memory with nearby memoryless units.
//
// This is the SINGLE SOURCE OF TRUTH for memory behavior.

#include "../core/types.wgsl"
#include "../core/traits.wgsl"

// ============================================================================
// Memory Result - the updated memory state for a unit
// ============================================================================

struct MemoryState {
    hasMemory: bool,
    position: vec2f,
    freshness: f32,
    homesickTimer: f32,  // Increments while wandering, triggers return when high
    factoryChanged: bool,  // True if factory was adopted from another unit
    newFactoryPos: vec2f,   // The new factory position (if changed)
};

// ============================================================================
// Helper: Check if there's a resource adjacent to position
// ============================================================================

fn hasAdjacentResource(pos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> bool {
    // Check all 8 directions since units can move diagonally
    for (var d: i32 = 1; d <= 8; d++) {
        let checkPos: vec2f = pos + dirToOffset(d);
        let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);
        if (getType(cell) == TYPE_RESOURCE) {
            return true;
        }
    }
    return false;
}

// ============================================================================
// Shared Knowledge - what a unit learns from nearby units
// ============================================================================

struct SharedKnowledge {
    found: bool,
    resourcePos: vec2f,
    freshness: f32,
    factoryPos: vec2f,  // Also adopt the sharing unit's factory
};

// ============================================================================
// Helper: Find shared knowledge from nearby units OF THE SAME PLAYER
// Returns resource memory AND factory location from the sharing unit
// ============================================================================

fn findNearbyKnowledge(pos: vec2f, myPlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> SharedKnowledge {
    var result: SharedKnowledge;
    result.found = false;
    result.resourcePos = vec2f(-1.0);
    result.freshness = 0.0;
    result.factoryPos = vec2f(-1.0);

    var nearestDist: f32 = 999.0;

    for (var dy: i32 = -MEMORY_VISION_RANGE; dy <= MEMORY_VISION_RANGE; dy++) {
        for (var dx: i32 = -MEMORY_VISION_RANGE; dx <= MEMORY_VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) { continue; }

            let checkPos: vec2f = pos + vec2f(f32(dx), f32(dy));
            let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);
            let cellType: i32 = getType(cell);

            // Only learn from units of the same player
            if (isUnit(cellType) && getPlayer(cellType) == myPlayer) {
                let freshness: f32 = getUnitMemoryFreshness(cell);
                if (freshness > 0.0) {
                    let dist: f32 = abs(f32(dx)) + abs(f32(dy));
                    if (dist < nearestDist) {
                        nearestDist = dist;
                        result.found = true;
                        result.resourcePos = getUnitMemoryPos(cell);
                        result.freshness = max(0.0, freshness - MEMORY_SHARE_PENALTY);
                        result.factoryPos = getUnitFactory(cell);  // Adopt their factory too!
                    }
                }
            }
        }
    }
    return result;
}

// ============================================================================
// Helper: Find nearest visible factory OF THE SAME PLAYER
// Returns factory position or (-1, -1) if none visible
// ============================================================================

fn findVisibleFactory(pos: vec2f, myPlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> vec2f {
    var nearestDist: f32 = 999.0;
    var nearestFactory: vec2f = vec2f(-1.0);

    for (var dy: i32 = -MEMORY_VISION_RANGE; dy <= MEMORY_VISION_RANGE; dy++) {
        for (var dx: i32 = -MEMORY_VISION_RANGE; dx <= MEMORY_VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) { continue; }

            let checkPos: vec2f = pos + vec2f(f32(dx), f32(dy));
            let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);
            let cellType: i32 = getType(cell);

            // Only find factories of the same player
            if (isFactory(cellType) && getPlayer(cellType) == myPlayer) {
                let dist: f32 = abs(f32(dx)) + abs(f32(dy));
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestFactory = getFactoryPos(cell);
                }
            }
        }
    }
    return nearestFactory;
}

// ============================================================================
// Helper: Check if unit is adjacent to its own factory (by position match)
// ============================================================================

fn isAdjacentToOwnFactory(pos: vec2f, factoryPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> bool {
    // Check all 8 directions since units can move diagonally
    for (var d: i32 = 1; d <= 8; d++) {
        let checkPos: vec2f = pos + dirToOffset(d);
        let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);
        let cellType: i32 = getType(cell);

        // Check both player factory types
        if (isFactory(cellType)) {
            let fPos: vec2f = getFactoryPos(cell);
            if (distance(fPos, factoryPos) < 0.5) {
                return true;
            }
        }
    }
    return false;
}

// ============================================================================
// Helper: Check if factory exists at expected location (for any player)
// Returns true if factory exists, false if it's gone (was deleted)
// ============================================================================

fn factoryExistsAt(factoryPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> bool {
    // Check if factory position is valid
    if (factoryPos.x < 0.0) { return false; }

    // Sample the factory location directly
    let cell: vec4f = textureLoad(state, vec2i(factoryPos), 0);
    let cellType: i32 = getType(cell);

    // Check both player factory types
    if (isFactory(cellType)) {
        // Verify it's the same factory (position matches)
        let fPos: vec2f = getFactoryPos(cell);
        return distance(fPos, factoryPos) < 0.5;
    }
    return false;
}

// ============================================================================
// Helper: Check if unit is near its factory location (within vision range)
// ============================================================================

fn isNearFactoryLocation(pos: vec2f, factoryPos: vec2f) -> bool {
    return factoryPos.x >= 0.0 && distance(pos, factoryPos) <= f32(MEMORY_VISION_RANGE);
}

// ============================================================================
// THE CANONICAL MEMORY EVALUATION
//
// Determines the updated memory state for a unit.
// Handles: decay, forgetting at empty locations, knowledge sharing, homesick timer.
// Does NOT handle: acquiring memory from mining (that's in movement/transformArrival)
// ============================================================================

fn evaluateMemory(pos: vec2f, raw: vec4f, myPlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> MemoryState {
    var result: MemoryState;
    result.factoryChanged = false;
    result.newFactoryPos = vec2f(-1.0);

    // Get current memory and homesick timer
    var memPos: vec2f = getUnitMemoryPos(raw);
    var freshness: f32 = getUnitMemoryFreshness(raw);
    var homesickTimer: f32 = getUnitHomesickTimer(raw);
    var factoryPos: vec2f = getUnitFactory(raw);

    // 1. Decay freshness
    freshness = max(0.0, freshness - 1.0);

    // 2. If freshness expired, forget
    if (freshness <= 0.0) {
        memPos = vec2f(-1.0);
    }

    // 3. If at remembered location with no adjacent resource, forget
    if (freshness > 0.0 && distance(pos, memPos) < 0.5) {
        if (!hasAdjacentResource(pos, state, resolution)) {
            freshness = 0.0;
            memPos = vec2f(-1.0);
        }
    }

    // 3.5. If near factory location but factory doesn't exist, forget factory
    //      This handles deleted factories - units will become "homeless"
    if (isNearFactoryLocation(pos, factoryPos) && !factoryExistsAt(factoryPos, state, resolution)) {
        // Factory was deleted! Forget it and become homeless
        factoryPos = vec2f(-1.0);
        result.factoryChanged = true;
        result.newFactoryPos = vec2f(-1.0);
    }

    // 4. If no memory and not holding, try to acquire knowledge from nearby unit OF SAME PLAYER
    //    This includes both resource location AND factory location!
    if (freshness <= 0.0 && !getUnitHolding(raw)) {
        let sharedKnow: SharedKnowledge = findNearbyKnowledge(pos, myPlayer, state, resolution);
        if (sharedKnow.found && sharedKnow.freshness > 0.0) {
            memPos = sharedKnow.resourcePos;
            freshness = sharedKnow.freshness;
            homesickTimer = 0.0;  // Found a lead, reset homesick
            // Also adopt the factory of the unit we learned from!
            result.factoryChanged = true;
            result.newFactoryPos = sharedKnow.factoryPos;
        }
    }

    // 4.5. If a factory OF SAME PLAYER is visible, adopt it as home (regardless of current state)
    //      Units only adopt their own player's factories, not enemy factories
    let visibleFactory: vec2f = findVisibleFactory(pos, myPlayer, state, resolution);
    if (visibleFactory.x >= 0.0 && distance(visibleFactory, factoryPos) > 0.5) {
        // Found a visible factory that's different from current home
        result.factoryChanged = true;
        result.newFactoryPos = visibleFactory;
    }

    // 5. If still no memory and not holding, manage homesick timer
    if (freshness <= 0.0 && !getUnitHolding(raw)) {
        // Check if we reached home (adjacent to factory) - reset and go back out
        if (homesickTimer >= HOMESICK_THRESHOLD && isAdjacentToOwnFactory(pos, factoryPos, state, resolution)) {
            homesickTimer = 0.0;  // Reset, will now explore again
        } else {
            homesickTimer += 1.0;
        }
    } else {
        // Has memory or is holding - reset homesick timer
        homesickTimer = 0.0;
    }

    result.hasMemory = (freshness > 0.0 && memPos.x >= 0.0);
    result.position = memPos;
    result.freshness = freshness;
    result.homesickTimer = homesickTimer;

    return result;
}

// ============================================================================
// Create fresh memory (when mining a resource)
// ============================================================================

fn createFreshMemory(resourcePos: vec2f) -> MemoryState {
    var result: MemoryState;
    result.hasMemory = true;
    result.position = resourcePos;
    result.freshness = MEMORY_MAX_FRESHNESS;
    result.homesickTimer = 0.0;  // Just found something, not homesick
    result.factoryChanged = false;
    result.newFactoryPos = vec2f(-1.0);
    return result;
}

// ============================================================================
// Create empty memory (optionally with existing homesick timer)
// ============================================================================

fn noMemory() -> MemoryState {
    var result: MemoryState;
    result.hasMemory = false;
    result.position = vec2f(-1.0);
    result.freshness = 0.0;
    result.homesickTimer = 0.0;
    result.factoryChanged = false;
    result.newFactoryPos = vec2f(-1.0);
    return result;
}

fn noMemoryWithTimer(timer: f32) -> MemoryState {
    var result: MemoryState;
    result.hasMemory = false;
    result.position = vec2f(-1.0);
    result.freshness = 0.0;
    result.homesickTimer = timer;
    result.factoryChanged = false;
    result.newFactoryPos = vec2f(-1.0);
    return result;
}

// ============================================================================
// Check if unit is homesick (should return to factory)
// ============================================================================

fn isHomesick(mem: MemoryState) -> bool {
    return !mem.hasMemory && mem.homesickTimer >= HOMESICK_THRESHOLD;
}

// ============================================================================
// Encode a unit with MemoryState object (cleaner API)
// ============================================================================

fn encodeUnit(player: i32, holding: bool, counter: i32, selected: bool, age: f32, factoryPos: vec2f, mem: MemoryState) -> vec4f {
    return encodeUnitRaw(player, holding, counter, selected, age, factoryPos, mem.position, mem.freshness, mem.homesickTimer);
}
