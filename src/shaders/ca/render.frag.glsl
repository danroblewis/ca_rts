#version 300 es
precision highp float;

#include "common/cell_types.glsl"

uniform sampler2D u_state;

in vec2 v_uv;
out vec4 fragColor;

void main() {
    vec4 cell = texture(u_state, v_uv);
    float cellType = getCellType(cell);
    
    vec3 color;
    
    if (cellType == CELL_EMPTY) {
        // Dark background
        color = vec3(0.08, 0.1, 0.14);
    }
    else if (cellType == CELL_RESOURCE) {
        // Yellow/gold for resources
        color = vec3(0.9, 0.7, 0.2);
    }
    else if (cellType == CELL_MINING_UNIT) {
        // Mining unit - cyan when empty, green when carrying
        bool holding = isHoldingResource(cell);
        if (holding) {
            color = vec3(0.3, 0.9, 0.4); // Bright green = carrying
        } else {
            color = vec3(0.2, 0.7, 0.9); // Cyan = searching
        }
    }
    else if (cellType == CELL_MINING_FACTORY) {
        // Factory - purple/magenta, brighter with more resources
        float resources = getFactoryResourceCount(cell);
        float brightness = 0.5 + min(resources / 10.0, 0.5);
        color = vec3(0.7, 0.2, 0.8) * brightness;
    }
    else if (cellType == CELL_MISSILE) {
        // Missile - orange for building, blue for armed, magenta for moving, white for exploding
        int missileState = int(mod(floor(cell.g / 16.0), 4.0)); // assuming the same encoding as in types.glsl
        if (missileState == 0) { // BUILDING
            color = vec3(1.0, 0.65, 0.15); // orange
        } else if (missileState == 1) { // ARMED
            color = vec3(0.2, 0.6, 1.0); // blue
        } else if (missileState == 2) { // MOVING
            color = vec3(1.0, 0.3, 1.0); // magenta
        } else if (missileState == 3) { // EXPLODING
            color = vec3(1.0, 1.0, 1.0); // white
        } else {
            color = vec3(1.0, 0.0, 1.0); // fallback: bright magenta
        }
    }
    else if (cellType == CELL_WALL) {
        // Wall - gray
        color = vec3(0.55, 0.55, 0.58);
    }
    else if (cellType == CELL_CONSTRUCTION) {
        // Construction - teal
        color = vec3(0.2, 0.8, 0.8);
    }
    else if (cellType == CELL_MISSILE_FACTORY) {
        // Missile factory - deep purple
        color = vec3(0.47, 0.18, 0.55);
    }
    else {
        // Unknown - black for debugging
        color = vec3(0.0, 0.0, 0.0);
    }
    fragColor = vec4(color, 1.0);
}
