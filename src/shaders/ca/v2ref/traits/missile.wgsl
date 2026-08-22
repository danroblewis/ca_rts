// Missile Trait - THE canonical missile evaluation
//
// This file contains all missile-related behavior:
// - Spawn conditions (factory surrounded by units with outsiders)
// - Building process (units deposit resources to build layers)
// - Movement (toward destination, destroying everything in path)
// - Explosion (5 cell radius, 10 frames)

#include "../core/types.wgsl"
#include "../core/traits.wgsl"
#include "../core/random.wgsl"

// ============================================================================
// Missile Spawn Condition Check
// ============================================================================

// Count units of a specific player in a ring around a factory.
// A "ring" is the cells at distance 2 from center (surrounding the 3x3 factory).
fn countUnitsInRing(factoryCenter: vec2f, player: i32, state: texture_2d<f32>, resolution: vec2f) -> i32 {
    var count: i32 = 0;

    for (var dy: i32 = -2; dy <= 2; dy++) {
        for (var dx: i32 = -2; dx <= 2; dx++) {
            // Only count the outer ring (Manhattan distance or Chebyshev distance = 2)
            if (abs(dx) != 2 && abs(dy) != 2) { continue; }

            let checkPos: vec2f = factoryCenter + vec2f(f32(dx), f32(dy));
            if (checkPos.x < 0.0 || checkPos.y < 0.0 ||
                checkPos.x >= resolution.x || checkPos.y >= resolution.y) { continue; }

            let cellRaw: vec4f = textureLoad(state, vec2i(checkPos), 0);
            let cellType: i32 = getType(cellRaw);

            // Count any units of this player in the ring
            if (isUnit(cellType) && getPlayer(cellType) == player) {
                count++;
            }
        }
    }

    return count;
}

// Count units of a specific player that belong to a factory but are NOT in the ring.
// These are "outsiders" that can operate while the missile is built.
fn countOutsiderUnits(factoryCenter: vec2f, player: i32, state: texture_2d<f32>, resolution: vec2f) -> i32 {
    var count: i32 = 0;

    // Reduced search area for performance (was 10, now 5)
    for (var dy: i32 = -5; dy <= 5; dy++) {
        for (var dx: i32 = -5; dx <= 5; dx++) {
            let checkPos: vec2f = factoryCenter + vec2f(f32(dx), f32(dy));
            if (checkPos.x < 0.0 || checkPos.y < 0.0 ||
                checkPos.x >= resolution.x || checkPos.y >= resolution.y) { continue; }

            // Skip the ring area (distance 2 from center)
            if (abs(dx) <= 2 && abs(dy) <= 2) { continue; }

            let cellRaw: vec4f = textureLoad(state, vec2i(checkPos), 0);
            let cellType: i32 = getType(cellRaw);

            if (isUnit(cellType) && getPlayer(cellType) == player) {
                // Check if this unit belongs to this factory
                let unitFactory: vec2f = getUnitFactory(cellRaw);
                if (distance(unitFactory, factoryCenter) < 0.5) {
                    count++;
                }
            }
        }
    }

    return count;
}

// Check if a factory can spawn a missile.
// Conditions:
// 1. Factory must be fully built
// 2. Factory must be surrounded by holding units (at least 8 in the ring)
// 3. There must be at least 1 unit outside the ring belonging to this factory
fn canSpawnMissile(factoryCenter: vec2f, player: i32, state: texture_2d<f32>, resolution: vec2f) -> bool {
    // Check if factory is built
    if (!isFactoryBuilt(factoryCenter, state, resolution)) {
        return false;
    }

    // Count units in the ring
    let ringUnits: i32 = countUnitsInRing(factoryCenter, player, state, resolution);
    if (ringUnits < MISSILE_SURROUND_REQUIRED) {
        return false;
    }

    // Check for at least one outsider
    let outsiders: i32 = countOutsiderUnits(factoryCenter, player, state, resolution);
    return outsiders >= 1;
}

// ============================================================================
// Missile Building
// ============================================================================

// Result of checking for adjacent building units.
struct MissileBuildResult {
    happened: bool,       // Did a build happen?
    missilePos: vec2f,    // Position of missile cell being built
    unitPos: vec2f,       // Position of building unit
};

