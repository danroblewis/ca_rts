#version 300 es
precision highp float;

#include "common/cell_types.glsl"
#include "common/random.glsl"

uniform sampler2D u_state;
uniform vec2 u_resolution;
uniform float u_time;

in vec2 v_uv;
out vec4 fragColor;

// Sample neighbor at offset
vec4 sampleOffset(vec2 uv, vec2 offset, vec2 texelSize) {
    return texture(u_state, uv + offset * texelSize);
}

// Vision range for units
const int VISION_RANGE = 3;

// Find nearest resource within vision range
// Returns the position of the nearest resource, or (-1,-1) if none found
vec2 findNearestResource(vec2 pos, vec2 uv, vec2 texelSize) {
    vec2 nearestPos = vec2(-1.0, -1.0);
    float nearestDist = 999.0;
    
    for (int dy = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
        for (int dx = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
            if (dx == 0 && dy == 0) continue;
            
            vec2 offset = vec2(float(dx), float(dy));
            vec4 cell = sampleOffset(uv, offset, texelSize);
            
            if (isResource(cell)) {
                float dist = abs(float(dx)) + abs(float(dy)); // Manhattan distance
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestPos = pos + offset;
                }
            }
        }
    }
    
    return nearestPos;
}

// Get the direction a unit at 'unitPos' would move given its state
int getUnitMoveDirection(vec2 unitPos, vec4 unitCell, vec2 uv, vec2 texelSize, float time) {
    bool holding = isHoldingResource(unitCell);
    vec2 factoryLoc = getFactoryLocation(unitCell);
    
    if (holding) {
        // Moving toward factory
        return directionToward(unitPos, factoryLoc, time);
    } else {
        // Look for nearby resources
        vec2 resourcePos = findNearestResource(unitPos, uv, texelSize);
        if (resourcePos.x >= 0.0) {
            // Found a resource, move toward it
            return directionToward(unitPos, resourcePos, time);
        } else {
            // No resource visible, random walk
            return randomDirection(unitPos, time);
        }
    }
}

// Determine factory spawn direction (1=right, 2=up, 3=left, 4=down)
// Returns 0 if no empty neighbor available
int getFactorySpawnDirection(vec2 factoryPos, vec4 right, vec4 up, vec4 left, vec4 down, float time) {
    // Check which neighbors are empty
    bool rEmpty = isEmpty(right);
    bool uEmpty = isEmpty(up);
    bool lEmpty = isEmpty(left);
    bool dEmpty = isEmpty(down);
    
    // If nothing is empty, can't spawn
    if (!rEmpty && !uEmpty && !lEmpty && !dEmpty) {
        return 0;
    }
    
    // Pick a random direction, but only from available empty cells
    float r = hash(factoryPos, time);
    int attempt = int(floor(r * 4.0)); // 0, 1, 2, or 3
    
    // Try the random direction first, then cycle through others
    for (int i = 0; i < 4; i++) {
        int dir = ((attempt + i) % 4) + 1; // 1, 2, 3, or 4
        if (dir == 1 && rEmpty) return 1;
        if (dir == 2 && uEmpty) return 2;
        if (dir == 3 && lEmpty) return 3;
        if (dir == 4 && dEmpty) return 4;
    }
    
    return 0;
}

