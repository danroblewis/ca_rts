/**
 * Demolish Trait - THE canonical demolish evaluation
 * 
 * Non-holding units adjacent to demolish-marked cells will destroy them
 * and pick up a resource in the process.
 * This is the SINGLE SOURCE OF TRUTH for demolition.
 */

#ifndef DEMOLISH_GLSL
#define DEMOLISH_GLSL

#include "../core/types.glsl"
#include "../core/traits.glsl"

// ============================================================================
// Demolish Result
// ============================================================================

struct DemolishResult {
    bool happened;
    vec2 unitPos;
    vec2 demolishPos;
};

// ============================================================================
// THE CANONICAL DEMOLISH EVALUATION
// 
// A non-holding unit adjacent to a demolish cell will destroy it and pick up a resource.
// ============================================================================

DemolishResult evaluateDemolish(vec2 myPos, sampler2D state, vec2 resolution) {
    DemolishResult result;
    result.happened = false;
    result.unitPos = vec2(-1.0);
    result.demolishPos = vec2(-1.0);
    
    vec4 myRaw = texture(state, (myPos + 0.5) / resolution);
    int myType = getType(myRaw);
    
    // ========================================
    // CASE 1: I'm a non-holding unit - am I demolishing?
    // ========================================
    if (myType == TYPE_UNIT && !getUnitHolding(myRaw)) {
        // Check neighbors for demolish cells (all 8 directions)
        for (int d = 1; d <= 8; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            
            if (getType(neighborRaw) == TYPE_DEMOLISH) {
                result.happened = true;
                result.unitPos = myPos;
                result.demolishPos = neighborPos;
                return result;
            }
        }
    }
    
    // ========================================
    // CASE 2: I'm a demolish cell - is a unit demolishing me?
    // ========================================
    if (myType == TYPE_DEMOLISH) {
        // Check all 8 directions since units can move diagonally
        for (int d = 1; d <= 8; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            
            if (getType(neighborRaw) == TYPE_UNIT && !getUnitHolding(neighborRaw)) {
                result.happened = true;
                result.unitPos = neighborPos;
                result.demolishPos = myPos;
                return result;
            }
        }
    }
    
    return result;
}

#endif

