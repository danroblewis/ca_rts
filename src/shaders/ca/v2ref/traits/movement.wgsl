// Movement Trait - THE canonical movement evaluation
//
// This file contains THE function that determines movement behavior.
// Every pixel in a region calls this SAME function and gets the SAME result.
// Each pixel then extracts its role (source, destination, or uninvolved).
//
// This is the SINGLE SOURCE OF TRUTH for movement.

#include "../core/types.wgsl"
#include "../core/traits.wgsl"
#include "../core/random.wgsl"
#include "./memory.wgsl"

// ============================================================================
// Movement Result - what happened in the local region
// ============================================================================

struct MovementResult {
    happened: bool,      // Did a movement occur?
    fromPos: vec2f,      // Source position
    toPos: vec2f,        // Destination position
    arrivingCell: vec4f, // The cell data that arrives at destination
};

// ============================================================================
// Forward declarations for type-specific direction functions
// (In WGSL, functions must be defined before use or use forward declaration)
// ============================================================================

// getUnitDirection is defined below

// ============================================================================
// Unit-specific movement logic
// ============================================================================

// Find nearest resource within vision
fn findResource(pos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> vec2f {
    var nearest: vec2f = vec2f(-1.0);
    var nearestDist: f32 = 999.0;

    for (var dy: i32 = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
        for (var dx: i32 = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) { continue; }

            let checkPos: vec2f = pos + vec2f(f32(dx), f32(dy));
            let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);

            if (getType(cell) == TYPE_RESOURCE) {
                let dist: f32 = abs(f32(dx)) + abs(f32(dy));
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = checkPos;
                }
            }
        }
    }
    return nearest;
}

// Note: findNearbyMemory is now in memory.wgsl

// Check if adjacent to own factory (by position match and player)
// Checks all 8 directions since units can move diagonally
fn isAdjacentToFactory(pos: vec2f, factoryPos: vec2f, myPlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> bool {
    for (var d: i32 = 1; d <= 8; d++) {
        let checkPos: vec2f = pos + dirToOffset(d);
        let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);
        let cellType: i32 = getType(cell);

        // Must be a factory of the same player
        if (isFactory(cellType) && getPlayer(cellType) == myPlayer) {
            let fPos: vec2f = getFactoryPos(cell);
            if (distance(fPos, factoryPos) < 0.5) {
                return true;
            }
        }
    }
    return false;
}

// Check if adjacent to a buildable (unbuilt) factory OF SAME PLAYER (for holding units to build instead of move)
// Checks all 8 directions since units can move diagonally
fn isAdjacentToBuildableFactory(pos: vec2f, myPlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> bool {
    for (var d: i32 = 1; d <= 8; d++) {
        let checkPos: vec2f = pos + dirToOffset(d);
        let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);
        let cellType: i32 = getType(cell);

        // Only check factories of the same player
        if (isFactory(cellType) && getPlayer(cellType) == myPlayer) {
            let center: vec2f = getFactoryPos(cell);
            // Check if factory is NOT built yet
            var totalBuild: f32 = 0.0;
            for (var dy: i32 = -1; dy <= 1; dy++) {
                for (var dx: i32 = -1; dx <= 1; dx++) {
                    let cellPos: vec2f = center + vec2f(f32(dx), f32(dy));
                    let cellRaw: vec4f = textureLoad(state, vec2i(cellPos), 0);
                    if (isFactory(getType(cellRaw))) {
                        totalBuild += getFactoryBuildProgress(cellRaw);
                    }
                }
            }
            if (totalBuild < BUILD_THRESHOLD) {
                // Factory is not built, check if this cell can still be built
                let buildProgress: f32 = getFactoryBuildProgress(cell);
                if (buildProgress < MAX_BUILD_PER_CELL) {
                    return true;
                }
            }
        }
    }
    return false;
}

// Check if near a BUILDING missile of same player (for holding units to build)
// Checks up to distance 2 to match the building range
fn isNearBuildingMissile(pos: vec2f, myPlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> bool {
    // Check in a 5x5 area (distance up to 2)
    for (var dy: i32 = -2; dy <= 2; dy++) {
        for (var dx: i32 = -2; dx <= 2; dx++) {
            if (dx == 0 && dy == 0) { continue; }

            let checkPos: vec2f = pos + vec2f(f32(dx), f32(dy));
            let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);
            let cellType: i32 = getType(cell);

            // Check for missile of same player in BUILDING state
            if (isMissile(cellType) && getPlayer(cellType) == myPlayer) {
                let missileState: i32 = getMissileState(cell);
                if (missileState == MISSILE_BUILDING) {
                    return true;
                }
            }
        }
    }
    return false;
}

