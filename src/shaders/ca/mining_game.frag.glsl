#version 300 es
precision highp float;

#include "common/cell_types.glsl"
#include "common/random.glsl"

uniform sampler2D u_state;
uniform vec2 u_resolution;
uniform float u_time;

in vec2 v_uv;
out vec4 fragColor;

// Shared state for helper functions
vec2 g_texelSize;
vec2 g_pos;
vec4 g_right, g_up, g_left, g_down;

// Sample neighbor at offset
vec4 sampleOffset(vec2 uv, vec2 offset) {
    return texture(u_state, uv + offset * g_texelSize);
}

// Vision range for units
const int VISION_RANGE = 5;

// Resources needed to spawn a new mining unit
const float SPAWN_COST = 5.0;

// Find nearest resource within vision range
vec2 findNearestResource(vec2 pos, vec2 uv) {
    vec2 nearestPos = vec2(-1.0);
    float nearestDist = 999.0;
    
    for (int dy = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
        for (int dx = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 offset = vec2(float(dx), float(dy));
            vec4 cell = sampleOffset(uv, offset);
            
            if (isResource(cell)) {
                float dist = abs(float(dx)) + abs(float(dy));
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestPos = pos + offset;
                }
            }
        }
    }
    return nearestPos;
}

// Find resource memory from a nearby unit (knowledge sharing)
// Returns vec3(x, y, freshness) or vec3(-1, -1, 0) if none found
vec3 getSharedResourceMemory(vec2 pos, vec2 uv) {
    vec3 sharedMemory = vec3(-1.0, -1.0, 0.0);
    float nearestDist = 999.0;
    
    for (int dy = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
        for (int dx = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 offset = vec2(float(dx), float(dy));
            vec4 cell = sampleOffset(uv, offset);
            
            // Check if it's a mining unit with resource memory
            if (isMiningUnit(cell) && hasLastResourceLocation(cell)) {
                float dist = abs(float(dx)) + abs(float(dy));
                float freshness = getMemoryFreshness(cell);
                // Prefer closer units, but also fresher memories
                if (dist < nearestDist) {
                    nearestDist = dist;
                    vec2 loc = getLastResourceLocation(cell);
                    // Apply share penalty when copying memory
                    float sharedFreshness = max(0.0, freshness - MEMORY_SHARE_PENALTY);
                    sharedMemory = vec3(loc.x, loc.y, sharedFreshness);
                }
            }
        }
    }
    return sharedMemory;
}

// Get the direction a unit would move
int getUnitMoveDirection(vec2 unitPos, vec4 unitCell, vec2 uv) {
    bool holding = isHoldingResource(unitCell);
    vec2 factoryLoc = getFactoryLocation(unitCell);
    
    if (holding) {
        return directionToward(unitPos, factoryLoc, u_time);
    }
    
    // Not holding: look for resources
    // 1. Check if there's a visible resource nearby
    vec2 resourcePos = findNearestResource(unitPos, uv);
    if (resourcePos.x >= 0.0) {
        return directionToward(unitPos, resourcePos, u_time);
    }
    
    // 2. Go to remembered resource location (if we have one and aren't there yet)
    if (hasLastResourceLocation(unitCell)) {
        vec2 lastPos = getLastResourceLocation(unitCell);
        if (distance(unitPos, lastPos) > 0.5) {
            return directionToward(unitPos, lastPos, u_time);
        }
        // If we're AT the remembered location, we'll check if resource is gone in updateMiningUnit
    }
    
    // 3. Random walk
    return randomDirection(unitPos, u_time);
}

// Check if a neighbor unit is moving into us (returns the unit cell, or empty)
vec4 checkUnitMovingIn(vec4 neighbor, vec2 neighborOffset, int expectedDir) {
    if (!isMiningUnit(neighbor)) return vec4(0.0);
    
    vec2 neighborPos = g_pos + neighborOffset;
    vec2 neighborUV = (neighborPos + 0.5) / u_resolution;
    int dir = getUnitMoveDirection(neighborPos, neighbor, neighborUV);
    
    if (dir == expectedDir) return neighbor;
    return vec4(0.0);
}