// Count nearby holding units that can build a missile cell.
// Checks both adjacent (distance 1) and ring (distance 2) positions.
// Units don't need to be perfectly adjacent - they contribute from nearby.
fn countMissileBuilders(missilePos: vec2f, missilePlayer: i32, state: texture_2d<f32>, resolution: vec2f) -> i32 {
    var count: i32 = 0;

    // Check in a 5x5 area centered on the missile cell (distance up to 2)
    for (var dy: i32 = -2; dy <= 2; dy++) {
        for (var dx: i32 = -2; dx <= 2; dx++) {
            if (dx == 0 && dy == 0) { continue; }  // Skip self

            let checkPos: vec2f = missilePos + vec2f(f32(dx), f32(dy));

            if (checkPos.x < 0.0 || checkPos.y < 0.0 ||
                checkPos.x >= resolution.x || checkPos.y >= resolution.y) { continue; }

            let cellRaw: vec4f = textureLoad(state, vec2i(checkPos), 0);
            let cellType: i32 = getType(cellRaw);

            // Only same-player holding units can build
            if (isUnit(cellType) && getPlayer(cellType) == missilePlayer && getUnitHolding(cellRaw)) {
                count++;
            }
        }
    }

    return count;
}

// ============================================================================
// Missile Movement
// ============================================================================

// Get direction for missile to move toward destination.
fn getMissileDirection(missileCenter: vec2f, destination: vec2f) -> i32 {
    if (distance(missileCenter, destination) < 0.5) {
        return DIR_NONE;  // Already at destination
    }

    let diff: vec2f = destination - missileCenter;

    // Prefer diagonal if both axes differ
    let canX: bool = abs(diff.x) > 0.5;
    let canY: bool = abs(diff.y) > 0.5;

    if (canX && canY) {
        if (diff.x > 0.0 && diff.y > 0.0) { return DIR_UP_RIGHT; }
        if (diff.x < 0.0 && diff.y > 0.0) { return DIR_UP_LEFT; }
        if (diff.x < 0.0 && diff.y < 0.0) { return DIR_DOWN_LEFT; }
        if (diff.x > 0.0 && diff.y < 0.0) { return DIR_DOWN_RIGHT; }
    } else if (canX) {
        return select(DIR_LEFT, DIR_RIGHT, diff.x > 0.0);
    } else if (canY) {
        return select(DIR_DOWN, DIR_UP, diff.y > 0.0);
    }

    return DIR_NONE;
}

// Check if a position is part of the missile structure (3x3 around center).
fn isPartOfMissile(pos: vec2f, missileCenter: vec2f) -> bool {
    let diff: vec2f = pos - missileCenter;
    return abs(diff.x) <= 1.5 && abs(diff.y) <= 1.5 &&
           !(abs(diff.x) < 0.5 && abs(diff.y) < 0.5);  // Not the center
}

// ============================================================================
// Missile Explosion
// ============================================================================

// Check if a position is within the explosion radius of an exploding missile.
fn isInExplosionRadius(pos: vec2f, missileCenter: vec2f, explosionTimer: i32) -> bool {
    // Explosion expands over time
    let currentRadius: f32 = MISSILE_EXPLOSION_RADIUS * (f32(explosionTimer) / f32(MISSILE_EXPLOSION_DURATION));
    return distance(pos, missileCenter) <= currentRadius;
}

