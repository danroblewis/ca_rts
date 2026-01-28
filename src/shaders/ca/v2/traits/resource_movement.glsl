/**
 * Resource Movement Trait - Slow, organic movement of resource blobs
 * 
 * Resources move slowly (every N ticks) and prefer to stay clumped together.
 * Each resource has a phase offset so they don't all move at once.
 */

#ifndef RESOURCE_MOVEMENT_GLSL
#define RESOURCE_MOVEMENT_GLSL

#include "../core/types.glsl"
#include "../core/random.glsl"

// ============================================================================
// Configuration
// ============================================================================

// How often resources move (in simulation ticks)
// Higher = slower movement
const float RESOURCE_MOVE_INTERVAL = 8.0;

// Vision range for finding other resources
const int RESOURCE_VISION = 3;

// ============================================================================
// Resource Movement Result
// ============================================================================

struct ResourceMoveResult {
    bool happened;      // Did a resource movement occur?
    vec2 fromPos;       // Source position
    vec2 toPos;         // Destination position
    vec4 movingCell;    // The resource that's moving
};

// ============================================================================
// Check if a resource should move this tick
// ============================================================================

bool shouldResourceMove(vec4 raw, float time) {
    float phase = getResourcePhase(raw);
    // Move when (time + phase) is divisible by interval
    return mod(time + phase, RESOURCE_MOVE_INTERVAL) < 1.0;
}

// ============================================================================
// Count nearby resources in a direction
// ============================================================================

float countResourcesInDirection(vec2 pos, int dir, sampler2D state, vec2 resolution) {
    vec2 offset = dirToOffset(dir);
    float count = 0.0;
    
    // Check the cell in this direction and its neighbors
    for (int i = 1; i <= 2; i++) {
        vec2 checkPos = pos + offset * float(i);
        
        // Bounds check
        if (checkPos.x < 0.0 || checkPos.x >= resolution.x ||
            checkPos.y < 0.0 || checkPos.y >= resolution.y) {
            continue;
        }
        
        vec2 uv = (checkPos + 0.5) / resolution;
        vec4 cell = texture(state, uv);
        
        if (getType(cell) == TYPE_RESOURCE) {
            // Closer resources count more
            count += 1.0 / float(i);
        }
    }
    
    return count;
}

// ============================================================================
// Find the best direction for a resource to move
// Uses purely random movement to avoid directional bias and line formation
// ============================================================================

