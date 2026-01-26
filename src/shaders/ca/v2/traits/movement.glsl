/**
 * Movement Trait - THE canonical movement evaluation
 * 
 * This file contains THE function that determines movement behavior.
 * Every pixel in a region calls this SAME function and gets the SAME result.
 * Each pixel then extracts its role (source, destination, or uninvolved).
 * 
 * This is the SINGLE SOURCE OF TRUTH for movement.
 */

#ifndef MOVEMENT_GLSL
#define MOVEMENT_GLSL

#include "../core/types.glsl"
#include "../core/traits.glsl"
#include "../core/random.glsl"
#include "./memory.glsl"

// ============================================================================
// Movement Result - what happened in the local region
// ============================================================================

struct MovementResult {
    bool happened;      // Did a movement occur?
    vec2 fromPos;       // Source position
    vec2 toPos;         // Destination position
    vec4 arrivingCell;  // The cell data that arrives at destination
};

// ============================================================================
// Forward declarations for type-specific direction functions
// ============================================================================

int getUnitDirection(vec2 pos, vec4 raw, float time, sampler2D state, vec2 resolution);

// ============================================================================
// Movement Decision - where does a mobile cell want to go?
// 
// THIS IS THE ONLY TYPE-SPECIFIC PART OF MOVEMENT.
// To add a new mobile type, add a case here.
// ============================================================================

int getMobileDirection(vec2 pos, vec4 raw, float time, sampler2D state, vec2 resolution) {
    int cellType = getType(raw);
    
    // Both player 1 and player 2 units use the same movement logic
    if (isUnit(cellType)) {
        return getUnitDirection(pos, raw, time, state, resolution);
    }
    
    // Add new mobile types here:
    // if (cellType == TYPE_OTHER) return getOtherDirection(...);
    
    return DIR_NONE;
}

// ============================================================================
// Unit-specific movement logic
// ============================================================================

// Find nearest resource within vision
vec2 findResource(vec2 pos, sampler2D state, vec2 resolution) {
    vec2 texelSize = 1.0 / resolution;
    vec2 nearest = vec2(-1.0);
    float nearestDist = 999.0;
    
    for (int dy = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
        for (int dx = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 checkPos = pos + vec2(float(dx), float(dy));
            vec2 uv = (checkPos + 0.5) / resolution;
            vec4 cell = texture(state, uv);
            
            if (getType(cell) == TYPE_RESOURCE) {
                float dist = abs(float(dx)) + abs(float(dy));
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = checkPos;
                }
            }
        }
    }
    return nearest;
}

// Note: findNearbyMemory is now in memory.glsl

// Check if adjacent to own factory (by position match and player)
bool isAdjacentToFactory(vec2 pos, vec2 factoryPos, int myPlayer, sampler2D state, vec2 resolution) {
    for (int d = 1; d <= 4; d++) {
        vec2 checkPos = pos + dirToOffset(d);
        vec2 uv = (checkPos + 0.5) / resolution;
        vec4 cell = texture(state, uv);
        int cellType = getType(cell);
        
        // Must be a factory of the same player
        if (isFactory(cellType) && getPlayer(cellType) == myPlayer) {
            vec2 fPos = getFactoryPos(cell);
            if (distance(fPos, factoryPos) < 0.5) {
                return true;
            }
        }
    }
    return false;
}

// Check if adjacent to a buildable (unbuilt) factory OF SAME PLAYER (for holding units to build instead of move)
bool isAdjacentToBuildableFactory(vec2 pos, int myPlayer, sampler2D state, vec2 resolution) {
    for (int d = 1; d <= 4; d++) {
        vec2 checkPos = pos + dirToOffset(d);
        vec2 uv = (checkPos + 0.5) / resolution;
        vec4 cell = texture(state, uv);
        int cellType = getType(cell);
        
        // Only check factories of the same player
        if (isFactory(cellType) && getPlayer(cellType) == myPlayer) {
            vec2 center = getFactoryPos(cell);
            // Check if factory is NOT built yet
                float totalBuild = 0.0;
                for (int dy = -1; dy <= 1; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        vec2 cellPos = center + vec2(float(dx), float(dy));
                        vec4 cellRaw = texture(state, (cellPos + 0.5) / resolution);
                        if (isFactory(getType(cellRaw))) {
                            totalBuild += getFactoryBuildProgress(cellRaw);
                        }
                }
            }
            if (totalBuild < BUILD_THRESHOLD) {
                // Factory is not built, check if this cell can still be built
                float buildProgress = getFactoryBuildProgress(cell);
                if (buildProgress < MAX_BUILD_PER_CELL) {
                    return true;
                }
            }
        }
    }
    return false;
}

