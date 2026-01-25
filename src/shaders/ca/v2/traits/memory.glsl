/**
 * Memory Trait - Resource location memory for mobile units
 * 
 * Units can remember where they last found a resource.
 * Memory has freshness that decays over time.
 * Units can share memory with nearby memoryless units.
 * 
 * This is the SINGLE SOURCE OF TRUTH for memory behavior.
 */

#ifndef MEMORY_GLSL
#define MEMORY_GLSL

#include "../core/types.glsl"
#include "../core/traits.glsl"

// ============================================================================
// Memory Result - the updated memory state for a unit
// ============================================================================

struct MemoryState {
    bool hasMemory;
    vec2 position;
    float freshness;
    float homesickTimer;  // Increments while wandering, triggers return when high
    bool factoryChanged;  // True if factory was adopted from another unit
    vec2 newFactoryPos;   // The new factory position (if changed)
};

// ============================================================================
// Helper: Check if there's a resource adjacent to position
// ============================================================================

bool hasAdjacentResource(vec2 pos, sampler2D state, vec2 resolution) {
    for (int d = 1; d <= 4; d++) {
        vec2 checkPos = pos + dirToOffset(d);
        vec2 uv = (checkPos + 0.5) / resolution;
        vec4 cell = texture(state, uv);
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
    bool found;
    vec2 resourcePos;
    float freshness;
    vec2 factoryPos;  // Also adopt the sharing unit's factory
};

// ============================================================================
// Helper: Find shared knowledge from nearby units OF THE SAME PLAYER
// Returns resource memory AND factory location from the sharing unit
// ============================================================================

SharedKnowledge findNearbyKnowledge(vec2 pos, int myPlayer, sampler2D state, vec2 resolution) {
    SharedKnowledge result;
    result.found = false;
    result.resourcePos = vec2(-1.0);
    result.freshness = 0.0;
    result.factoryPos = vec2(-1.0);
    
    float nearestDist = 999.0;
    
    for (int dy = -MEMORY_VISION_RANGE; dy <= MEMORY_VISION_RANGE; dy++) {
        for (int dx = -MEMORY_VISION_RANGE; dx <= MEMORY_VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 checkPos = pos + vec2(float(dx), float(dy));
            vec2 uv = (checkPos + 0.5) / resolution;
            vec4 cell = texture(state, uv);
            int cellType = getType(cell);
            
            // Only learn from units of the same player
            if (isUnit(cellType) && getPlayer(cellType) == myPlayer) {
                float freshness = getUnitMemoryFreshness(cell);
                if (freshness > 0.0) {
                    float dist = abs(float(dx)) + abs(float(dy));
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

vec2 findVisibleFactory(vec2 pos, int myPlayer, sampler2D state, vec2 resolution) {
    float nearestDist = 999.0;
    vec2 nearestFactory = vec2(-1.0);
    
    for (int dy = -MEMORY_VISION_RANGE; dy <= MEMORY_VISION_RANGE; dy++) {
        for (int dx = -MEMORY_VISION_RANGE; dx <= MEMORY_VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 checkPos = pos + vec2(float(dx), float(dy));
            vec2 uv = (checkPos + 0.5) / resolution;
            vec4 cell = texture(state, uv);
            int cellType = getType(cell);
            
            // Only find factories of the same player
            if (isFactory(cellType) && getPlayer(cellType) == myPlayer) {
                float dist = abs(float(dx)) + abs(float(dy));
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

bool isAdjacentToOwnFactory(vec2 pos, vec2 factoryPos, sampler2D state, vec2 resolution) {
    for (int d = 1; d <= 4; d++) {
        vec2 checkPos = pos + dirToOffset(d);
        vec2 uv = (checkPos + 0.5) / resolution;
        vec4 cell = texture(state, uv);
        int cellType = getType(cell);
        
        // Check both player factory types
        if (isFactory(cellType)) {
            vec2 fPos = getFactoryPos(cell);
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

bool factoryExistsAt(vec2 factoryPos, sampler2D state, vec2 resolution) {
    // Check if factory position is valid
    if (factoryPos.x < 0.0) return false;
    
    // Sample the factory location directly
    vec2 uv = (factoryPos + 0.5) / resolution;
    vec4 cell = texture(state, uv);
    int cellType = getType(cell);
    
    // Check both player factory types
    if (isFactory(cellType)) {
        // Verify it's the same factory (position matches)
        vec2 fPos = getFactoryPos(cell);
        return distance(fPos, factoryPos) < 0.5;
    }
    return false;
}

// ============================================================================
// Helper: Check if unit is near its factory location (within vision range)
// ============================================================================

bool isNearFactoryLocation(vec2 pos, vec2 factoryPos) {
    return factoryPos.x >= 0.0 && distance(pos, factoryPos) <= float(MEMORY_VISION_RANGE);
}

// ============================================================================
// THE CANONICAL MEMORY EVALUATION
// 
// Determines the updated memory state for a unit.
// Handles: decay, forgetting at empty locations, knowledge sharing, homesick timer.
// Does NOT handle: acquiring memory from mining (that's in movement/transformArrival)
// ============================================================================

MemoryState evaluateMemory(vec2 pos, vec4 raw, int myPlayer, sampler2D state, vec2 resolution) {
    MemoryState result;
    result.factoryChanged = false;
    result.newFactoryPos = vec2(-1.0);
    
    // Get current memory and homesick timer
    vec2 memPos = getUnitMemoryPos(raw);
    float freshness = getUnitMemoryFreshness(raw);
    float homesickTimer = getUnitHomesickTimer(raw);
    vec2 factoryPos = getUnitFactory(raw);
    
    // 1. Decay freshness
    freshness = max(0.0, freshness - 1.0);
    
    // 2. If freshness expired, forget
    if (freshness <= 0.0) {
        memPos = vec2(-1.0);
    }
    
    // 3. If at remembered location with no adjacent resource, forget
    if (freshness > 0.0 && distance(pos, memPos) < 0.5) {
        if (!hasAdjacentResource(pos, state, resolution)) {
            freshness = 0.0;
            memPos = vec2(-1.0);
        }
    }
    
    // 3.5. If near factory location but factory doesn't exist, forget factory
    //      This handles deleted factories - units will become "homeless"
    if (isNearFactoryLocation(pos, factoryPos) && !factoryExistsAt(factoryPos, state, resolution)) {
        // Factory was deleted! Forget it and become homeless
        factoryPos = vec2(-1.0);
        result.factoryChanged = true;
        result.newFactoryPos = vec2(-1.0);
    }
    
    // 4. If no memory and not holding, try to acquire knowledge from nearby unit OF SAME PLAYER
    //    This includes both resource location AND factory location!
    if (freshness <= 0.0 && !getUnitHolding(raw)) {
        SharedKnowledge shared = findNearbyKnowledge(pos, myPlayer, state, resolution);
        if (shared.found && shared.freshness > 0.0) {
            memPos = shared.resourcePos;
            freshness = shared.freshness;
            homesickTimer = 0.0;  // Found a lead, reset homesick
            // Also adopt the factory of the unit we learned from!
            result.factoryChanged = true;
            result.newFactoryPos = shared.factoryPos;
        }
    }
    
    // 4.5. If a factory OF SAME PLAYER is visible, adopt it as home (regardless of current state)
    //      Units only adopt their own player's factories, not enemy factories
    vec2 visibleFactory = findVisibleFactory(pos, myPlayer, state, resolution);
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

MemoryState createFreshMemory(vec2 resourcePos) {
    MemoryState result;
    result.hasMemory = true;
    result.position = resourcePos;
    result.freshness = MEMORY_MAX_FRESHNESS;
    result.homesickTimer = 0.0;  // Just found something, not homesick
    result.factoryChanged = false;
    result.newFactoryPos = vec2(-1.0);
    return result;
}

// ============================================================================
// Create empty memory (optionally with existing homesick timer)
// ============================================================================

MemoryState noMemory() {
    MemoryState result;
    result.hasMemory = false;
    result.position = vec2(-1.0);
    result.freshness = 0.0;
    result.homesickTimer = 0.0;
    result.factoryChanged = false;
    result.newFactoryPos = vec2(-1.0);
    return result;
}

MemoryState noMemoryWithTimer(float timer) {
    MemoryState result;
    result.hasMemory = false;
    result.position = vec2(-1.0);
    result.freshness = 0.0;
    result.homesickTimer = timer;
    result.factoryChanged = false;
    result.newFactoryPos = vec2(-1.0);
    return result;
}

// ============================================================================
// Check if unit is homesick (should return to factory)
// ============================================================================

bool isHomesick(MemoryState mem) {
    return !mem.hasMemory && mem.homesickTimer >= HOMESICK_THRESHOLD;
}

// ============================================================================
// Encode a unit with MemoryState object (cleaner API)
// ============================================================================

vec4 encodeUnit(int player, bool holding, int counter, float age, vec2 factoryPos, MemoryState mem) {
    return encodeUnitRaw(player, holding, counter, age, factoryPos, mem.position, mem.freshness, mem.homesickTimer);
}

#endif
