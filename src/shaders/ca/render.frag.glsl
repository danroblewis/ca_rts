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
    else {
        // Unknown - red for debugging
        color = vec3(1.0, 0.0, 0.0);
    }
    
    fragColor = vec4(color, 1.0);
}
