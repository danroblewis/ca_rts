/**
 * Missile Trait - THE canonical missile evaluation
 * 
 * This file contains all missile-related behavior:
 * - Spawn conditions (factory surrounded by units with outsiders)
 * - Building process (units deposit resources to build layers)
 * - Movement (toward destination, destroying everything in path)
 * - Explosion (5 cell radius, 10 frames)
 */

#ifndef MISSILE_GLSL
#define MISSILE_GLSL

#include "../core/types.glsl"
#include "../core/traits.glsl"
#include "../core/random.glsl"

// ============================================================================
// Missile Spawn Condition Check
// ============================================================================

/**
 * Count units of a specific player in a ring around a factory.
 * A "ring" is the cells at distance 2 from center (surrounding the 3x3 factory).
 */
int countUnitsInRing(vec2 factoryCenter, int player, sampler2D state, vec2 resolution) {
    int count = 0;
    
    for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
            // Only count the outer ring (Manhattan distance or Chebyshev distance = 2)
            if (abs(dx) != 2 && abs(dy) != 2) continue;
            
            vec2 checkPos = factoryCenter + vec2(float(dx), float(dy));
            if (checkPos.x < 0.0 || checkPos.y < 0.0 || 
                checkPos.x >= resolution.x || checkPos.y >= resolution.y) continue;
            
            vec4 cellRaw = texture(state, (checkPos + 0.5) / resolution);
            int cellType = getType(cellRaw);
            
            if (isUnit(cellType) && getPlayer(cellType) == player) {
                count++;
            }
        }
    }
    
    return count;
}

/**
 * Count units of a specific player that belong to a factory but are NOT in the ring.
 * These are "outsiders" that can operate while the missile is built.
 */
int countOutsiderUnits(vec2 factoryCenter, int player, sampler2D state, vec2 resolution) {
    int count = 0;
    
    // Scan a larger area around factory
    for (int dy = -10; dy <= 10; dy++) {
        for (int dx = -10; dx <= 10; dx++) {
            vec2 checkPos = factoryCenter + vec2(float(dx), float(dy));
            if (checkPos.x < 0.0 || checkPos.y < 0.0 || 
                checkPos.x >= resolution.x || checkPos.y >= resolution.y) continue;
            
            // Skip the ring area (distance 2 from center)
            if (abs(dx) <= 2 && abs(dy) <= 2) continue;
            
            vec4 cellRaw = texture(state, (checkPos + 0.5) / resolution);
            int cellType = getType(cellRaw);
            
            if (isUnit(cellType) && getPlayer(cellType) == player) {
                // Check if this unit belongs to this factory
                vec2 unitFactory = getUnitFactory(cellRaw);
                if (distance(unitFactory, factoryCenter) < 0.5) {
                    count++;
                }
            }
        }
    }
    
    return count;
}

/**
 * Check if a factory can spawn a missile.
 * Conditions:
 * 1. Factory must be fully built
 * 2. Factory must be surrounded by holding units (at least 8 in the ring)
 * 3. There must be at least 1 unit outside the ring belonging to this factory
 */
bool canSpawnMissile(vec2 factoryCenter, int player, sampler2D state, vec2 resolution) {
    // Check if factory is built
    if (!isFactoryBuilt(factoryCenter, state, resolution)) {
        return false;
    }
    
    // Count units in the ring
    int ringUnits = countUnitsInRing(factoryCenter, player, state, resolution);
    if (ringUnits < MISSILE_SURROUND_REQUIRED) {
        return false;
    }
    
    // Check for at least one outsider
    int outsiders = countOutsiderUnits(factoryCenter, player, state, resolution);
    return outsiders >= 1;
}

// ============================================================================
// Missile Building
// ============================================================================

/**
 * Result of checking for adjacent building units.
 */
struct MissileBuildResult {
    bool happened;       // Did a build happen?
    vec2 missilePos;     // Position of missile cell being built
    vec2 unitPos;        // Position of building unit
};

/**
 * Count adjacent holding units that can build a missile cell.
 */
int countMissileBuilders(vec2 missilePos, int missilePlayer, sampler2D state, vec2 resolution) {
    int count = 0;
    
    for (int dir = 1; dir <= 4; dir++) {  // Cardinal directions only
        vec2 offset = dirToOffset(dir);
        vec2 checkPos = missilePos + offset;
        
        if (checkPos.x < 0.0 || checkPos.y < 0.0 || 
            checkPos.x >= resolution.x || checkPos.y >= resolution.y) continue;
        
        vec4 cellRaw = texture(state, (checkPos + 0.5) / resolution);
        int cellType = getType(cellRaw);
        
        // Only same-player holding units can build
        if (isUnit(cellType) && getPlayer(cellType) == missilePlayer && getUnitHolding(cellRaw)) {
            count++;
        }
    }
    
    return count;
}

// ============================================================================
// Missile Movement
// ============================================================================

/**
 * Get direction for missile to move toward destination.
 */
