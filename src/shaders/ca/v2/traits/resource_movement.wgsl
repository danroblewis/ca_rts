// Resource Movement Trait - Slow, organic movement of resource blobs
//
// Resources move slowly (every N ticks) and prefer to stay clumped together.
// Each resource has a phase offset so they don't all move at once.

#include "../core/types.wgsl"
#include "../core/random.wgsl"

// ============================================================================
// Configuration
// ============================================================================

// How often resources move (in simulation ticks)
// Higher = slower movement
const RESOURCE_MOVE_INTERVAL: f32 = 8.0;

// Vision range for finding other resources
const RESOURCE_VISION: i32 = 3;

// ============================================================================
// Resource Movement Result
// ============================================================================

struct ResourceMoveResult {
    happened: bool,      // Did a resource movement occur?
    fromPos: vec2f,      // Source position
    toPos: vec2f,        // Destination position
    movingCell: vec4f,   // The resource that's moving
};

// ============================================================================
// Check if a resource should move this tick
// ============================================================================

fn shouldResourceMove(raw: vec4f, time: f32) -> bool {
    let phase: f32 = getResourcePhase(raw);
    // Move when (time + phase) is divisible by interval
    return (time + phase) % RESOURCE_MOVE_INTERVAL < 1.0;
}

// ============================================================================
// Count nearby resources in a direction
// ============================================================================

fn countResourcesInDirection(pos: vec2f, dir: i32, state: texture_2d<f32>, resolution: vec2f) -> f32 {
    let offset: vec2f = dirToOffset(dir);
    var count: f32 = 0.0;

    // Check the cell in this direction and its neighbors
    for (var i: i32 = 1; i <= 2; i++) {
        let checkPos: vec2f = pos + offset * f32(i);

        // Bounds check
        if (checkPos.x < 0.0 || checkPos.x >= resolution.x ||
            checkPos.y < 0.0 || checkPos.y >= resolution.y) {
            continue;
        }

        let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);

        if (getType(cell) == TYPE_RESOURCE) {
            // Closer resources count more
            count += 1.0 / f32(i);
        }
    }

    return count;
}

// ============================================================================
// Find the best direction for a resource to move
// Uses purely random movement to avoid directional bias and line formation
// ============================================================================