int getResourceDirection(vec2 pos, vec4 raw, float time, sampler2D state, vec2 resolution) {
    // Create random seeds from position and time
    float seed1 = hash(pos, time * 0.1);
    float seed2 = hash(pos, time + 500.0);
    
    // Count neighbors in current position
    float currentNeighbors = 0.0;
    bool hasAdjacentUnit = false;
    
    for (int d = 1; d <= 8; d++) {
        vec2 checkPos = pos + dirToOffset(d);
        if (checkPos.x < 0.0 || checkPos.x >= resolution.x ||
            checkPos.y < 0.0 || checkPos.y >= resolution.y) {
            continue;
        }
        vec2 uv = (checkPos + 0.5) / resolution;
        vec4 cell = texture(state, uv);
        int cellType = getType(cell);
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
    if (currentNeighbors >= 5.0) {
        return DIR_NONE;  // Very stable, never move
    }
    if (currentNeighbors >= 3.0 && seed1 > 0.1) {
        return DIR_NONE;  // Mostly stable, only 10% move
    }
    if (currentNeighbors >= 1.0 && seed1 > 0.3) {
        return DIR_NONE;  // Somewhat stable, only 30% move
    }
    
    // Collect all valid (empty) directions
    int validDirs[8];
    int numValid = 0;
    
    for (int d = 1; d <= 8; d++) {
        vec2 offset = dirToOffset(d);
        vec2 targetPos = pos + offset;
        
        // Bounds check
        if (targetPos.x < 0.0 || targetPos.x >= resolution.x ||
            targetPos.y < 0.0 || targetPos.y >= resolution.y) {
            continue;
        }
        
        // Check if target is empty
        vec2 uv = (targetPos + 0.5) / resolution;
        vec4 targetCell = texture(state, uv);
        if (getType(targetCell) == TYPE_EMPTY) {
            validDirs[numValid] = d;
            numValid++;
        }
    }
    
    if (numValid == 0) {
        return DIR_NONE;  // No valid moves
    }
    
    // Pick a random valid direction - purely random, no clumping bias
    // This prevents the positive feedback loop that causes line formation
    int pick = int(seed2 * float(numValid));
    if (pick >= numValid) pick = numValid - 1;
    
    return validDirs[pick];
}

// ============================================================================
// Collision Resolution - use hash for unbiased tie-breaking
// ============================================================================

float getResourcePriority(vec2 pos, float time, vec2 resolution) {
    // Use position-based hash that's consistent for the same tick
    // This avoids directional bias while remaining deterministic
    return hash(pos, floor(time / RESOURCE_MOVE_INTERVAL));
}

// Check if a resource at 'pos' wins the collision for moving to 'targetPos'
bool resourceWinsCollision(vec2 pos, vec2 targetPos, float time, sampler2D state, vec2 resolution) {
    float myPriority = getResourcePriority(pos, time, resolution);
    
    // Check all cells that might also want to move to targetPos (8 directions from target)
    for (int d = 1; d <= 8; d++) {
        vec2 competitorPos = targetPos + dirToOffset(d);
        if (distance(competitorPos, pos) < 0.5) continue;  // Skip self
        
        // Bounds check
        if (competitorPos.x < 0.0 || competitorPos.x >= resolution.x ||
            competitorPos.y < 0.0 || competitorPos.y >= resolution.y) {
            continue;
        }
        
        vec2 competitorUV = (competitorPos + 0.5) / resolution;
        vec4 competitorCell = texture(state, competitorUV);
        
        // Only check other resources that are moving this tick
        if (getType(competitorCell) != TYPE_RESOURCE) continue;
        if (!shouldResourceMove(competitorCell, time)) continue;
        
        int theirDir = getResourceDirection(competitorPos, competitorCell, time, state, resolution);
        if (theirDir == DIR_NONE) continue;
        
        vec2 theirTarget = competitorPos + dirToOffset(theirDir);
        
        if (distance(theirTarget, targetPos) < 0.5) {
            // Collision! Compare hash-based priorities (unbiased)
            // Higher priority wins - if they have higher priority, we lose
            float theirPriority = getResourcePriority(competitorPos, time, resolution);
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

ResourceMoveResult evaluateResourceMovement(vec2 myPos, float time, sampler2D state, vec2 resolution) {
    ResourceMoveResult result;
    result.happened = false;
    result.fromPos = vec2(-1.0);
    result.toPos = vec2(-1.0);
    result.movingCell = vec4(0.0);
    
    vec4 myRaw = texture(state, (myPos + 0.5) / resolution);
    int myType = getType(myRaw);
    
    // ========================================
    // CASE 1: I'm a resource - am I leaving?
    // ========================================
    if (myType == TYPE_RESOURCE) {
        // Check if I should move this tick
        if (shouldResourceMove(myRaw, time)) {
            int myDir = getResourceDirection(myPos, myRaw, time, state, resolution);
            
            if (myDir != DIR_NONE) {
                vec2 targetPos = myPos + dirToOffset(myDir);
                
                // Bounds check
                if (targetPos.x >= 0.0 && targetPos.y >= 0.0 && 
                    targetPos.x < resolution.x && targetPos.y < resolution.y) {
                    
                    vec4 targetRaw = texture(state, (targetPos + 0.5) / resolution);
                    int targetType = getType(targetRaw);
                    
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
        for (int d = 1; d <= 8; d++) {
            vec2 neighborPos = myPos + dirToOffset(d);
            
            // Bounds check
            if (neighborPos.x < 0.0 || neighborPos.y < 0.0 || 
                neighborPos.x >= resolution.x || neighborPos.y >= resolution.y) {
                continue;
            }
            
            vec4 neighborRaw = texture(state, (neighborPos + 0.5) / resolution);
            
            // Only check resources
            if (getType(neighborRaw) != TYPE_RESOURCE) continue;
            
            // Check if they should move this tick
            if (!shouldResourceMove(neighborRaw, time)) continue;
            
            int theirDir = getResourceDirection(neighborPos, neighborRaw, time, state, resolution);
            if (theirDir == DIR_NONE) continue;
            
            vec2 theirTarget = neighborPos + dirToOffset(theirDir);
            
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

#endif // RESOURCE_MOVEMENT_GLSL

