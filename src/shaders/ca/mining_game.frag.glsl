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
const int VISION_RANGE = 3;

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

// Get the direction a unit would move
int getUnitMoveDirection(vec2 unitPos, vec4 unitCell, vec2 uv) {
    bool holding = isHoldingResource(unitCell);
    vec2 factoryLoc = getFactoryLocation(unitCell);
    
    if (holding) {
        return directionToward(unitPos, factoryLoc, u_time);
    }
    
    vec2 resourcePos = findNearestResource(unitPos, uv);
    if (resourcePos.x >= 0.0) {
        return directionToward(unitPos, resourcePos, u_time);
    }
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

// ============================================================================
// EMPTY CELL - Check if unit moves in or factory spawns here
// ============================================================================
vec4 updateEmpty(vec4 self) {
    vec4 incoming;
    
    // Check right neighbor moving left (dir=3)
    incoming = checkUnitMovingIn(g_right, vec2(1, 0), 3);
    if (incoming.r > 0.0) return incoming;
    
    // Check up neighbor moving down (dir=4)
    incoming = checkUnitMovingIn(g_up, vec2(0, 1), 4);
    if (incoming.r > 0.0) return incoming;
    
    // Check left neighbor moving right (dir=1)
    incoming = checkUnitMovingIn(g_left, vec2(-1, 0), 1);
    if (incoming.r > 0.0) return incoming;
    
    // Check down neighbor moving up (dir=2)
    incoming = checkUnitMovingIn(g_down, vec2(0, -1), 2);
    if (incoming.r > 0.0) return incoming;
    
    // Check if factory below is spawning (factory only spawns UP)
    if (isMiningFactory(g_down) && getFactoryResourceCount(g_down) >= 5.0) {
        vec2 facPos = getFactoryPosition(g_down);
        return createMiningUnit(0.0, facPos.x, facPos.y);
    }
    
    return self;
}

// ============================================================================
// RESOURCE CELL - Check if unit mines us
// ============================================================================
vec4 updateResource(vec4 self) {
    // Check if any adjacent non-holding unit is moving onto us
    
    // Right neighbor moving left
    if (isMiningUnit(g_right) && !isHoldingResource(g_right)) {
        vec2 nPos = g_pos + vec2(1, 0);
        vec2 nUV = (nPos + 0.5) / u_resolution;
        if (getUnitMoveDirection(nPos, g_right, nUV) == 3) {
            vec2 fac = getFactoryLocation(g_right);
            return createMiningUnit(1.0, fac.x, fac.y);
        }
    }
    
    // Up neighbor moving down
    if (isMiningUnit(g_up) && !isHoldingResource(g_up)) {
        vec2 nPos = g_pos + vec2(0, 1);
        vec2 nUV = (nPos + 0.5) / u_resolution;
        if (getUnitMoveDirection(nPos, g_up, nUV) == 4) {
            vec2 fac = getFactoryLocation(g_up);
            return createMiningUnit(1.0, fac.x, fac.y);
        }
    }
    
    // Left neighbor moving right
    if (isMiningUnit(g_left) && !isHoldingResource(g_left)) {
        vec2 nPos = g_pos + vec2(-1, 0);
        vec2 nUV = (nPos + 0.5) / u_resolution;
        if (getUnitMoveDirection(nPos, g_left, nUV) == 1) {
            vec2 fac = getFactoryLocation(g_left);
            return createMiningUnit(1.0, fac.x, fac.y);
        }
    }
    
    // Down neighbor moving up
    if (isMiningUnit(g_down) && !isHoldingResource(g_down)) {
        vec2 nPos = g_pos + vec2(0, -1);
        vec2 nUV = (nPos + 0.5) / u_resolution;
        if (getUnitMoveDirection(nPos, g_down, nUV) == 2) {
            vec2 fac = getFactoryLocation(g_down);
            return createMiningUnit(1.0, fac.x, fac.y);
        }
    }
    
    return self;
}

// ============================================================================
// MINING UNIT - Move, mine, deposit
// ============================================================================
vec4 updateMiningUnit(vec4 self) {
    bool holding = isHoldingResource(self);
    vec2 factoryLoc = getFactoryLocation(self);
    
    // If holding, check if adjacent to our factory -> deposit
    if (holding) {
        bool atFactory = false;
        if (isMiningFactory(g_right) && distance(getFactoryPosition(g_right), factoryLoc) < 0.5) atFactory = true;
        if (isMiningFactory(g_up) && distance(getFactoryPosition(g_up), factoryLoc) < 0.5) atFactory = true;
        if (isMiningFactory(g_left) && distance(getFactoryPosition(g_left), factoryLoc) < 0.5) atFactory = true;
        if (isMiningFactory(g_down) && distance(getFactoryPosition(g_down), factoryLoc) < 0.5) atFactory = true;
        
        if (atFactory) {
            // Deposit and stay (now empty-handed)
            return createMiningUnit(0.0, factoryLoc.x, factoryLoc.y);
        }
        
        // Move toward factory
        int dir = directionToward(g_pos, factoryLoc, u_time);
        if (dir == 0) return self;
        
        vec2 offset = directionToOffset(dir);
        vec4 target = sampleOffset(v_uv, offset);
        
        if (isEmpty(target)) {
            return createEmpty(); // Move out
        }
        return self; // Blocked
    }
    
    // Not holding: look for resources
    int dir = getUnitMoveDirection(g_pos, self, v_uv);
    if (dir == 0) return self;
    
    vec2 offset = directionToOffset(dir);
    vec4 target = sampleOffset(v_uv, offset);
    float targetType = getCellType(target);
    
    if (targetType == CELL_EMPTY || targetType == CELL_RESOURCE) {
        return createEmpty(); // Move out
    }
    return self; // Blocked
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
    if (resources >= 5.0 && isEmpty(g_up)) {
        resources -= 5.0;
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