// Find nearest unbuilt factory OF SAME PLAYER that needs building within vision range
// Returns the position of the nearest buildable factory cell, or (-1, -1) if none found
vec2 findVisibleUnbuiltFactory(vec2 pos, int myPlayer, sampler2D state, vec2 resolution) {
    vec2 nearest = vec2(-1.0);
    float nearestDist = 999.0;
    
    for (int dy = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
        for (int dx = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 checkPos = pos + vec2(float(dx), float(dy));
            vec2 uv = (checkPos + 0.5) / resolution;
            vec4 cell = texture(state, uv);
            int cellType = getType(cell);
            
            // Only check factories of the same player
            if (isFactory(cellType) && getPlayer(cellType) == myPlayer) {
                vec2 center = getFactoryPos(cell);
                // Check if factory is NOT built yet
                    float totalBuild = 0.0;
                    for (int cdy = -1; cdy <= 1; cdy++) {
                        for (int cdx = -1; cdx <= 1; cdx++) {
                            vec2 cellPos = center + vec2(float(cdx), float(cdy));
                            vec4 cellRaw = texture(state, (cellPos + 0.5) / resolution);
                            if (isFactory(getType(cellRaw))) {
                                totalBuild += getFactoryBuildProgress(cellRaw);
                            }
                    }
                }
                if (totalBuild < BUILD_THRESHOLD) {
                    // Factory is not built, check if this cell can still be built
                    float buildProgress = getFactoryBuildProgress(cell);
                    if (buildProgress < MAX_BUILD_PER_CELL) {
                        float dist = abs(float(dx)) + abs(float(dy));
                        if (dist < nearestDist) {
                            nearestDist = dist;
                            nearest = checkPos;
                        }
                    }
                }
            }
        }
    }
    return nearest;
}

// Find nearest ENEMY factory within vision range (for attacking)
// Returns the position of the nearest enemy factory cell, or (-1, -1) if none found
vec2 findVisibleEnemyFactory(vec2 pos, int myPlayer, sampler2D state, vec2 resolution) {
    vec2 nearest = vec2(-1.0);
    float nearestDist = 999.0;
    
    for (int dy = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
        for (int dx = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 checkPos = pos + vec2(float(dx), float(dy));
            vec2 uv = (checkPos + 0.5) / resolution;
            vec4 cell = texture(state, uv);
            int cellType = getType(cell);
            
            // Check for enemy factories
            if (isFactory(cellType) && getPlayer(cellType) != myPlayer) {
                float dist = abs(float(dx)) + abs(float(dy));
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = checkPos;
                }
            }
        }
    }
    return nearest;
}

// Check if adjacent to an enemy factory (for attacking)
bool isAdjacentToEnemyFactory(vec2 pos, int myPlayer, sampler2D state, vec2 resolution) {
    for (int d = 1; d <= 4; d++) {
        vec2 checkPos = pos + dirToOffset(d);
        vec2 uv = (checkPos + 0.5) / resolution;
        vec4 cell = texture(state, uv);
        int cellType = getType(cell);
        
        if (isFactory(cellType) && getPlayer(cellType) != myPlayer) {
            return true;
        }
    }
    return false;
}

