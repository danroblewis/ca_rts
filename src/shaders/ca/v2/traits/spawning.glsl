/**
 * Spawning Trait - THE canonical spawning evaluation
 * 
 * Spawner cells (like factories) can create new cells.
 * This is the SINGLE SOURCE OF TRUTH for spawning.
 */

#ifndef SPAWNING_GLSL
#define SPAWNING_GLSL

#include "../core/types.glsl"
#include "../core/traits.glsl"

// ============================================================================
// Spawning Constants
// ============================================================================

const float SPAWN_COST = 10.0;

// ============================================================================
// Spawning Result
// ============================================================================

struct SpawnResult {
    bool happened;
    vec2 spawnerPos;
    vec2 spawnPos;
    vec4 spawnedCell;
};

// ============================================================================
// THE CANONICAL SPAWNING EVALUATION
// 
// Factory spawns UP only. Every pixel calls this to check if spawning
// affects them.
// ============================================================================

SpawnResult evaluateSpawning(vec2 myPos, sampler2D state, vec2 resolution) {
    SpawnResult result;
    result.happened = false;
    result.spawnerPos = vec2(-1.0);
    result.spawnPos = vec2(-1.0);
    result.spawnedCell = vec4(0.0);
    
    vec4 myRaw = texture(state, (myPos + 0.5) / resolution);
    int myType = getType(myRaw);
    
    // ========================================
    // CASE 1: I'm empty - is a spawner below me spawning?
    // ========================================
    if (myType == TYPE_EMPTY) {
        vec2 belowPos = myPos + vec2(0.0, -1.0);
        vec4 belowRaw = texture(state, (belowPos + 0.5) / resolution);
        
        if (getType(belowRaw) == TYPE_FACTORY) {
            float resources = getFactoryResources(belowRaw);
            if (resources >= SPAWN_COST) {
                // Spawn happening!
                result.happened = true;
                result.spawnerPos = belowPos;
                result.spawnPos = myPos;
                result.spawnedCell = encodeUnitSimple(false, 0, getFactoryPos(belowRaw));
                return result;
            }
        }
    }
    
    // ========================================
    // CASE 2: I'm a spawner - am I spawning?
    // ========================================
    if (myType == TYPE_FACTORY) {
        float resources = getFactoryResources(myRaw);
        if (resources >= SPAWN_COST) {
            vec2 abovePos = myPos + vec2(0.0, 1.0);
            vec4 aboveRaw = texture(state, (abovePos + 0.5) / resolution);
            
            if (getType(aboveRaw) == TYPE_EMPTY) {
                result.happened = true;
                result.spawnerPos = myPos;
                result.spawnPos = abovePos;
                result.spawnedCell = encodeUnitSimple(false, 0, getFactoryPos(myRaw));
                return result;
            }
        }
    }
    
    return result;
}

#endif