int getMissileDirection(vec2 missileCenter, vec2 destination) {
    if (distance(missileCenter, destination) < 0.5) {
        return DIR_NONE;  // Already at destination
    }
    
    vec2 diff = destination - missileCenter;
    
    // Prefer diagonal if both axes differ
    bool canX = abs(diff.x) > 0.5;
    bool canY = abs(diff.y) > 0.5;
    
    if (canX && canY) {
        if (diff.x > 0.0 && diff.y > 0.0) return DIR_UP_RIGHT;
        if (diff.x < 0.0 && diff.y > 0.0) return DIR_UP_LEFT;
        if (diff.x < 0.0 && diff.y < 0.0) return DIR_DOWN_LEFT;
        if (diff.x > 0.0 && diff.y < 0.0) return DIR_DOWN_RIGHT;
    } else if (canX) {
        return diff.x > 0.0 ? DIR_RIGHT : DIR_LEFT;
    } else if (canY) {
        return diff.y > 0.0 ? DIR_UP : DIR_DOWN;
    }
    
    return DIR_NONE;
}

/**
 * Check if a position is part of the missile structure (3x3 around center).
 */
bool isPartOfMissile(vec2 pos, vec2 missileCenter) {
    vec2 diff = pos - missileCenter;
    return abs(diff.x) <= 1.5 && abs(diff.y) <= 1.5 && 
           !(abs(diff.x) < 0.5 && abs(diff.y) < 0.5);  // Not the center
}

// ============================================================================
// Missile Explosion
// ============================================================================

/**
 * Check if a position is within the explosion radius of an exploding missile.
 */
bool isInExplosionRadius(vec2 pos, vec2 missileCenter, int explosionTimer) {
    // Explosion expands over time
    float currentRadius = MISSILE_EXPLOSION_RADIUS * (float(explosionTimer) / float(MISSILE_EXPLOSION_DURATION));
    return distance(pos, missileCenter) <= currentRadius;
}

/**
 * Find any exploding missile that affects a position.
 * Returns the missile center if found, or vec2(-1.0) if not.
 */
vec2 findExplodingMissileAffecting(vec2 pos, sampler2D state, vec2 resolution) {
    // Scan area around position for exploding missiles
    int searchRadius = int(MISSILE_EXPLOSION_RADIUS) + 2;
    
    for (int dy = -searchRadius; dy <= searchRadius; dy++) {
        for (int dx = -searchRadius; dx <= searchRadius; dx++) {
            vec2 checkPos = pos + vec2(float(dx), float(dy));
            if (checkPos.x < 0.0 || checkPos.y < 0.0 || 
                checkPos.x >= resolution.x || checkPos.y >= resolution.y) continue;
            
            vec4 cellRaw = texture(state, (checkPos + 0.5) / resolution);
            int cellType = getType(cellRaw);
            
            if (isMissile(cellType)) {
                int state = getMissileState(cellRaw);
                if (state == MISSILE_EXPLODING) {
                    vec2 missileCenter = getMissileCenter(cellRaw);
                    int timer = getMissileExplosionTimer(cellRaw);
                    
                    if (isInExplosionRadius(pos, missileCenter, timer)) {
                        return missileCenter;
                    }
                }
            }
        }
    }
    
    return vec2(-1.0);
}

// ============================================================================
// Missile Update Logic
// ============================================================================

/**
 * Update a missile cell.
 * Returns the new cell state.
 */
vec4 updateMissileCell(vec4 myRaw, vec2 myPos, float time, sampler2D state, vec2 resolution) {
    int myType = getType(myRaw);
    int player = getPlayer(myType);
    int missileState = getMissileState(myRaw);
    vec2 center = getMissileCenter(myRaw);
    vec2 destination = getMissileDestination(myRaw);
    int explosionTimer = getMissileExplosionTimer(myRaw);
    
    // EXPLODING: Increment timer, disappear when done
    if (missileState == MISSILE_EXPLODING) {
        int newTimer = explosionTimer + 1;
        if (newTimer >= MISSILE_EXPLOSION_DURATION) {
            return encodeEmpty();  // Missile is gone after explosion
        }
        return encodeMissileExploding(newTimer, center, player);
    }
    
    // MOVING: Check if at destination, then explode. Otherwise move.
    if (missileState == MISSILE_MOVING) {
        if (distance(center, destination) < 1.5) {
            // At destination - start exploding
            return encodeMissileExploding(0, center, player);
        }
        
        // Move toward destination - the cell becomes empty, arrival handled separately
        int dir = getMissileDirection(center, destination);
        if (dir != DIR_NONE) {
            return encodeEmpty();  // This cell vacates as missile moves
        }
        
        return myRaw;  // Stay as-is if no direction
    }
    
    // ARMED: Waiting for destination (handled by command system)
    if (missileState == MISSILE_ARMED) {
        return myRaw;  // No change
    }
    
    // BUILDING: Check for adjacent units to build
    if (missileState == MISSILE_BUILDING) {
        float currentProgress = getMissileBuildProgress(myRaw);
        int builders = countMissileBuilders(myPos, player, state, resolution);
        
        float newProgress = min(currentProgress + float(builders), MAX_BUILD_PER_CELL);
        
        // Check if entire missile is now built
        float totalProgress = sumMissileBuildProgress(center, state, resolution);
        if (totalProgress + float(builders) >= MISSILE_BUILD_THRESHOLD) {
            return encodeMissileArmed(center, player, false);  // Newly armed, not selected yet
        }
        
        return encodeMissileBuilding(newProgress, center, player);
    }
    
    return myRaw;
}