// Check if unit at myPos can move to targetPos without collision
// Returns true if we win the move (or no collision)
bool canMoveWithoutCollision(vec2 myPos, vec2 targetPos, vec2 targetUV) {
    // Check all 4 neighbors of the TARGET cell for other units trying to move there
    vec4 tRight = sampleOffset(targetUV, vec2(1, 0));
    vec4 tUp = sampleOffset(targetUV, vec2(0, 1));
    vec4 tLeft = sampleOffset(targetUV, vec2(-1, 0));
    vec4 tDown = sampleOffset(targetUV, vec2(0, -1));
    
    // For each neighbor of target, check if it's a unit moving INTO target
    // Direction: if neighbor is to the RIGHT of target, it would move LEFT (dir=3) to enter
    
    // Right of target (moving left into target)
    if (isMiningUnit(tRight)) {
        vec2 nPos = targetPos + vec2(1, 0);
        if (distance(nPos, myPos) > 0.5) { // Not us
            vec2 nUV = (nPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(nPos, tRight, nUV);
            if (dir == 3) {
                // Collision! Use position-based tiebreaker (lower y*width+x wins)
                float myPriority = myPos.y * u_resolution.x + myPos.x;
                float theirPriority = nPos.y * u_resolution.x + nPos.x;
                if (theirPriority < myPriority) return false; // They win
            }
        }
    }
    
    // Up of target (moving down into target)
    if (isMiningUnit(tUp)) {
        vec2 nPos = targetPos + vec2(0, 1);
        if (distance(nPos, myPos) > 0.5) {
            vec2 nUV = (nPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(nPos, tUp, nUV);
            if (dir == 4) {
                float myPriority = myPos.y * u_resolution.x + myPos.x;
                float theirPriority = nPos.y * u_resolution.x + nPos.x;
                if (theirPriority < myPriority) return false;
            }
        }
    }
    
    // Left of target (moving right into target)
    if (isMiningUnit(tLeft)) {
        vec2 nPos = targetPos + vec2(-1, 0);
        if (distance(nPos, myPos) > 0.5) {
            vec2 nUV = (nPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(nPos, tLeft, nUV);
            if (dir == 1) {
                float myPriority = myPos.y * u_resolution.x + myPos.x;
                float theirPriority = nPos.y * u_resolution.x + nPos.x;
                if (theirPriority < myPriority) return false;
            }
        }
    }
    
    // Down of target (moving up into target)
    if (isMiningUnit(tDown)) {
        vec2 nPos = targetPos + vec2(0, -1);
        if (distance(nPos, myPos) > 0.5) {
            vec2 nUV = (nPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(nPos, tDown, nUV);
            if (dir == 2) {
                float myPriority = myPos.y * u_resolution.x + myPos.x;
                float theirPriority = nPos.y * u_resolution.x + nPos.x;
                if (theirPriority < myPriority) return false;
            }
        }
    }
    
    return true; // No collision, or we win
}

// Helper: Process incoming unit - adjust counter on arrival
vec4 processIncomingUnit(vec4 unit) {
    if (!isMiningUnit(unit)) return unit;
    
    float holding = getHoldingBit(unit);
    float counter = getStationaryCounter(unit);
    vec2 factoryLoc = getFactoryLocation(unit);
    vec2 lastResourceLoc = getLastResourceLocation(unit);
    float freshness = getMemoryFreshness(unit);
    bool hasMemory = hasLastResourceLocation(unit);
    
    // If walking, decrement counter. Otherwise reset to 0 (successful move).
    float newCounter;
    if (counter >= STATIONARY_THRESHOLD) {
        newCounter = max(0.0, counter - 1.0); // Decrement during walk
    } else {
        newCounter = 0.0; // Reset on successful normal move
    }
    
    // Memory also decays on move (already decayed in updateMiningUnit, but we preserve it here)
    if (hasMemory) {
        return createMiningUnitWithMemory(holding, newCounter, factoryLoc, lastResourceLoc, freshness);
    } else {
        return createMiningUnitSimple(holding, newCounter, factoryLoc);
    }
}

// ============================================================================
// EMPTY CELL - Check if unit moves in or factory spawns here
// ============================================================================
vec4 updateEmpty(vec4 self) {
    vec4 incoming;
    
    // Check right neighbor moving left (dir=3)
    incoming = checkUnitMovingIn(g_right, vec2(1, 0), 3);
    if (incoming.r > 0.0) return processIncomingUnit(incoming);
    
    // Check up neighbor moving down (dir=4)
    incoming = checkUnitMovingIn(g_up, vec2(0, 1), 4);
    if (incoming.r > 0.0) return processIncomingUnit(incoming);
    
    // Check left neighbor moving right (dir=1)
    incoming = checkUnitMovingIn(g_left, vec2(-1, 0), 1);
    if (incoming.r > 0.0) return processIncomingUnit(incoming);
    
    // Check down neighbor moving up (dir=2)
    incoming = checkUnitMovingIn(g_down, vec2(0, -1), 2);
    if (incoming.r > 0.0) return processIncomingUnit(incoming);
    
    // Check if factory below is spawning (factory only spawns UP)
    if (isMiningFactory(g_down) && getFactoryResourceCount(g_down) >= SPAWN_COST) {
        vec2 facPos = getFactoryPosition(g_down);
        return createMiningUnitSimple(0.0, 0.0, facPos); // New unit, no resource memory, counter=0
    }
    
    return self;
}

// ============================================================================
// RESOURCE CELL - Check if unit mines us
// ============================================================================
vec4 updateResource(vec4 self) {
    // Check if any adjacent non-holding unit is moving onto us
    // When mined, the unit remembers THIS location (g_pos) as last resource
    
    // Right neighbor moving left
    if (isMiningUnit(g_right) && !isHoldingResource(g_right)) {
        vec2 nPos = g_pos + vec2(1, 0);
        vec2 nUV = (nPos + 0.5) / u_resolution;
        if (getUnitMoveDirection(nPos, g_right, nUV) == 3) {
            vec2 fac = getFactoryLocation(g_right);
            return createMiningUnit(1.0, 0.0, fac, g_pos); // Remember this resource location! Reset counter.
        }
    }
    
    // Up neighbor moving down
    if (isMiningUnit(g_up) && !isHoldingResource(g_up)) {
        vec2 nPos = g_pos + vec2(0, 1);
        vec2 nUV = (nPos + 0.5) / u_resolution;
        if (getUnitMoveDirection(nPos, g_up, nUV) == 4) {
            vec2 fac = getFactoryLocation(g_up);
            return createMiningUnit(1.0, 0.0, fac, g_pos);
        }
    }
    
    // Left neighbor moving right
    if (isMiningUnit(g_left) && !isHoldingResource(g_left)) {
        vec2 nPos = g_pos + vec2(-1, 0);
        vec2 nUV = (nPos + 0.5) / u_resolution;
        if (getUnitMoveDirection(nPos, g_left, nUV) == 1) {
            vec2 fac = getFactoryLocation(g_left);
            return createMiningUnit(1.0, 0.0, fac, g_pos);
        }
    }
    
    // Down neighbor moving up
    if (isMiningUnit(g_down) && !isHoldingResource(g_down)) {
        vec2 nPos = g_pos + vec2(0, -1);
        vec2 nUV = (nPos + 0.5) / u_resolution;
        if (getUnitMoveDirection(nPos, g_down, nUV) == 2) {
            vec2 fac = getFactoryLocation(g_down);
            return createMiningUnit(1.0, 0.0, fac, g_pos);
        }
    }
    
    return self;
}

// ============================================================================
// MINING UNIT - Move, mine, deposit
// ============================================================================
vec4 updateMiningUnit(vec4 self) {
    bool holding = isHoldingResource(self);
    float counter = getStationaryCounter(self);
    vec2 factoryLoc = getFactoryLocation(self);
    vec2 lastResourceLoc = getLastResourceLocation(self);
    float freshness = getMemoryFreshness(self);
    bool hasMemory = hasLastResourceLocation(self);
    bool walking = isWalking(self); // counter >= STATIONARY_THRESHOLD
    
    // Memory decays each step (unless we just mined, which resets it)
    freshness = max(0.0, freshness - 1.0);
    if (freshness <= 0.0) {
        hasMemory = false;
    }
    
    // Helper to create unit with current memory state
    #define CREATE_UNIT_WITH_MEMORY(h, c) \
        (hasMemory ? createMiningUnitWithMemory(h, c, factoryLoc, lastResourceLoc, freshness) \
                   : createMiningUnitSimple(h, c, factoryLoc))
    
    // If walking (unstuck mode), do random walk and decrement counter
    if (walking) {
        int dir = randomDirection(g_pos, u_time);
        vec2 offset = directionToOffset(dir);
        vec2 targetPos = g_pos + offset;
        vec2 targetUV = (targetPos + 0.5) / u_resolution;
        vec4 target = sampleOffset(v_uv, offset);
        
        if (isEmpty(target) && canMoveWithoutCollision(g_pos, targetPos, targetUV)) {
            return createEmpty(); // Move out, counter decrements on arrival
        }
        // Blocked during walk - decrement counter anyway to avoid infinite walk
        float newCounter = max(0.0, counter - 1.0);
        return CREATE_UNIT_WITH_MEMORY(holding ? 1.0 : 0.0, newCounter);
    }
    
    // If holding, check if adjacent to our factory -> deposit
    if (holding) {
        bool atFactory = false;
        if (isMiningFactory(g_right) && distance(getFactoryPosition(g_right), factoryLoc) < 0.5) atFactory = true;
        if (isMiningFactory(g_up) && distance(getFactoryPosition(g_up), factoryLoc) < 0.5) atFactory = true;
        if (isMiningFactory(g_left) && distance(getFactoryPosition(g_left), factoryLoc) < 0.5) atFactory = true;
        if (isMiningFactory(g_down) && distance(getFactoryPosition(g_down), factoryLoc) < 0.5) atFactory = true;
        
        if (atFactory) {
            // Deposit and stay (now empty-handed, reset counter, keep memory!)
            return CREATE_UNIT_WITH_MEMORY(0.0, 0.0);
        }
        
        // Move toward factory
        int dir = directionToward(g_pos, factoryLoc, u_time);
        if (dir == 0) {
            // Stuck! Increment counter
            return CREATE_UNIT_WITH_MEMORY(1.0, counter + 1.0);
        }
        
        vec2 offset = directionToOffset(dir);
        vec2 targetPos = g_pos + offset;
        vec2 targetUV = (targetPos + 0.5) / u_resolution;
        vec4 target = sampleOffset(v_uv, offset);
        
        if (isEmpty(target) && canMoveWithoutCollision(g_pos, targetPos, targetUV)) {
            return createEmpty(); // Move out
        }
        // Blocked! Increment counter
        return CREATE_UNIT_WITH_MEMORY(1.0, counter + 1.0);
    }
    
    // Not holding: check if we should forget our remembered location
    // If we're AT the remembered location and there's no resource, forget it
    if (hasMemory && distance(g_pos, lastResourceLoc) < 0.5) {
        // We're at the remembered spot - is there a resource adjacent?
        bool foundResource = isResource(g_right) || isResource(g_up) || 
                            isResource(g_left) || isResource(g_down);
        if (!foundResource) {
            // Resource is gone, forget the location
            hasMemory = false;
            freshness = 0.0;
        }
    }
    
    // Knowledge sharing: if we don't have memory, try to get it from a nearby unit
    if (!hasMemory) {
        vec3 sharedMemory = getSharedResourceMemory(g_pos, v_uv);
        if (sharedMemory.z > 0.0) {
            // Got memory from another unit (with reduced freshness)
            lastResourceLoc = sharedMemory.xy;
            freshness = sharedMemory.z;
            hasMemory = true;
        }
    }
    
    // Not holding: look for resources
    int dir = getUnitMoveDirection(g_pos, self, v_uv);
    if (dir == 0) {
        // Stuck! Increment counter
        return CREATE_UNIT_WITH_MEMORY(0.0, counter + 1.0);
    }
    
    vec2 offset = directionToOffset(dir);
    vec2 targetPos = g_pos + offset;
    vec2 targetUV = (targetPos + 0.5) / u_resolution;
    vec4 target = sampleOffset(v_uv, offset);
    float targetType = getCellType(target);
    
    if (targetType == CELL_EMPTY || targetType == CELL_RESOURCE) {
        // Check for collision before moving
        if (canMoveWithoutCollision(g_pos, targetPos, targetUV)) {
            return createEmpty(); // Move out
        }
    }
    // Blocked! Increment counter
    return CREATE_UNIT_WITH_MEMORY(0.0, counter + 1.0);
    
    #undef CREATE_UNIT_WITH_MEMORY
}

// ============================================================================
// MINING FACTORY - Receive deposits, spawn units
// ============================================================================
vec4 updateMiningFactory(vec4 self) {
    float resources = getFactoryResourceCount(self);
    vec2 factoryPos = getFactoryPosition(self);
    
    // Count deposits from adjacent holding units belonging to us
    if (isMiningUnit(g_right) && isHoldingResource(g_right)) {
        if (distance(getFactoryLocation(g_right), factoryPos) < 0.5) resources += 1.0;
    }
    if (isMiningUnit(g_up) && isHoldingResource(g_up)) {
        if (distance(getFactoryLocation(g_up), factoryPos) < 0.5) resources += 1.0;
    }
    if (isMiningUnit(g_left) && isHoldingResource(g_left)) {
        if (distance(getFactoryLocation(g_left), factoryPos) < 0.5) resources += 1.0;
    }
    if (isMiningUnit(g_down) && isHoldingResource(g_down)) {
        if (distance(getFactoryLocation(g_down), factoryPos) < 0.5) resources += 1.0;
    }
    
    // Spawn if we have enough and space above is empty
    if (resources >= SPAWN_COST && isEmpty(g_up)) {
        resources -= SPAWN_COST;
    }
    
    return createMiningFactory(resources, factoryPos.x, factoryPos.y);
}

// ============================================================================
// MAIN
// ============================================================================
void main() {
    g_texelSize = 1.0 / u_resolution;
    g_pos = floor(v_uv * u_resolution);
    
    vec4 self = texture(u_state, v_uv);
    float selfType = getCellType(self);
    
    // Sample neighbors once
    g_right = sampleOffset(v_uv, vec2(1, 0));
    g_up = sampleOffset(v_uv, vec2(0, 1));
    g_left = sampleOffset(v_uv, vec2(-1, 0));
    g_down = sampleOffset(v_uv, vec2(0, -1));
    
    vec4 result;
    
    if (selfType == CELL_EMPTY) {
        result = updateEmpty(self);
    } else if (selfType == CELL_RESOURCE) {
        result = updateResource(self);
    } else if (selfType == CELL_MINING_UNIT) {
        result = updateMiningUnit(self);
    } else if (selfType == CELL_MINING_FACTORY) {
        result = updateMiningFactory(self);
    } else {
        result = self;
    }
    
    fragColor = result;
}
