#version 300 es
precision highp float;

/**
 * Mining Game v2 - Structured State Machine Approach
 * 
 * Key Architecture:
 * 1. Cell struct - typed representation of all cell data
 * 2. Intent struct - what a cell "wants to do" (move, deposit, spawn, etc.)
 * 3. getUnitIntent() - unified prediction of unit behavior
 * 4. Agreement: source and destination cells both call getUnitIntent()
 *    to ensure they agree on movement outcomes
 * 
 * Movement Conservation:
 * - Unit at A wants to move to B
 * - A calls getUnitIntent(A) and sees it should leave -> becomes EMPTY
 * - B calls getUnitIntent(A) and sees A wants to come here -> becomes UNIT
 * - Both run the SAME logic, so they always agree
 */

#include "./common/cell.glsl"
#include "./common/intent.glsl"

uniform sampler2D u_state;
uniform vec2 u_resolution;
uniform float u_time;

in vec2 v_uv;
out vec4 fragColor;

// ============================================================================
// Grid Sampling
// ============================================================================

vec2 g_texelSize;

vec4 sampleRaw(vec2 pos) {
    vec2 uv = (pos + 0.5) / u_resolution;
    return texture(u_state, uv);
}

Cell sampleCell(vec2 pos) {
    return parseCell(sampleRaw(pos));
}

// ============================================================================
// Vision System - Find nearest resource within range
// ============================================================================