// ============================================================================
// Missile Movement Result (for coordinated movement)
// ============================================================================

struct MissileMovementResult {
    bool happened;       // Did a missile arrive at this position?
    vec4 arrivingCell;   // The missile cell that's arriving
};

/**
 * Check if a moving missile is arriving at this position.
 * Returns the arriving missile cell if so.
 */
MissileMovementResult checkMissileArrival(vec2 myPos, sampler2D state, vec2 resolution) {
    MissileMovementResult result;
    result.happened = false;
    result.arrivingCell = vec4(0.0);
    
    // Check adjacent positions for moving missiles that would arrive here
    for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 checkPos = myPos + vec2(float(dx), float(dy));
            if (checkPos.x < 0.0 || checkPos.y < 0.0 || 
                checkPos.x >= resolution.x || checkPos.y >= resolution.y) continue;
            
            vec4 cellRaw = texture(state, (checkPos + 0.5) / resolution);
            int cellType = getType(cellRaw);
            
            if (isMissile(cellType) && getMissileState(cellRaw) == MISSILE_MOVING) {
                vec2 center = getMissileCenter(cellRaw);
                vec2 destination = getMissileDestination(cellRaw);
                
                // Only process if not at destination yet
                if (distance(center, destination) >= 1.5) {
                    int dir = getMissileDirection(center, destination);
                    if (dir != DIR_NONE) {
                        vec2 offset = dirToOffset(dir);
                        vec2 newCenter = center + offset;
                        
                        // Check if myPos is part of the missile's new position
                        vec2 cellOffset = checkPos - center;
                        vec2 newCellPos = newCenter + cellOffset;
                        
                        if (distance(newCellPos, myPos) < 0.5) {
                            // This missile is arriving at myPos
                            result.happened = true;
                            int player = getPlayer(cellType);
                            result.arrivingCell = encodeMissileMoving(destination, newCenter, player);
                            return result;
                        }
                    }
                }
            }
        }
    }
    
    return result;
}

// ============================================================================
// Factory → Missile Transformation
// ============================================================================

struct FactoryToMissileResult {
    bool shouldTransform;  // Should this factory cell become a missile?
    vec4 missileCell;      // The missile cell to become
};

/**
 * Check if a factory cell should transform into a missile cell.
 * Called for each factory cell.
 */
FactoryToMissileResult checkFactoryToMissile(vec2 myPos, vec4 myRaw, sampler2D state, vec2 resolution) {
    FactoryToMissileResult result;
    result.shouldTransform = false;
    result.missileCell = vec4(0.0);
    
    int myType = getType(myRaw);
    if (!isFactory(myType)) return result;
    
    vec2 factoryCenter = getFactoryPos(myRaw);
    int player = getPlayer(myType);
    
    // Skip center cell (will stay empty)
    if (distance(myPos, factoryCenter) < 0.5) return result;
    
    // Check spawn conditions
    if (!canSpawnMissile(factoryCenter, player, state, resolution)) return result;
    
    // This factory cell should become a missile cell!
    result.shouldTransform = true;
    result.missileCell = encodeMissileBuilding(0.0, factoryCenter, player);
    
    return result;
}

/**
 * Check if a position should be destroyed by a moving missile.
 * Returns true if the position is in the path of a moving missile.
 */
bool isInMissilePath(vec2 pos, sampler2D state, vec2 resolution) {
    // Scan for moving missiles that might be about to hit this position
    for (int dy = -3; dy <= 3; dy++) {
        for (int dx = -3; dx <= 3; dx++) {
            vec2 checkPos = pos + vec2(float(dx), float(dy));
            if (checkPos.x < 0.0 || checkPos.y < 0.0 || 
                checkPos.x >= resolution.x || checkPos.y >= resolution.y) continue;
            
            vec4 cellRaw = texture(state, (checkPos + 0.5) / resolution);
            int cellType = getType(cellRaw);
            
            if (isMissile(cellType) && getMissileState(cellRaw) == MISSILE_MOVING) {
                vec2 center = getMissileCenter(cellRaw);
                vec2 destination = getMissileDestination(cellRaw);
                int dir = getMissileDirection(center, destination);
                
                if (dir != DIR_NONE) {
                    vec2 offset = dirToOffset(dir);
                    vec2 nextCenter = center + offset;
                    
                    // Check if pos would be part of missile's next position
                    if (isPartOfMissile(pos, nextCenter)) {
                        return true;
                    }
                }
            }
        }
    }
    
    return false;
}

#endif