int getUnitDirection(vec2 pos, vec4 raw, float time, sampler2D state, vec2 resolution) {
    bool holding = getUnitHolding(raw);
    int counter = getUnitCounter(raw);
    vec2 factoryPos = getUnitFactory(raw);
    vec2 memoryPos = getUnitMemoryPos(raw);
    float freshness = getUnitMemoryFreshness(raw);
    float homesickTimer = getUnitHomesickTimer(raw);
    int myPlayer = getPlayer(getType(raw));
    
    bool walking = float(counter) >= STATIONARY_THRESHOLD;
    bool hasMemory = (freshness > 0.0 && memoryPos.x >= 0.0);
    bool homesick = (!hasMemory && homesickTimer >= HOMESICK_THRESHOLD);
    
    // Check if unit has a valid home factory
    bool hasHome = (factoryPos.x >= 0.0);
    
    // If holding and adjacent to own factory, don't move (deposit instead)
    if (holding && hasHome && isAdjacentToFactory(pos, factoryPos, myPlayer, state, resolution)) {
        return DIR_NONE;  // Will deposit, not move
    }
    
    // If holding and adjacent to buildable (unbuilt) factory OF SAME PLAYER, don't move (build instead)
    if (holding && isAdjacentToBuildableFactory(pos, myPlayer, state, resolution)) {
        return DIR_NONE;  // Will build, not move
    }
    
    // If NOT holding and adjacent to enemy factory, don't move (attack instead)
    if (!holding && isAdjacentToEnemyFactory(pos, myPlayer, state, resolution)) {
        return DIR_NONE;  // Will attack, not move
    }
    
    // If homesick and adjacent to own factory, stop (will reset timer in memory eval)
    if (homesick && hasHome && isAdjacentToFactory(pos, factoryPos, myPlayer, state, resolution)) {
        return DIR_NONE;  // Reached home, timer will reset
    }
    
    // Walking mode = random walk (stuck, trying to unstick)
    if (walking) {
        return randomDir(pos, time);
    }
    
    // Holding but homeless = random walk looking for a factory to adopt
    if (holding && !hasHome) {
        return randomDir(pos, time);  // Wander until we see a factory
    }
    
    // Holding with home = check for visible unbuilt factory OF SAME PLAYER first, then go to home factory
    if (holding) {
        // Prioritize building unbuilt factories of our own player if we can see one
        vec2 visibleUnbuilt = findVisibleUnbuiltFactory(pos, myPlayer, state, resolution);
        if (visibleUnbuilt.x >= 0.0) {
            return dirToward(pos, visibleUnbuilt, time + pos.x * 0.1);
        }
        // No unbuilt factory visible, go to home factory to deposit
        return dirToward(pos, factoryPos, time + pos.x * 0.1);
    }
    
    // Homesick but homeless = just random walk
    if (homesick && !hasHome) {
        return randomDir(pos, time);
    }
    
    // Homesick with home = go to factory (wandered too long without finding anything)
    if (homesick) {
        return dirToward(pos, factoryPos, time + pos.x * 0.1);
    }
    
    // Too far from home = return to factory (don't wander off the map!)
    if (hasHome && distance(pos, factoryPos) > MAX_WANDER_DISTANCE) {
        return dirToward(pos, factoryPos, time + pos.x * 0.1);
    }
    
    // Not holding = look for resources first
    vec2 visibleResource = findResource(pos, state, resolution);
    if (visibleResource.x >= 0.0) {
        return dirToward(pos, visibleResource, time + pos.x * 0.1);
    }
    
    // Not holding and no resources visible = look for enemy factories to attack
    vec2 visibleEnemy = findVisibleEnemyFactory(pos, myPlayer, state, resolution);
    if (visibleEnemy.x >= 0.0) {
        return dirToward(pos, visibleEnemy, time + pos.x * 0.1);
    }
    
    // Go to remembered location
    if (hasMemory) {
        if (distance(pos, memoryPos) > 0.5) {
            return dirToward(pos, memoryPos, time + pos.x * 0.1);
        }
    }
    
    // Random walk
    return randomDir(pos, time);
}

// ============================================================================
// Collision Resolution
// Lower position index wins (deterministic)
// ============================================================================

float getPriority(vec2 pos, vec2 resolution) {
    return pos.y * resolution.x + pos.x;
}

// ============================================================================
// THE CANONICAL MOVEMENT EVALUATION
// 
// Given a position, evaluate what movement (if any) affects this cell.
// This function is called by EVERY pixel. They all get the same result
// for the same inputs, so they all agree on what happens.
// 
// Returns: MovementResult describing what movement affects this position
// ============================================================================