// Find any exploding missile that affects a position.
// Returns the missile center if found, or vec2f(-1.0) if not.
fn findExplodingMissileAffecting(pos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> vec2f {
    // Reduced search radius for performance (was RADIUS+2=12, now just 5)
    // This limits explosion detection range but massively improves performance
    for (var dy: i32 = -5; dy <= 5; dy++) {
        for (var dx: i32 = -5; dx <= 5; dx++) {
            let checkPos: vec2f = pos + vec2f(f32(dx), f32(dy));
            if (checkPos.x < 0.0 || checkPos.y < 0.0 ||
                checkPos.x >= resolution.x || checkPos.y >= resolution.y) { continue; }

            let cellRaw: vec4f = textureLoad(state, vec2i(checkPos), 0);
            let cellType: i32 = getType(cellRaw);

            if (isMissile(cellType)) {
                let missileState: i32 = getMissileState(cellRaw);
                if (missileState == MISSILE_EXPLODING) {
                    let missileCenter: vec2f = getMissileCenter(cellRaw);
                    let timer: i32 = getMissileExplosionTimer(cellRaw);

                    if (isInExplosionRadius(pos, missileCenter, timer)) {
                        return missileCenter;
                    }
                }
            }
        }
    }

    return vec2f(-1.0);
}

// ============================================================================
// Missile Update Logic
// ============================================================================

// Update a missile cell.
// Returns the new cell state.
fn updateMissileCell(myRaw: vec4f, myPos: vec2f, time: f32, state: texture_2d<f32>, resolution: vec2f) -> vec4f {
    let myType: i32 = getType(myRaw);
    let player: i32 = getPlayer(myType);
    let missileState: i32 = getMissileState(myRaw);
    let center: vec2f = getMissileCenter(myRaw);
    let destination: vec2f = getMissileDestination(myRaw);
    let explosionTimer: i32 = getMissileExplosionTimer(myRaw);

    // EXPLODING: Increment timer, disappear when done
    if (missileState == MISSILE_EXPLODING) {
        let newTimer: i32 = explosionTimer + 1;
        if (newTimer >= MISSILE_EXPLOSION_DURATION) {
            return encodeEmpty();  // Missile is gone after explosion
        }
        return encodeMissileExploding(newTimer, center, player);
    }

    // MOVING: Check if at destination, then explode. Otherwise move.
    if (missileState == MISSILE_MOVING) {
        // Check if destination is valid
        if (destination.x < 0.0 || destination.y < 0.0) {
            // No valid destination - stay as MOVING but don't move
            return myRaw;
        }

        if (distance(center, destination) < 1.5) {
            // At destination - start exploding
            return encodeMissileExploding(0, center, player);
        }

        // Only move on certain frames (comically slow missile)
        let shouldMove: bool = (i32(time % f32(MISSILE_MOVE_DELAY)) == 0);
        if (!shouldMove) {
            return myRaw;  // Not a move frame - stay in place
        }

        // Move toward destination - the cell becomes empty, arrival handled separately
        let dir: i32 = getMissileDirection(center, destination);
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
        let currentProgress: f32 = getMissileBuildProgress(myRaw);
        let builders: i32 = countMissileBuilders(myPos, player, state, resolution);

        // Allow cells with adjacent units to contribute more (up to 15.0 per cell, limited by encoding)
        // This compensates for cells that have no adjacent units
        let maxProgressPerCell: f32 = 15.0;  // Max storable in 4 bits
        let newProgress: f32 = min(currentProgress + f32(builders), maxProgressPerCell);

        // Check if entire missile is now built
        let totalProgress: f32 = sumMissileBuildProgress(center, state, resolution);
        if (totalProgress + f32(builders) >= MISSILE_BUILD_THRESHOLD) {
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
    happened: bool,       // Did a missile arrive at this position?
    arrivingCell: vec4f,  // The missile cell that's arriving
};

// Check if a moving missile is arriving at this position.
// Returns the arriving missile cell if so.
fn checkMissileArrival(myPos: vec2f, time: f32, state: texture_2d<f32>, resolution: vec2f) -> MissileMovementResult {
    var result: MissileMovementResult;
    result.happened = false;
    result.arrivingCell = vec4f(0.0);

    // Only check for arrivals on move frames
    let shouldMove: bool = (i32(time % f32(MISSILE_MOVE_DELAY)) == 0);
    if (!shouldMove) {
        return result;  // Not a move frame
    }

    // Check adjacent positions for moving missiles that would arrive here
    for (var dy: i32 = -2; dy <= 2; dy++) {
        for (var dx: i32 = -2; dx <= 2; dx++) {
            if (dx == 0 && dy == 0) { continue; }

            let checkPos: vec2f = myPos + vec2f(f32(dx), f32(dy));
            if (checkPos.x < 0.0 || checkPos.y < 0.0 ||
                checkPos.x >= resolution.x || checkPos.y >= resolution.y) { continue; }

            let cellRaw: vec4f = textureLoad(state, vec2i(checkPos), 0);
            let cellType: i32 = getType(cellRaw);

            if (isMissile(cellType) && getMissileState(cellRaw) == MISSILE_MOVING) {
                let center: vec2f = getMissileCenter(cellRaw);
                let destination: vec2f = getMissileDestination(cellRaw);

                // Only process if not at destination yet
                if (distance(center, destination) >= 1.5) {
                    let dir: i32 = getMissileDirection(center, destination);
                    if (dir != DIR_NONE) {
                        let offset: vec2f = dirToOffset(dir);
                        let newCenter: vec2f = center + offset;

                        // Check if myPos is part of the missile's new position
                        let cellOffset: vec2f = checkPos - center;
                        let newCellPos: vec2f = newCenter + cellOffset;

                        if (distance(newCellPos, myPos) < 0.5) {
                            // This missile is arriving at myPos
                            result.happened = true;
                            let missilePlayer: i32 = getPlayer(cellType);
                            result.arrivingCell = encodeMissileMoving(destination, newCenter, missilePlayer);
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
// Factory -> Missile Transformation
// ============================================================================

struct FactoryToMissileResult {
    shouldTransform: bool,  // Should this factory cell become a missile?
    missileCell: vec4f,     // The missile cell to become
};

// Check if a factory cell should transform into a missile cell.
// Called for each factory cell.
fn checkFactoryToMissile(myPos: vec2f, myRaw: vec4f, state: texture_2d<f32>, resolution: vec2f) -> FactoryToMissileResult {
    var result: FactoryToMissileResult;
    result.shouldTransform = false;
    result.missileCell = vec4f(0.0);

    let myType: i32 = getType(myRaw);
    if (!isFactory(myType)) { return result; }

    let factoryCenter: vec2f = getFactoryPos(myRaw);
    let player: i32 = getPlayer(myType);

    // Skip center cell (will stay empty)
    if (distance(myPos, factoryCenter) < 0.5) { return result; }

    // Check spawn conditions
    if (!canSpawnMissile(factoryCenter, player, state, resolution)) { return result; }

    // This factory cell should become a missile cell!
    result.shouldTransform = true;
    result.missileCell = encodeMissileBuilding(0.0, factoryCenter, player);

    return result;
}

// Check if a position should be destroyed by a moving missile.
// Returns true if the position is within MISSILE_PATH_WIDTH of the missile's path.
fn isInMissilePath(pos: vec2f, time: f32, state: texture_2d<f32>, resolution: vec2f) -> bool {
    // Only destroy on move frames
    let shouldMove: bool = (i32(time % f32(MISSILE_MOVE_DELAY)) == 0);
    if (!shouldMove) {
        return false;  // Not a move frame
    }

    // Reduced search radius for performance (was PATH_WIDTH+3, now just 4)
    // Scan for moving missiles that might be about to hit this position
    for (var dy: i32 = -4; dy <= 4; dy++) {
        for (var dx: i32 = -4; dx <= 4; dx++) {
            let checkPos: vec2f = pos + vec2f(f32(dx), f32(dy));
            if (checkPos.x < 0.0 || checkPos.y < 0.0 ||
                checkPos.x >= resolution.x || checkPos.y >= resolution.y) { continue; }

            let cellRaw: vec4f = textureLoad(state, vec2i(checkPos), 0);
            let cellType: i32 = getType(cellRaw);

            if (isMissile(cellType) && getMissileState(cellRaw) == MISSILE_MOVING) {
                let center: vec2f = getMissileCenter(cellRaw);
                let destination: vec2f = getMissileDestination(cellRaw);
                let dir: i32 = getMissileDirection(center, destination);

                if (dir != DIR_NONE) {
                    let offset: vec2f = dirToOffset(dir);
                    let nextCenter: vec2f = center + offset;

                    // Check if pos is within 2 cells of missile's next center
                    let distToNextCenter: f32 = distance(pos, nextCenter);
                    if (distToNextCenter <= 2.0) {
                        return true;
                    }
                }
            }
        }
    }

    return false;
}