fn getResourceDirection(pos: vec2f, raw: vec4f, time: f32, state: texture_2d<f32>, resolution: vec2f) -> i32 {
    // Create random seeds from position and time
    let seed1: f32 = hash(pos, time * 0.1);
    let seed2: f32 = hash(pos, time + 500.0);

    // Count neighbors in current position
    var currentNeighbors: f32 = 0.0;
    var hasAdjacentUnit: bool = false;

    for (var d: i32 = 1; d <= 8; d++) {
        let checkPos: vec2f = pos + dirToOffset(d);
        if (checkPos.x < 0.0 || checkPos.x >= resolution.x ||
            checkPos.y < 0.0 || checkPos.y >= resolution.y) {
            continue;
        }
        let cell: vec4f = textureLoad(state, vec2i(checkPos), 0);
        let cellType: i32 = getType(cell);
        if (cellType == TYPE_RESOURCE) {
            currentNeighbors += 1.0;
        }
        // Check for adjacent units (either player)
        if (cellType == TYPE_UNIT || cellType == TYPE_UNIT_P2) {
            hasAdjacentUnit = true;
        }
    }

    // Don't move if there's a unit adjacent - they might be trying to mine us
    if (hasAdjacentUnit) {
        return DIR_NONE;
    }

    // Resources with many neighbors are very stable - rarely move
    // This prevents the core of the blob from destabilizing
    // Stricter thresholds to prevent excessive spreading
    if (currentNeighbors >= 4.0) {
        return DIR_NONE;  // Very stable, never move
    }
    if (currentNeighbors >= 2.0 && seed1 > 0.08) {
        return DIR_NONE;  // Mostly stable, only 8% move
    }
    if (currentNeighbors >= 1.0 && seed1 > 0.15) {
        return DIR_NONE;  // Has neighbor, only 15% move
    }
    // Isolated resources (0 neighbors) - only move 40% of the time
    if (currentNeighbors < 1.0 && seed1 > 0.40) {
        return DIR_NONE;
    }

    // Collect all valid (empty) directions with their weights
    // Weight = base + density score (additive to ensure all directions have some probability)
    var validDirs: array<i32, 8>;
    var weights: array<f32, 8>;
    var totalWeight: f32 = 0.0;
    var numValid: i32 = 0;

    // Base weight ensures every direction has some probability
    // Reduced to make density dominate more, but non-zero to avoid line formation
    const BASE_WEIGHT: f32 = 0.3;

    for (var d: i32 = 1; d <= 8; d++) {
        let offset: vec2f = dirToOffset(d);
        let targetPos: vec2f = pos + offset;

        // Bounds check
        if (targetPos.x < 0.0 || targetPos.x >= resolution.x ||
            targetPos.y < 0.0 || targetPos.y >= resolution.y) {
            continue;
        }

        // Check if target is empty
        let targetCell: vec4f = textureLoad(state, vec2i(targetPos), 0);
        if (getType(targetCell) == TYPE_EMPTY) {
            // Calculate density score for this direction
            let densityScore: f32 = countResourcesInDirection(pos, d, state, resolution);

            // Weight = base + density * multiplier
            // This ensures low-density directions still have probability
            // but density is amplified to attract resources toward blob
            let weight: f32 = BASE_WEIGHT + densityScore * 2.0;

            validDirs[numValid] = d;
            weights[numValid] = weight;
            totalWeight += weight;
            numValid++;
        }
    }

    if (numValid == 0) {
        return DIR_NONE;  // No valid moves
    }

    // Weighted random selection - biased toward denser areas but with randomness
    let pick: f32 = seed2 * totalWeight;
    var cumulative: f32 = 0.0;

    for (var i: i32 = 0; i < numValid; i++) {
        cumulative += weights[i];
        if (pick < cumulative) {
            return validDirs[i];
        }
    }

    // Fallback to last valid direction
    return validDirs[numValid - 1];
}

// ============================================================================
// Collision Resolution - use hash for unbiased tie-breaking
// ============================================================================

fn getResourcePriority(pos: vec2f, time: f32, resolution: vec2f) -> f32 {
    // Use position-based hash that's consistent for the same tick
    // This avoids directional bias while remaining deterministic
    return hash(pos, floor(time / RESOURCE_MOVE_INTERVAL));
}

// Check if a resource at 'pos' wins the collision for moving to 'targetPos'
fn resourceWinsCollision(pos: vec2f, targetPos: vec2f, time: f32, state: texture_2d<f32>, resolution: vec2f) -> bool {
    let myPriority: f32 = getResourcePriority(pos, time, resolution);

    // Check all cells that might also want to move to targetPos (8 directions from target)
    for (var d: i32 = 1; d <= 8; d++) {
        let competitorPos: vec2f = targetPos + dirToOffset(d);
        if (distance(competitorPos, pos) < 0.5) { continue; }  // Skip self

        // Bounds check
        if (competitorPos.x < 0.0 || competitorPos.x >= resolution.x ||
            competitorPos.y < 0.0 || competitorPos.y >= resolution.y) {
            continue;
        }

        let competitorCell: vec4f = textureLoad(state, vec2i(competitorPos), 0);

        // Only check other resources that are moving this tick
        if (getType(competitorCell) != TYPE_RESOURCE) { continue; }
        if (!shouldResourceMove(competitorCell, time)) { continue; }

        let theirDir: i32 = getResourceDirection(competitorPos, competitorCell, time, state, resolution);
        if (theirDir == DIR_NONE) { continue; }

        let theirTarget: vec2f = competitorPos + dirToOffset(theirDir);

        if (distance(theirTarget, targetPos) < 0.5) {
            // Collision! Compare hash-based priorities (unbiased)
            // Higher priority wins - if they have higher priority, we lose
            let theirPriority: f32 = getResourcePriority(competitorPos, time, resolution);
            if (theirPriority > myPriority) {
                return false;  // They have higher priority, they win, we lose
            }
        }
    }

    return true;  // We win!
}