vec2 findNearestResource(vec2 pos) {
    vec2 nearest = vec2(-1.0);
    float nearestDist = 999.0;
    
    for (int dy = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
        for (int dx = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 checkPos = pos + vec2(float(dx), float(dy));
            Cell c = sampleCell(checkPos);
            
            if (isResource(c)) {
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

// Find shared resource memory from nearby units
vec3 findSharedMemory(vec2 pos) {
    vec3 best = vec3(-1.0, -1.0, 0.0); // x, y, freshness
    float nearestDist = 999.0;
    
    for (int dy = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
        for (int dx = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 checkPos = pos + vec2(float(dx), float(dy));
            Cell c = sampleCell(checkPos);
            
            if (isUnit(c) && hasResourceMemory(c)) {
                float dist = abs(float(dx)) + abs(float(dy));
                if (dist < nearestDist) {
                    nearestDist = dist;
                    float shared = max(0.0, c.memoryFreshness - MEMORY_SHARE_PENALTY);
                    best = vec3(c.resourceMemory, shared);
                }
            }
        }
    }
    return best;
}

// ============================================================================
// Unit Intent Calculation
// THIS IS THE KEY FUNCTION - must be deterministic given (pos, time)
// Both source and destination cells call this to agree on movement
// ============================================================================

Intent getUnitIntent(vec2 pos) {
    Cell unit = sampleCell(pos);
    Intent intent;
    intent.action = INTENT_NONE;
    intent.direction = DIR_STAY;
    intent.cell = unit;
    
    if (!isUnit(unit)) {
        return intent;
    }
    
    // Decay memory freshness
    float freshness = max(0.0, unit.memoryFreshness - 1.0);
    vec2 resourceMem = unit.resourceMemory;
    if (freshness <= 0.0) {
        resourceMem = vec2(-1.0);
    }
    
    // Check if walking (unstuck mode)
    bool walking = isWalking(unit);
    
    // ========== HOLDING RESOURCE ==========
    if (unit.holding) {
        // Check if adjacent to our factory -> deposit
        vec2 factoryPos = unit.factoryPos;
        
        for (int d = 1; d <= 4; d++) {
            vec2 checkPos = pos + dirToOffset(d);
            Cell neighbor = sampleCell(checkPos);
            if (isFactory(neighbor) && distance(neighbor.selfPos, factoryPos) < 0.5) {
                // Adjacent to our factory - deposit (stay in place, become empty-handed)
                intent.action = INTENT_DEPOSIT;
                intent.direction = DIR_STAY;
                // Update cell state for deposit
                intent.cell.holding = false;
                intent.cell.stationaryCounter = 0;
                intent.cell.memoryFreshness = freshness;
                intent.cell.resourceMemory = resourceMem;
                return intent;
            }
        }
        
        // Not at factory - move toward it
        int dir;
        if (walking) {
            dir = randomDirection(pos, u_time);
        } else {
            dir = directionToward(pos, factoryPos, u_time + pos.x * 0.1);
        }
        
        if (dir != DIR_STAY) {
            intent.action = INTENT_MOVE;
            intent.direction = dir;
            intent.cell.memoryFreshness = freshness;
            intent.cell.resourceMemory = resourceMem;
        }
        return intent;
    }
    
    // ========== NOT HOLDING - SEARCHING ==========
    
    // Check if at remembered location with no resource nearby -> forget
    if (freshness > 0.0 && distance(pos, resourceMem) < 0.5) {
        bool foundNearby = false;
        for (int d = 1; d <= 4; d++) {
            Cell neighbor = sampleCell(pos + dirToOffset(d));
            if (isResource(neighbor)) {
                foundNearby = true;
                break;
            }
        }
        if (!foundNearby) {
            freshness = 0.0;
            resourceMem = vec2(-1.0);
        }
    }
    
    // Try to get shared memory if we don't have any
    if (freshness <= 0.0) {
        vec3 shared = findSharedMemory(pos);
        if (shared.z > 0.0) {
            resourceMem = shared.xy;
            freshness = shared.z;
        }
    }
    
    // Determine movement direction
    int dir;
    
    if (walking) {
        // Unstuck mode - random walk
        dir = randomDirection(pos, u_time);
    } else {
        // Look for visible resource
        vec2 visibleResource = findNearestResource(pos);
        
        if (visibleResource.x >= 0.0) {
            dir = directionToward(pos, visibleResource, u_time + pos.x * 0.1);
        } else if (freshness > 0.0) {
            // Go to remembered location
            dir = directionToward(pos, resourceMem, u_time + pos.x * 0.1);
        } else {
            // Random walk
            dir = randomDirection(pos, u_time);
        }
    }
    
    if (dir != DIR_STAY) {
        intent.action = INTENT_MOVE;
        intent.direction = dir;
        intent.cell.memoryFreshness = freshness;
        intent.cell.resourceMemory = resourceMem;
    }
    
    return intent;
}

// ============================================================================
// Collision Detection
// Check if we can move to target without losing to another unit
// ============================================================================

bool canWinMove(vec2 myPos, vec2 targetPos) {
    float myPriority = myPos.y * u_resolution.x + myPos.x;
    
    // Check all neighbors of target for competing units
    for (int d = 1; d <= 4; d++) {
        vec2 neighborPos = targetPos + dirToOffset(d);
        
        // Skip if this is us
        if (distance(neighborPos, myPos) < 0.5) continue;
        
        Cell neighbor = sampleCell(neighborPos);
        if (!isUnit(neighbor)) continue;
        
        // Get their intent
        Intent theirIntent = getUnitIntent(neighborPos);
        
        // Are they trying to move to the same target?
        if (theirIntent.action == INTENT_MOVE) {
            vec2 theirTarget = neighborPos + dirToOffset(theirIntent.direction);
            if (distance(theirTarget, targetPos) < 0.5) {
                // Collision! Lower priority wins
                float theirPriority = neighborPos.y * u_resolution.x + neighborPos.x;
                if (theirPriority < myPriority) {
                    return false; // They win, we stay
                }
            }
        }
    }
    
    return true; // We win or no collision
}

// ============================================================================
// Cell Update Functions
// ============================================================================

vec4 updateEmpty(vec2 pos, Cell self) {
    // Check if any neighbor unit is moving into us
    for (int d = 1; d <= 4; d++) {
        vec2 neighborPos = pos + dirToOffset(d);
        Cell neighbor = sampleCell(neighborPos);
        
        if (!isUnit(neighbor)) continue;
        
        Intent intent = getUnitIntent(neighborPos);
        
        // Is this unit moving toward us?
        if (intent.action == INTENT_MOVE && intent.direction == oppositeDir(d)) {
            // Check if they can actually make this move (collision check)
            if (canWinMove(neighborPos, pos)) {
                // Unit moves in! Update their state for arrival
                Cell arriving = intent.cell;
                
                // Handle stationary counter on arrival
                int newCounter;
                if (arriving.stationaryCounter >= int(STATIONARY_THRESHOLD)) {
                    newCounter = max(0, arriving.stationaryCounter - 1);
                } else {
                    newCounter = 0; // Reset on successful move
                }
                
                return encodeUnit(
                    arriving.holding,
                    newCounter,
                    arriving.factoryPos,
                    arriving.resourceMemory,
                    arriving.memoryFreshness
                );
            }
        }
    }
    
    // Check if factory below is spawning
    vec2 belowPos = pos + vec2(0.0, -1.0);
    Cell below = sampleCell(belowPos);
    if (isFactory(below) && below.resources >= SPAWN_COST) {
        // Factory spawns a unit here
        return encodeUnitSimple(false, 0, below.selfPos);
    }
    
    return encodeEmpty();
}

vec4 updateResource(vec2 pos, Cell self) {
    // Check if a non-holding unit is moving onto us
    for (int d = 1; d <= 4; d++) {
        vec2 neighborPos = pos + dirToOffset(d);
        Cell neighbor = sampleCell(neighborPos);
        
        if (!isUnit(neighbor) || neighbor.holding) continue;
        
        Intent intent = getUnitIntent(neighborPos);
        
        // Is this unit moving onto us (to mine)?
        if (intent.action == INTENT_MOVE && intent.direction == oppositeDir(d)) {
            if (canWinMove(neighborPos, pos)) {
                // Unit mines this resource!
                // They become holding, remember this location with fresh memory
                return encodeUnit(
                    true,  // now holding
                    0,     // reset counter
                    neighbor.factoryPos,
                    pos,   // remember THIS location
                    MEMORY_MAX_FRESHNESS
                );
            }
        }
    }
    
    return encodeResource(self.amount);
}

vec4 updateUnit(vec2 pos, Cell self) {
    Intent intent = getUnitIntent(pos);
    
    // Handle deposit (stay in place, become empty-handed)
    if (intent.action == INTENT_DEPOSIT) {
        return encodeUnit(
            false, // no longer holding
            0,
            self.factoryPos,
            intent.cell.resourceMemory,
            intent.cell.memoryFreshness
        );
    }
    
    // Handle movement
    if (intent.action == INTENT_MOVE) {
        vec2 targetPos = pos + dirToOffset(intent.direction);
        Cell target = sampleCell(targetPos);
        
        // Can only move to empty or resource
        if (isEmpty(target) || isResource(target)) {
            // Check collision
            if (canWinMove(pos, targetPos)) {
                // We leave! Become empty
                return encodeEmpty();
            }
        }
    }
    
    // Couldn't move - increment stationary counter
    int newCounter = self.stationaryCounter;
    bool walking = self.stationaryCounter >= int(STATIONARY_THRESHOLD);
    
    if (walking) {
        // In walking mode, decrement counter
        newCounter = max(0, newCounter - 1);
    } else {
        // Not walking, increment toward threshold
        newCounter = newCounter + 1;
    }
    
    // Decay memory
    float freshness = max(0.0, self.memoryFreshness - 1.0);
    vec2 resourceMem = freshness > 0.0 ? self.resourceMemory : vec2(-1.0);
    
    return encodeUnit(
        self.holding,
        newCounter,
        self.factoryPos,
        resourceMem,
        freshness
    );
}

vec4 updateFactory(vec2 pos, Cell self) {
    float resources = self.resources;
    
    // Count deposits from adjacent holding units that belong to us
    for (int d = 1; d <= 4; d++) {
        vec2 neighborPos = pos + dirToOffset(d);
        Cell neighbor = sampleCell(neighborPos);
        
        if (isUnit(neighbor) && neighbor.holding) {
            if (distance(neighbor.factoryPos, self.selfPos) < 0.5) {
                // This unit belongs to us and is depositing
                Intent intent = getUnitIntent(neighborPos);
                if (intent.action == INTENT_DEPOSIT) {
                    resources += 1.0;
                }
            }
        }
    }
    
    // Check if we should spawn (and space above is empty)
    vec2 abovePos = pos + vec2(0.0, 1.0);
    Cell above = sampleCell(abovePos);
    if (resources >= SPAWN_COST && isEmpty(above)) {
        resources -= SPAWN_COST;
    }
    
    return encodeFactory(resources, self.selfPos);
}

// ============================================================================
// Main
// ============================================================================

void main() {
    g_texelSize = 1.0 / u_resolution;
    vec2 pos = floor(v_uv * u_resolution);
    
    Cell self = sampleCell(pos);
    
    vec4 result;
    
    if (self.type == TYPE_EMPTY) {
        result = updateEmpty(pos, self);
    } else if (self.type == TYPE_RESOURCE) {
        result = updateResource(pos, self);
    } else if (self.type == TYPE_UNIT) {
        result = updateUnit(pos, self);
    } else if (self.type == TYPE_FACTORY) {
        result = updateFactory(pos, self);
    } else {
        result = encodeEmpty();
    }
    
    fragColor = result;
}
