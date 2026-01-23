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
// Memory Constants
// ============================================================================

const float MEMORY_MAX_FRESHNESS = 30.0;
const float MEMORY_SHARE_PENALTY = 5.0;
const int MEMORY_VISION_RANGE = 5;

// ============================================================================
// Memory Result - the updated memory state for a unit
// ============================================================================

struct MemoryState {
    bool hasMemory;
    vec2 position;
    float freshness;
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
// Helper: Find shared memory from nearby units
// Returns vec3(x, y, freshness) or (-1, -1, 0) if none
// ============================================================================

vec3 findNearbyMemory(vec2 pos, sampler2D state, vec2 resolution) {
    vec3 best = vec3(-1.0, -1.0, 0.0);
    float nearestDist = 999.0;
    
    for (int dy = -MEMORY_VISION_RANGE; dy <= MEMORY_VISION_RANGE; dy++) {
        for (int dx = -MEMORY_VISION_RANGE; dx <= MEMORY_VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 checkPos = pos + vec2(float(dx), float(dy));
            vec2 uv = (checkPos + 0.5) / resolution;
            vec4 cell = texture(state, uv);
            
            if (getType(cell) == TYPE_UNIT) {
                float freshness = getUnitMemoryFreshness(cell);
                if (freshness > 0.0) {
                    float dist = abs(float(dx)) + abs(float(dy));
                    if (dist < nearestDist) {
                        nearestDist = dist;
                        vec2 memPos = getUnitMemoryPos(cell);
                        // Apply share penalty
                        best = vec3(memPos, max(0.0, freshness - MEMORY_SHARE_PENALTY));
                    }
                }
            }
        }
    }
    return best;
}

// ============================================================================
// THE CANONICAL MEMORY EVALUATION
// 
// Determines the updated memory state for a unit.
// Handles: decay, forgetting at empty locations, knowledge sharing.
// Does NOT handle: acquiring memory from mining (that's in movement/transformArrival)
// ============================================================================

MemoryState evaluateMemory(vec2 pos, vec4 raw, sampler2D state, vec2 resolution) {
    MemoryState result;
    
    // Get current memory
    vec2 memPos = getUnitMemoryPos(raw);
    float freshness = getUnitMemoryFreshness(raw);
    
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
    
    // 4. If no memory and not holding, try to acquire from nearby unit
    if (freshness <= 0.0 && !getUnitHolding(raw)) {
        vec3 shared = findNearbyMemory(pos, state, resolution);
        if (shared.z > 0.0) {
            memPos = shared.xy;
            freshness = shared.z;
        }
    }
    
    result.hasMemory = (freshness > 0.0 && memPos.x >= 0.0);
    result.position = memPos;
    result.freshness = freshness;
    
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
    return result;
}

// ============================================================================
// Create empty memory
// ============================================================================

MemoryState noMemory() {
    MemoryState result;
    result.hasMemory = false;
    result.position = vec2(-1.0);
    result.freshness = 0.0;
    return result;
}

#endif
