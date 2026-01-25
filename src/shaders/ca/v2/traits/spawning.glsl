/**
 * Spawning Trait - THE canonical spawning evaluation
 * 
 * 3x3 Factory spawning:
 * - Factories are 3x3 grids with empty center (8 outer cells)
 * - The "top-middle" cell controls spawning (has left, right, corner factory neighbors)
 * - Resources are summed across all 8 factory cells
 * - When spawning, cost is subtracted equally from all 8 cells
 */

#ifndef SPAWNING_GLSL
#define SPAWNING_GLSL

#include "../core/types.glsl"
#include "../core/traits.glsl"

// ============================================================================
// Spawning Result
// ============================================================================

struct SpawnResult {
    bool happened;
    vec2 spawnerPos;      // Top-middle cell (spawn controller)
    vec2 spawnPos;        // Where the unit appears
    vec4 spawnedCell;
    vec2 factoryCenter;   // Center of the 3x3 factory (for resource subtraction)
};

// ============================================================================
// Helper: Check if a cell is the "top-middle" of a 3x3 factory
// Top-middle has factory neighbors: LEFT, RIGHT, and corner factories below
// Note: Center of factory is empty, so we check diagonal corners instead
// ============================================================================

bool isTopMiddleFactory(vec2 pos, sampler2D state, vec2 resolution) {
    vec4 myRaw = texture(state, (pos + 0.5) / resolution);
    if (getType(myRaw) != TYPE_FACTORY) return false;
    
    vec2 myCenter = getFactoryPos(myRaw);
    
    vec4 leftRaw = texture(state, (pos + vec2(-1.0, 0.0) + 0.5) / resolution);
    vec4 rightRaw = texture(state, (pos + vec2(1.0, 0.0) + 0.5) / resolution);
    vec4 aboveRaw = texture(state, (pos + vec2(0.0, 1.0) + 0.5) / resolution);
    // Check bottom-left and bottom-right corners (center is empty now)
    vec4 bottomLeftRaw = texture(state, (pos + vec2(-1.0, -1.0) + 0.5) / resolution);
    vec4 bottomRightRaw = texture(state, (pos + vec2(1.0, -1.0) + 0.5) / resolution);
    
    // Top-middle has:
    // - Left and right are factories with same center
    // - Above is NOT factory (spawn location)
    // - Bottom-left and bottom-right are factories with same center
    bool leftOK = getType(leftRaw) == TYPE_FACTORY && distance(getFactoryPos(leftRaw), myCenter) < 0.5;
    bool rightOK = getType(rightRaw) == TYPE_FACTORY && distance(getFactoryPos(rightRaw), myCenter) < 0.5;
    bool aboveOK = getType(aboveRaw) != TYPE_FACTORY;
    bool bottomLeftOK = getType(bottomLeftRaw) == TYPE_FACTORY && distance(getFactoryPos(bottomLeftRaw), myCenter) < 0.5;
    bool bottomRightOK = getType(bottomRightRaw) == TYPE_FACTORY && distance(getFactoryPos(bottomRightRaw), myCenter) < 0.5;
    
    return leftOK && rightOK && aboveOK && bottomLeftOK && bottomRightOK;
}

// ============================================================================
// Helper: Sum resources across 3x3 factory grid
// ============================================================================

float sumFactoryResources(vec2 centerPos, sampler2D state, vec2 resolution) {
    float total = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            vec2 cellPos = centerPos + vec2(float(dx), float(dy));
            vec4 cellRaw = texture(state, (cellPos + 0.5) / resolution);
            if (getType(cellRaw) == TYPE_FACTORY) {
                total += getFactoryResources(cellRaw);
            }
        }
    }
    return total;
}

// ============================================================================
// Helper: Check if I'm part of a spawning 3x3 factory
// Returns the top-middle position if spawning, otherwise (-1, -1)
// ============================================================================