// ============================================================================
// Evaluate Resource Movement - THE canonical function
//
// Given a position, evaluate what movement (if any) affects this cell.
// This function is called by EVERY pixel. Each pixel only cares about:
//   1. Am I a resource that's leaving?
//   2. Is a resource arriving at me?
// ============================================================================

fn evaluateResourceMovement(myPos: vec2f, time: f32, state: texture_2d<f32>, resolution: vec2f) -> ResourceMoveResult {
    var result: ResourceMoveResult;
    result.happened = false;
    result.fromPos = vec2f(-1.0);
    result.toPos = vec2f(-1.0);
    result.movingCell = vec4f(0.0);

    let myRaw: vec4f = textureLoad(state, vec2i(myPos), 0);
    let myType: i32 = getType(myRaw);

    // ========================================
    // CASE 1: I'm a resource - am I leaving?
    // ========================================
    if (myType == TYPE_RESOURCE) {
        // Check if I should move this tick
        if (shouldResourceMove(myRaw, time)) {
            let myDir: i32 = getResourceDirection(myPos, myRaw, time, state, resolution);

            if (myDir != DIR_NONE) {
                let targetPos: vec2f = myPos + dirToOffset(myDir);

                // Bounds check
                if (targetPos.x >= 0.0 && targetPos.y >= 0.0 &&
                    targetPos.x < resolution.x && targetPos.y < resolution.y) {

                    let targetRaw: vec4f = textureLoad(state, vec2i(targetPos), 0);
                    let targetType: i32 = getType(targetRaw);

                    // Can only move to empty cells
                    if (targetType == TYPE_EMPTY) {
                        // Check collision resolution - do I win?
                        if (resourceWinsCollision(myPos, targetPos, time, state, resolution)) {
                            result.happened = true;
                            result.fromPos = myPos;
                            result.toPos = targetPos;
                            result.movingCell = myRaw;
                            return result;
                        }
                    }
                }
            }
        }
    }

    // ========================================
    // CASE 2: I'm empty - is a resource arriving?
    // ========================================
    if (myType == TYPE_EMPTY) {
        // Check all 8 neighbors for resources moving to me
        for (var d: i32 = 1; d <= 8; d++) {
            let neighborPos: vec2f = myPos + dirToOffset(d);

            // Bounds check
            if (neighborPos.x < 0.0 || neighborPos.y < 0.0 ||
                neighborPos.x >= resolution.x || neighborPos.y >= resolution.y) {
                continue;
            }

            let neighborRaw: vec4f = textureLoad(state, vec2i(neighborPos), 0);

            // Only check resources
            if (getType(neighborRaw) != TYPE_RESOURCE) { continue; }

            // Check if they should move this tick
            if (!shouldResourceMove(neighborRaw, time)) { continue; }

            let theirDir: i32 = getResourceDirection(neighborPos, neighborRaw, time, state, resolution);
            if (theirDir == DIR_NONE) { continue; }

            let theirTarget: vec2f = neighborPos + dirToOffset(theirDir);

            // Are they moving to me?
            if (distance(theirTarget, myPos) < 0.5) {
                // Check collision resolution - do they win?
                if (resourceWinsCollision(neighborPos, myPos, time, state, resolution)) {
                    result.happened = true;
                    result.fromPos = neighborPos;
                    result.toPos = myPos;
                    result.movingCell = neighborRaw;
                    return result;
                }
            }
        }
    }

    return result;
}
