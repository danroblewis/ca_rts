#version 300 es
precision highp float;

#include "common/cell_types.glsl"
#include "common/random.glsl"

uniform sampler2D u_state;
uniform vec2 u_resolution;
uniform float u_time; // For randomness seed

in vec2 v_uv;
out vec4 fragColor;

void main() {
    vec2 texelSize = 1.0 / u_resolution;
    vec2 pos = floor(v_uv * u_resolution); // Integer cell position
    
    // Sample self and neighbors
    vec4 self = texture(u_state, v_uv);
    vec4 right = texture(u_state, v_uv + vec2(1.0, 0.0) * texelSize);
    vec4 up = texture(u_state, v_uv + vec2(0.0, 1.0) * texelSize);
    vec4 left = texture(u_state, v_uv + vec2(-1.0, 0.0) * texelSize);
    vec4 down = texture(u_state, v_uv + vec2(0.0, -1.0) * texelSize);
    
    float selfType = getCellType(self);
    
    // Default: stay the same
    vec4 result = self;
    
    // === EMPTY CELL ===
    // Check if any neighbor unit is moving INTO this cell
    if (selfType == CELL_EMPTY) {
        // Check each neighbor - if it's a unit moving toward us, we become a unit
        
        // Right neighbor moving left?
        if (isUnit(right)) {
            int dir = randomDirection(pos + vec2(1.0, 0.0), u_time);
            if (dir == 3) { // moving left = into us
                result = right; // Copy the unit here
            }
        }
        // Up neighbor moving down?
        if (isUnit(up)) {
            int dir = randomDirection(pos + vec2(0.0, 1.0), u_time);
            if (dir == 4) { // moving down = into us
                result = up;
            }
        }
        // Left neighbor moving right?
        if (isUnit(left)) {
            int dir = randomDirection(pos + vec2(-1.0, 0.0), u_time);
            if (dir == 1) { // moving right = into us
                result = left;
            }
        }
        // Down neighbor moving up?
        if (isUnit(down)) {
            int dir = randomDirection(pos + vec2(0.0, -1.0), u_time);
            if (dir == 2) { // moving up = into us
                result = down;
            }
        }
    }
    
    // === UNIT CELL ===
    // Determine if we're moving out, and where to
    else if (selfType == CELL_UNIT) {
        int myDir = randomDirection(pos, u_time);
        
        if (myDir == 0) {
            // Staying put
            result = self;
        } else {
            // Trying to move - check target
            vec2 offset = directionToOffset(myDir);
            vec4 target = texture(u_state, v_uv + offset * texelSize);
            float targetType = getCellType(target);
            
            if (targetType == CELL_EMPTY) {
                // Moving out - this cell becomes empty
                result = createEmpty();
            } else if (targetType == CELL_RESOURCE) {
                // Hit a resource - become a resource!
                result = target; // Turn into the resource
            } else {
                // Can't move (obstacle or another unit) - stay put
                result = self;
            }
        }
    }
    
    // === RESOURCE CELL ===
    // Check if a unit is moving into us
    else if (selfType == CELL_RESOURCE) {
        // Check each neighbor - if a unit is moving into us, we stay resource
        // (the unit becomes resource, handled in UNIT case)
        result = self; // Resources don't change on their own
    }
    
    // === OBSTACLE ===
    else if (selfType == CELL_OBSTACLE) {
        result = self; // Obstacles never change
    }
    
    fragColor = result;
}