vec2 getSpawningTopMiddle(vec2 myPos, sampler2D state, vec2 resolution) {
    // Check all 9 possible top-middle positions that could include me
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            vec2 candidateTopMiddle = myPos + vec2(float(dx), float(-dy));  // Note: -dy because top-middle is above center
            // Actually, let me think about this...
            // If I'm at myPos, the top-middle could be:
            // - myPos itself (if I'm the top-middle)
            // - myPos + (0, 1) if I'm the center
            // - myPos + (0, 2) if I'm the bottom-center
            // etc.
        }
    }
    
    // Simpler approach: if I'm a factory, get my center from selfPos,
    // then the top-middle is center + (0, 1)
    vec4 myRaw = texture(state, (myPos + 0.5) / resolution);
    if (getType(myRaw) != TYPE_FACTORY) return vec2(-1.0);
    
    vec2 center = getFactoryPos(myRaw);
    vec2 topMiddle = center + vec2(0.0, 1.0);
    
    // Check if top-middle can spawn
    vec4 topMiddleRaw = texture(state, (topMiddle + 0.5) / resolution);
    if (getType(topMiddleRaw) != TYPE_FACTORY) return vec2(-1.0);
    
    // Check if space above top-middle is empty
    vec2 spawnPos = topMiddle + vec2(0.0, 1.0);
    vec4 spawnRaw = texture(state, (spawnPos + 0.5) / resolution);
    if (getType(spawnRaw) != TYPE_EMPTY) return vec2(-1.0);
    
    // Check total resources
    float totalResources = sumFactoryResources(center, state, resolution);
    if (totalResources >= SPAWN_COST) {
        return topMiddle;
    }
    
    return vec2(-1.0);
}

// ============================================================================
// THE CANONICAL SPAWNING EVALUATION
// 
// 3x3 Factory spawns above its top-middle cell.
// Every pixel calls this to check if spawning affects them.
// ============================================================================

SpawnResult evaluateSpawning(vec2 myPos, sampler2D state, vec2 resolution) {
    SpawnResult result;
    result.happened = false;
    result.spawnerPos = vec2(-1.0);
    result.spawnPos = vec2(-1.0);
    result.spawnedCell = vec4(0.0);
    result.factoryCenter = vec2(-1.0);
    
    vec4 myRaw = texture(state, (myPos + 0.5) / resolution);
    int myType = getType(myRaw);
    
    // ========================================
    // CASE 1: I'm empty - is a factory below me spawning?
    // ========================================
    if (myType == TYPE_EMPTY) {
        vec2 belowPos = myPos + vec2(0.0, -1.0);
        vec4 belowRaw = texture(state, (belowPos + 0.5) / resolution);
        
        if (getType(belowRaw) == TYPE_FACTORY) {
            // Check if the factory below is the top-middle of a 3x3 factory
            if (isTopMiddleFactory(belowPos, state, resolution)) {
                vec2 center = getFactoryPos(belowRaw);
                float totalResources = sumFactoryResources(center, state, resolution);
                
                if (totalResources >= SPAWN_COST) {
                    result.happened = true;
                    result.spawnerPos = belowPos;
                    result.spawnPos = myPos;
                    result.spawnedCell = encodeUnitSimple(false, 0, center);
                    result.factoryCenter = center;
                    return result;
                }
            }
        }
    }
    
    // ========================================
    // CASE 2: I'm a factory - is my factory spawning?
    // ========================================
    if (myType == TYPE_FACTORY) {
        vec2 topMiddle = getSpawningTopMiddle(myPos, state, resolution);
        if (topMiddle.x >= 0.0) {
            vec2 center = getFactoryPos(myRaw);
            vec2 spawnPos = topMiddle + vec2(0.0, 1.0);
            
            result.happened = true;
            result.spawnerPos = topMiddle;
            result.spawnPos = spawnPos;
            result.spawnedCell = encodeUnitSimple(false, 0, center);
            result.factoryCenter = center;
            return result;
        }
    }
    
    return result;
}

#endif