// Find nearest unbuilt factory OF SAME PLAYER that needs building within vision range
// Returns the position of the nearest buildable factory cell, or (-1, -1) if none found
fn findVisibleUnbuiltFactory(pos: vec2f, myPlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> vec2f {
    var nearest: vec2f = vec2f(-1.0);
    var nearestDist: f32 = 999.0;

    for (var dy: i32 = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
        for (var dx: i32 = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) { continue; }

            let checkPos: vec2f = pos + vec2f(f32(dx), f32(dy));
            let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);
            let cellType: i32 = getType(cell);

            // Only check factories of the same player
            if (isFactory(cellType) && getPlayer(cellType) == myPlayer) {
                let center: vec2f = getFactoryPos(cell);
                // Check if factory is NOT built yet
                var totalBuild: f32 = 0.0;
                for (var cdy: i32 = -1; cdy <= 1; cdy++) {
                    for (var cdx: i32 = -1; cdx <= 1; cdx++) {
                        let cellPos: vec2f = center + vec2f(f32(cdx), f32(cdy));
                        let cellRaw: vec4f = textureLoad(state, vec2i(cellPos), 0);
                        if (isFactory(getType(cellRaw))) {
                            totalBuild += getFactoryBuildProgress(cellRaw);
                        }
                    }
                }
                if (totalBuild < BUILD_THRESHOLD) {
                    // Factory is not built, check if this cell can still be built
                    let buildProgress: f32 = getFactoryBuildProgress(cell);
                    if (buildProgress < MAX_BUILD_PER_CELL) {
                        let dist: f32 = abs(f32(dx)) + abs(f32(dy));
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
fn findVisibleEnemyFactory(pos: vec2f, myPlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> vec2f {
    var nearest: vec2f = vec2f(-1.0);
    var nearestDist: f32 = 999.0;

    for (var dy: i32 = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
        for (var dx: i32 = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) { continue; }

            let checkPos: vec2f = pos + vec2f(f32(dx), f32(dy));
            let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);
            let cellType: i32 = getType(cell);

            // Check for enemy factories
            if (isFactory(cellType) && getPlayer(cellType) != myPlayer) {
                let dist: f32 = abs(f32(dx)) + abs(f32(dy));
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
// Checks all 8 directions since units can move diagonally
fn isAdjacentToEnemyFactory(pos: vec2f, myPlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> bool {
    for (var d: i32 = 1; d <= 8; d++) {
        let checkPos: vec2f = pos + dirToOffset(d);
        let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);
        let cellType: i32 = getType(cell);

        if (isFactory(cellType) && getPlayer(cellType) != myPlayer) {
            return true;
        }
    }
    return false;
}

fn getUnitDirection(pos: vec2f, raw: vec4f, time: f32, state: texture_2d<f32>, resolution: vec2f) -> i32 {
    let holding: bool = getUnitHolding(raw);
    let counter: i32 = getUnitCounter(raw);
    let factoryPos: vec2f = getUnitFactory(raw);
    let memoryPos: vec2f = getUnitMemoryPos(raw);
    let freshness: f32 = getUnitMemoryFreshness(raw);
    let homesickTimer: f32 = getUnitHomesickTimer(raw);
    let myPlayer: i32 = getPlayer(getType(raw));

    let walking: bool = f32(counter) >= STATIONARY_THRESHOLD;
    let hasMemory: bool = (freshness > 0.0 && memoryPos.x >= 0.0);
    let homesick: bool = (!hasMemory && homesickTimer >= HOMESICK_THRESHOLD);

    // Check if unit has a valid home factory
    let hasHome: bool = (factoryPos.x >= 0.0);

    // If holding and adjacent to own factory, don't move (deposit instead)
    if (holding && hasHome && isAdjacentToFactory(pos, factoryPos, myPlayer, state, resolution)) {
        return DIR_NONE;  // Will deposit, not move
    }

    // If holding and adjacent to buildable (unbuilt) factory OF SAME PLAYER, don't move (build instead)
    if (holding && isAdjacentToBuildableFactory(pos, myPlayer, state, resolution)) {
        return DIR_NONE;  // Will build, not move
    }

    // If holding and near a BUILDING missile OF SAME PLAYER, don't move (build the missile)
    if (holding && isNearBuildingMissile(pos, myPlayer, state, resolution)) {
        return DIR_NONE;  // Will build missile, not move
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
        let visibleUnbuilt: vec2f = findVisibleUnbuiltFactory(pos, myPlayer, state, resolution);
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
    let visibleResource: vec2f = findResource(pos, state, resolution);
    if (visibleResource.x >= 0.0) {
        return dirToward(pos, visibleResource, time + pos.x * 0.1);
    }

    // Not holding and no resources visible = look for enemy factories to attack
    let visibleEnemy: vec2f = findVisibleEnemyFactory(pos, myPlayer, state, resolution);
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
// Movement Decision - where does a mobile cell want to go?
//
// THIS IS THE ONLY TYPE-SPECIFIC PART OF MOVEMENT.
// To add a new mobile type, add a case here.
// ============================================================================

fn getMobileDirection(pos: vec2f, raw: vec4f, time: f32, state: texture_2d<f32>, resolution: vec2f) -> i32 {
    let cellType: i32 = getType(raw);

    // Both player 1 and player 2 units use the same movement logic
    if (isUnit(cellType)) {
        return getUnitDirection(pos, raw, time, state, resolution);
    }

    // Add new mobile types here:
    // if (cellType == TYPE_OTHER) { return getOtherDirection(...); }

    return DIR_NONE;
}

// ============================================================================
// Collision Resolution
// Lower position index wins (deterministic)
// ============================================================================

fn getPriority(pos: vec2f, resolution: vec2f) -> f32 {
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

fn evaluateMovement(myPos: vec2f, state: texture_2d<f32>, resolution: vec2f, time: f32) -> MovementResult {
    var result: MovementResult;
    result.happened = false;
    result.fromPos = vec2f(-1.0);
    result.toPos = vec2f(-1.0);
    result.arrivingCell = vec4f(0.0);

    let myRaw: vec4f = textureLoad(state, vec2i(myPos), 0);
    let myType: i32 = getType(myRaw);

    // ========================================
    // CASE 1: I'm a mobile cell - am I leaving?
    // ========================================
    if (isMobile(myType)) {
        let myDir: i32 = getMobileDirection(myPos, myRaw, time, state, resolution);

        if (myDir != DIR_NONE) {
            let targetPos: vec2f = myPos + dirToOffset(myDir);

            // CRITICAL: Check bounds - don't move off the map!
            if (targetPos.x < 0.0 || targetPos.y < 0.0 ||
                targetPos.x >= resolution.x || targetPos.y >= resolution.y) {
                // Out of bounds, can't move there - stay in place
                return result;
            }

            let targetRaw: vec4f = textureLoad(state, vec2i(targetPos), 0);
            let targetType: i32 = getType(targetRaw);

            // Check if this unit can move to the target
            // - Units can always move to empty cells
            // - Only NON-holding units can mine (move into minable cells)
            var canMoveToTarget: bool = (targetType == TYPE_EMPTY);
            if (isUnit(myType) && !getUnitHolding(myRaw) && isMinable(targetType)) {
                canMoveToTarget = true;  // Empty-handed unit can mine
            }

            if (canMoveToTarget) {
                // Check for collisions - am I the winner?
                var iWin: bool = true;
                let myPriority: f32 = getPriority(myPos, resolution);

                // Check all cells that might also want to move to targetPos (8 directions)
                for (var d: i32 = 1; d <= 8; d++) {
                    let competitorPos: vec2f = targetPos + dirToOffset(d);
                    if (distance(competitorPos, myPos) < 0.5) { continue; }  // Skip self

                    // Skip out-of-bounds competitors
                    if (competitorPos.x < 0.0 || competitorPos.y < 0.0 ||
                        competitorPos.x >= resolution.x || competitorPos.y >= resolution.y) {
                        continue;
                    }

                    let competitorRaw: vec4f = textureLoad(state, vec2i(competitorPos), 0);
                    if (!isMobile(getType(competitorRaw))) { continue; }

                    let theirDir: i32 = getMobileDirection(competitorPos, competitorRaw, time, state, resolution);
                    let theirTarget: vec2f = competitorPos + dirToOffset(theirDir);

                    if (distance(theirTarget, targetPos) < 0.5) {
                        // Collision! Lower priority wins
                        let theirPriority: f32 = getPriority(competitorPos, resolution);
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
        // Check each neighbor (all 8 directions since units can move diagonally)
        for (var d: i32 = 1; d <= 8; d++) {
            let neighborPos: vec2f = myPos + dirToOffset(d);

            // Skip out-of-bounds neighbors
            if (neighborPos.x < 0.0 || neighborPos.y < 0.0 ||
                neighborPos.x >= resolution.x || neighborPos.y >= resolution.y) {
                continue;
            }

            let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);
            let neighborType: i32 = getType(neighborRaw);

            if (!isMobile(neighborType)) { continue; }

            // If I'm a minable resource, only empty-handed units can mine me
            if (isMinable(myType)) {
                if (!isUnit(neighborType) || getUnitHolding(neighborRaw)) {
                    continue;  // Holding units can't mine
                }
            }

            let theirDir: i32 = getMobileDirection(neighborPos, neighborRaw, time, state, resolution);

            // Are they moving toward me?
            if (theirDir == oppositeDir(d)) {
                // Check if they win collision
                var theyWin: bool = true;
                let theirPriority: f32 = getPriority(neighborPos, resolution);

                // Check all 8 directions
                for (var d2: i32 = 1; d2 <= 8; d2++) {
                    let otherPos: vec2f = myPos + dirToOffset(d2);
                    if (distance(otherPos, neighborPos) < 0.5) { continue; }

                    // Skip out-of-bounds positions
                    if (otherPos.x < 0.0 || otherPos.y < 0.0 ||
                        otherPos.x >= resolution.x || otherPos.y >= resolution.y) {
                        continue;
                    }

                    let otherRaw: vec4f = textureLoad(state, vec2i(otherPos), 0);
                    if (!isMobile(getType(otherRaw))) { continue; }

                    let otherDir: i32 = getMobileDirection(otherPos, otherRaw, time, state, resolution);
                    let otherTarget: vec2f = otherPos + dirToOffset(otherDir);

                    if (distance(otherTarget, myPos) < 0.5) {
                        let otherPriority: f32 = getPriority(otherPos, resolution);
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

fn transformArrival(arrivingCell: vec4f, destinationCell: vec4f, destPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> vec4f {
    let arrivingType: i32 = getType(arrivingCell);
    let destType: i32 = getType(destinationCell);

    // Unit arriving at resource = mine it
    if (isUnit(arrivingType) && destType == TYPE_RESOURCE) {
        let wasHolding: bool = getUnitHolding(arrivingCell);
        if (!wasHolding) {
            // Mine the resource! Create fresh memory of this location
            // Also resets homesick timer (createFreshMemory sets it to 0)
            let mem: MemoryState = createFreshMemory(destPos);

            // Check for factory adoption (homeless units can adopt visible factories OF SAME PLAYER)
            let myPlayer: i32 = getPlayer(arrivingType);
            var factoryPos: vec2f = getUnitFactory(arrivingCell);
            let visibleFactory: vec2f = findVisibleFactory(destPos, myPlayer, state, resolution);
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
        let counter: i32 = getUnitCounter(arrivingCell);
        var newCounter: i32;
        if (f32(counter) >= STATIONARY_THRESHOLD) {
            newCounter = max(0, counter - 1);  // Walking, decrement
        } else {
            newCounter = 0;  // Successful move, reset
        }

        let holding: bool = getUnitHolding(arrivingCell);
        let homesickTimer: f32 = getUnitHomesickTimer(arrivingCell);
        let age: f32 = getUnitAge(arrivingCell);
        var factoryPos: vec2f = getUnitFactory(arrivingCell);
        let myPlayer: i32 = getPlayer(arrivingType);

        // Check for factory adoption - homeless or different visible factory OF SAME PLAYER
        let visibleFactory: vec2f = findVisibleFactory(destPos, myPlayer, state, resolution);
        if (visibleFactory.x >= 0.0 && distance(visibleFactory, factoryPos) > 0.5) {
            factoryPos = visibleFactory;
        }

        // Age handling:
        // - If holding, don't age
        // - If near BUILT factory, heal (reduce age) - unbuilt factories don't heal
        // - Otherwise, starve (increase age)
        let nearFactory: bool = (factoryPos.x >= 0.0 && distance(destPos, factoryPos) <= FACTORY_SAFE_ZONE);
        let factoryIsBuilt: bool = nearFactory && isFactoryBuilt(factoryPos, state, resolution);
        var newAge: f32;
        if (holding) {
            newAge = age;
        } else if (factoryIsBuilt) {
            newAge = 0.0;  // Heal near BUILT factory
        } else {
            newAge = age + 1.0;  // Starving
        }

        // Only decay memory while NOT holding - preserve memory on return trip
        var mem: MemoryState;
        mem.factoryChanged = false;  // No factory change during movement
        mem.newFactoryPos = vec2f(-1.0);

        if (holding) {
            // Keep memory intact while carrying resource back
            mem.position = getUnitMemoryPos(arrivingCell);
            mem.freshness = getUnitMemoryFreshness(arrivingCell);
            mem.hasMemory = mem.freshness > 0.0;
            mem.homesickTimer = 0.0;  // Not homesick when holding
        } else {
            // Decay memory while searching, preserve homesick timer
            let freshness: f32 = max(0.0, getUnitMemoryFreshness(arrivingCell) - 1.0);
            mem.position = select(vec2f(-1.0), getUnitMemoryPos(arrivingCell), freshness > 0.0);
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