void main() {
    vec2 texelSize = 1.0 / u_resolution;
    vec2 pos = floor(v_uv * u_resolution);
    
    vec4 self = texture(u_state, v_uv);
    float selfType = getCellType(self);
    
    // Sample all 4 neighbors
    vec4 right = sampleOffset(v_uv, vec2(1, 0), texelSize);
    vec4 up = sampleOffset(v_uv, vec2(0, 1), texelSize);
    vec4 left = sampleOffset(v_uv, vec2(-1, 0), texelSize);
    vec4 down = sampleOffset(v_uv, vec2(0, -1), texelSize);
    
    vec4 result = self;
    
    // =========================================================================
    // EMPTY CELL - might become a mining unit if one is moving into us,
    // or if a factory is spawning a new unit here
    // =========================================================================
    if (selfType == CELL_EMPTY) {
        // Check each neighbor - is a mining unit moving INTO this cell?
        
        // Right neighbor (moving left into us)
        if (isMiningUnit(right)) {
            vec2 neighborPos = pos + vec2(1, 0);
            vec2 neighborUV = (neighborPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(neighborPos, right, neighborUV, texelSize, u_time);
            if (dir == 3) { // moving left
                result = right;
            }
        }
        // Up neighbor (moving down into us)
        if (isMiningUnit(up) && isEmpty(result)) {
            vec2 neighborPos = pos + vec2(0, 1);
            vec2 neighborUV = (neighborPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(neighborPos, up, neighborUV, texelSize, u_time);
            if (dir == 4) { // moving down
                result = up;
            }
        }
        // Left neighbor (moving right into us)
        if (isMiningUnit(left) && isEmpty(result)) {
            vec2 neighborPos = pos + vec2(-1, 0);
            vec2 neighborUV = (neighborPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(neighborPos, left, neighborUV, texelSize, u_time);
            if (dir == 1) { // moving right
                result = left;
            }
        }
        // Down neighbor (moving up into us)
        if (isMiningUnit(down) && isEmpty(result)) {
            vec2 neighborPos = pos + vec2(0, -1);
            vec2 neighborUV = (neighborPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(neighborPos, down, neighborUV, texelSize, u_time);
            if (dir == 2) { // moving up
                result = down;
            }
        }
        
        // Check if a factory is spawning a unit into this cell
        if (isEmpty(result)) {
            // neighbors[i]: 0=right, 1=up, 2=left, 3=down (factory position relative to us)
            // If factory is to our RIGHT (i=0), and it spawns LEFT (dir=3), we're the target
            // If factory is UP from us (i=1), and it spawns DOWN (dir=4), we're the target
            // If factory is to our LEFT (i=2), and it spawns RIGHT (dir=1), we're the target
            // If factory is DOWN from us (i=3), and it spawns UP (dir=2), we're the target
            
            vec4 neighbors[4];
            neighbors[0] = right;
            neighbors[1] = up;
            neighbors[2] = left;
            neighbors[3] = down;
            
            for (int i = 0; i < 4; i++) {
                if (isMiningFactory(neighbors[i])) {
                    float res = getFactoryResourceCount(neighbors[i]);
                    if (res >= 5.0) {
                        vec2 facPos = getFactoryPosition(neighbors[i]);
                        
                        // Get factory's neighbors from factory's perspective
                        vec2 facUV = (facPos + 0.5) / u_resolution;
                        vec4 facRight = sampleOffset(facUV, vec2(1, 0), texelSize);
                        vec4 facUp = sampleOffset(facUV, vec2(0, 1), texelSize);
                        vec4 facLeft = sampleOffset(facUV, vec2(-1, 0), texelSize);
                        vec4 facDown = sampleOffset(facUV, vec2(0, -1), texelSize);
                        
                        // Compute spawn direction using same function as factory
                        int spawnDir = getFactorySpawnDirection(facPos, facRight, facUp, facLeft, facDown, u_time);
                        
                        // Check if we're the spawn target
                        bool isSpawnTarget = false;
                        if (i == 0 && spawnDir == 3) isSpawnTarget = true; // factory right, spawns left
                        if (i == 1 && spawnDir == 4) isSpawnTarget = true; // factory up, spawns down
                        if (i == 2 && spawnDir == 1) isSpawnTarget = true; // factory left, spawns right
                        if (i == 3 && spawnDir == 2) isSpawnTarget = true; // factory down, spawns up
                        
                        if (isSpawnTarget) {
                            result = createMiningUnit(0.0, facPos.x, facPos.y);
                            break;
                        }
                    }
                }
            }
        }
    }
    
    // =========================================================================
    // RESOURCE CELL - might be mined by an adjacent unit
    // =========================================================================
    else if (selfType == CELL_RESOURCE) {
        vec4 miner = vec4(0.0);
        
        // Check if any adjacent mining unit (not holding) is trying to move onto us
        if (isMiningUnit(right) && !isHoldingResource(right)) {
            vec2 neighborPos = pos + vec2(1, 0);
            vec2 neighborUV = (neighborPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(neighborPos, right, neighborUV, texelSize, u_time);
            if (dir == 3) miner = right;
        }
        if (miner.r == 0.0 && isMiningUnit(up) && !isHoldingResource(up)) {
            vec2 neighborPos = pos + vec2(0, 1);
            vec2 neighborUV = (neighborPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(neighborPos, up, neighborUV, texelSize, u_time);
            if (dir == 4) miner = up;
        }
        if (miner.r == 0.0 && isMiningUnit(left) && !isHoldingResource(left)) {
            vec2 neighborPos = pos + vec2(-1, 0);
            vec2 neighborUV = (neighborPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(neighborPos, left, neighborUV, texelSize, u_time);
            if (dir == 1) miner = left;
        }
        if (miner.r == 0.0 && isMiningUnit(down) && !isHoldingResource(down)) {
            vec2 neighborPos = pos + vec2(0, -1);
            vec2 neighborUV = (neighborPos + 0.5) / u_resolution;
            int dir = getUnitMoveDirection(neighborPos, down, neighborUV, texelSize, u_time);
            if (dir == 2) miner = down;
        }
        
        if (miner.r > 0.0) {
            // Resource is extracted - becomes the mining unit (now holding)
            vec2 fac = getFactoryLocation(miner);
            result = createMiningUnit(1.0, fac.x, fac.y);
        }
    }
    
    // =========================================================================
    // MINING UNIT - move around, mine resources, return to factory
    // =========================================================================
    else if (selfType == CELL_MINING_UNIT) {
        bool holding = isHoldingResource(self);
        vec2 factoryLoc = getFactoryLocation(self);
        
        // First check: if holding and adjacent to factory, deposit and stay
        if (holding) {
            bool adjacentToFactory = false;
            if (isMiningFactory(right) && getFactoryPosition(right) == factoryLoc) adjacentToFactory = true;
            if (isMiningFactory(up) && getFactoryPosition(up) == factoryLoc) adjacentToFactory = true;
            if (isMiningFactory(left) && getFactoryPosition(left) == factoryLoc) adjacentToFactory = true;
            if (isMiningFactory(down) && getFactoryPosition(down) == factoryLoc) adjacentToFactory = true;
            
            if (adjacentToFactory) {
                // Deposit: stay in place, but now empty-handed
                result = createMiningUnit(0.0, factoryLoc.x, factoryLoc.y);
            } else {
                // Move toward factory
                int myDir = directionToward(pos, factoryLoc, u_time);
                if (myDir == 0) {
                    result = self;
                } else {
                    vec2 offset = directionToOffset(myDir);
                    vec4 target = sampleOffset(v_uv, offset, texelSize);
                    float targetType = getCellType(target);
                    
                    if (targetType == CELL_EMPTY) {
                        result = createEmpty(); // Move out
                    } else {
                        result = self; // Blocked, stay
                    }
                }
            }
        } else {
            // Not holding: look for resources within vision range
            int myDir = getUnitMoveDirection(pos, self, v_uv, texelSize, u_time);
            
            if (myDir == 0) {
                result = self;
            } else {
                vec2 offset = directionToOffset(myDir);
                vec4 target = sampleOffset(v_uv, offset, texelSize);
                float targetType = getCellType(target);
                
                if (targetType == CELL_EMPTY) {
                    result = createEmpty(); // Move out
                }
                else if (targetType == CELL_RESOURCE) {
                    result = createEmpty(); // Move out (onto resource)
                }
                else {
                    result = self; // Blocked, stay
                }
            }
        }
    }
    
    // =========================================================================
    // MINING FACTORY - receive deposits, spawn new units
    // =========================================================================
    else if (selfType == CELL_MINING_FACTORY) {
        float resources = getFactoryResourceCount(self);
        vec2 factoryPos = getFactoryPosition(self);
        
        // Check for incoming deposits from adjacent units
        if (isMiningUnit(right) && isHoldingResource(right)) {
            int dir = directionToward(pos + vec2(1, 0), factoryPos, u_time);
            if (dir == 3) resources += 1.0;
        }
        if (isMiningUnit(up) && isHoldingResource(up)) {
            int dir = directionToward(pos + vec2(0, 1), factoryPos, u_time);
            if (dir == 4) resources += 1.0;
        }
        if (isMiningUnit(left) && isHoldingResource(left)) {
            int dir = directionToward(pos + vec2(-1, 0), factoryPos, u_time);
            if (dir == 1) resources += 1.0;
        }
        if (isMiningUnit(down) && isHoldingResource(down)) {
            int dir = directionToward(pos + vec2(0, -1), factoryPos, u_time);
            if (dir == 2) resources += 1.0;
        }
        
        // Try to spawn a new unit if we have enough resources
        if (resources >= 5.0) {
            // Use the same spawn direction calculation as the empty cell detection
            int spawnDir = getFactorySpawnDirection(factoryPos, right, up, left, down, u_time);
            if (spawnDir > 0) {
                resources -= 5.0;
            }
        }
        
        result = createMiningFactory(resources, factoryPos.x, factoryPos.y);
    }
    
    fragColor = result;
}