MovementResult evaluateMovement(vec2 myPos, sampler2D state, vec2 resolution, float time) {
    MovementResult result;
    result.happened = false;
    result.fromPos = vec2(-1.0);
    result.toPos = vec2(-1.0);
    result.arrivingCell = vec4(0.0);
    
    vec4 myRaw = texture(state, (myPos + 0.5) / resolution);
    int myType = getType(myRaw);
    
    // ========================================
    // CASE 1: I'm a mobile cell - am I leaving?
    // ========================================
    if (isMobile(myType)) {
        int myDir = getMobileDirection(myPos, myRaw, time, state, resolution);
        
        if (myDir != DIR_NONE) {
            vec2 targetPos = myPos + dirToOffset(myDir);
            vec4 targetRaw = texture(state, (targetPos + 0.5) / resolution);
            int targetType = getType(targetRaw);
            
            // Check if this unit can move to the target
            // - Units can always move to empty cells
            // - Only NON-holding units can mine (move into minable cells)
            bool canMoveToTarget = (targetType == TYPE_EMPTY);
            if (isUnit(myType) && !getUnitHolding(myRaw) && isMinable(targetType)) {
                canMoveToTarget = true;  // Empty-handed unit can mine
            }
            
            if (canMoveToTarget) {
                // Check for collisions - am I the winner?
                bool iWin = true;
                float myPriority = getPriority(myPos, resolution);
                
                // Check all cells that might also want to move to targetPos
                for (int d = 1; d <= 4; d++) {
                    vec2 competitorPos = targetPos + dirToOffset(d);
                    if (distance(competitorPos, myPos) < 0.5) continue;  // Skip self
                    
                    vec4 competitorRaw = texture(state, (competitorPos + 0.5) / resolution);
                    if (!isMobile(getType(competitorRaw))) continue;
                    
                    int theirDir = getMobileDirection(competitorPos, competitorRaw, time, state, resolution);
                    vec2 theirTarget = competitorPos + dirToOffset(theirDir);
                    
                    if (distance(theirTarget, targetPos) < 0.5) {
                        // Collision! Lower priority wins
                        float theirPriority = getPriority(competitorPos, resolution);
                        if (theirPriority < myPriority) {
                            iWin = false;
                            break;
                        }
                    }
                }
                
                if (iWin) {
                    result.happened = true;
                    result.fromPos = myPos;
                    result.toPos = targetPos;
                    result.arrivingCell = myRaw;  // The arriving cell data
                    return result;
                }
            }
        }
    }
    
    // ========================================
    // CASE 2: I'm empty/minable - is someone moving into me?
    // ========================================
    if (myType == TYPE_EMPTY || isMinable(myType)) {
        // Check each neighbor
        for (int d = 1; d <= 4; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            int neighborType = getType(neighborRaw);
            
            if (!isMobile(neighborType)) continue;
            
            // If I'm a minable resource, only empty-handed units can mine me
            if (isMinable(myType)) {
                if (!isUnit(neighborType) || getUnitHolding(neighborRaw)) {
                    continue;  // Holding units can't mine
                }
            }
            
            int theirDir = getMobileDirection(neighborPos, neighborRaw, time, state, resolution);
            
            // Are they moving toward me?
            if (theirDir == oppositeDir(d)) {
                // Check if they win collision
                bool theyWin = true;
                float theirPriority = getPriority(neighborPos, resolution);
                
                for (int d2 = 1; d2 <= 4; d2++) {
                    vec2 otherPos = myPos + dirToOffset(d2);
                    if (distance(otherPos, neighborPos) < 0.5) continue;
                    
                    vec4 otherRaw = texture(state, (otherPos + 0.5) / resolution);
                    if (!isMobile(getType(otherRaw))) continue;
                    
                    int otherDir = getMobileDirection(otherPos, otherRaw, time, state, resolution);
                    vec2 otherTarget = otherPos + dirToOffset(otherDir);
                    
                    if (distance(otherTarget, myPos) < 0.5) {
                        float otherPriority = getPriority(otherPos, resolution);
                        if (otherPriority < theirPriority) {
                            theyWin = false;
                            break;
                        }
                    }
                }
                
                if (theyWin) {
                    result.happened = true;
                    result.fromPos = neighborPos;
                    result.toPos = myPos;
                    result.arrivingCell = neighborRaw;
                    return result;
                }
            }
        }
    }
    
    return result;
}

// ============================================================================
// Transform arriving cell based on what it's moving onto
// Uses Memory trait for memory state management
// ============================================================================

vec4 transformArrival(vec4 arrivingCell, vec4 destinationCell, vec2 destPos, sampler2D state, vec2 resolution) {
    int arrivingType = getType(arrivingCell);
    int destType = getType(destinationCell);
    
    // Unit arriving at resource = mine it
    if (isUnit(arrivingType) && destType == TYPE_RESOURCE) {
        bool wasHolding = getUnitHolding(arrivingCell);
        if (!wasHolding) {
            // Mine the resource! Create fresh memory of this location
            // Also resets homesick timer (createFreshMemory sets it to 0)
            MemoryState mem = createFreshMemory(destPos);
            
            // Check for factory adoption (homeless units can adopt visible factories OF SAME PLAYER)
            int myPlayer = getPlayer(arrivingType);
            vec2 factoryPos = getUnitFactory(arrivingCell);
            vec2 visibleFactory = findVisibleFactory(destPos, myPlayer, state, resolution);
            if (visibleFactory.x >= 0.0 && distance(visibleFactory, factoryPos) > 0.5) {
                factoryPos = visibleFactory;
            }
            
            return encodeUnit(
                myPlayer,
                true,  // now holding
                0,     // reset counter
                getUnitSelected(arrivingCell),  // preserve selection
                0.0,   // reset age (just mined successfully!)
                factoryPos,
                mem
            );
        }
    }
    
    // Unit arriving at empty = just move, update counter
    if (isUnit(arrivingType) && destType == TYPE_EMPTY) {
        int counter = getUnitCounter(arrivingCell);
        int newCounter;
        if (float(counter) >= STATIONARY_THRESHOLD) {
            newCounter = max(0, counter - 1);  // Walking, decrement
        } else {
            newCounter = 0;  // Successful move, reset
        }
        
        bool holding = getUnitHolding(arrivingCell);
        float homesickTimer = getUnitHomesickTimer(arrivingCell);
        float age = getUnitAge(arrivingCell);
        vec2 factoryPos = getUnitFactory(arrivingCell);
        int myPlayer = getPlayer(arrivingType);
        
        // Check for factory adoption - homeless or different visible factory OF SAME PLAYER
        vec2 visibleFactory = findVisibleFactory(destPos, myPlayer, state, resolution);
        if (visibleFactory.x >= 0.0 && distance(visibleFactory, factoryPos) > 0.5) {
            factoryPos = visibleFactory;
        }
        
        // Age handling:
        // - If holding, don't age
        // - If near BUILT factory, heal (reduce age) - unbuilt factories don't heal
        // - Otherwise, starve (increase age)
        bool nearFactory = (factoryPos.x >= 0.0 && distance(destPos, factoryPos) <= FACTORY_SAFE_ZONE);
        bool factoryIsBuilt = nearFactory && isFactoryBuilt(factoryPos, state, resolution);
        float newAge;
        if (holding) {
            newAge = age;
        } else if (factoryIsBuilt) {
            newAge = 0.0;  // Heal near BUILT factory
        } else {
            newAge = age + 1.0;  // Starving
        }
        
        // Only decay memory while NOT holding - preserve memory on return trip
        MemoryState mem;
        mem.factoryChanged = false;  // No factory change during movement
        mem.newFactoryPos = vec2(-1.0);
        
        if (holding) {
            // Keep memory intact while carrying resource back
            mem.position = getUnitMemoryPos(arrivingCell);
            mem.freshness = getUnitMemoryFreshness(arrivingCell);
            mem.hasMemory = mem.freshness > 0.0;
            mem.homesickTimer = 0.0;  // Not homesick when holding
        } else {
            // Decay memory while searching, preserve homesick timer
            float freshness = max(0.0, getUnitMemoryFreshness(arrivingCell) - 1.0);
            mem.position = freshness > 0.0 ? getUnitMemoryPos(arrivingCell) : vec2(-1.0);
            mem.freshness = freshness;
            mem.hasMemory = freshness > 0.0;
            // Increment homesick timer while searching without memory
            if (!mem.hasMemory) {
                mem.homesickTimer = homesickTimer + 1.0;
            } else {
                mem.homesickTimer = 0.0;
            }
        }
        
        return encodeUnit(
            myPlayer,
            holding,
            newCounter,
            getUnitSelected(arrivingCell),  // preserve selection
            newAge,
            factoryPos,
            mem
        );
    }
    
    return arrivingCell;
}

#endif
