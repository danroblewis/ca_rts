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
        color = vec3(0.05, 0.08, 0.12);
    }
    else if (cellType == CELL_RESOURCE) {
        // Green for resources, brightness based on amount
        float amount = getResourceAmount(cell);
        color = vec3(0.2, 0.6 + 0.4 * amount, 0.2);
    }
    else if (cellType == CELL_UNIT) {
        // Cyan for units
        float team = getUnitTeam(cell);
        if (team == 0.0) {
            color = vec3(0.2, 0.8, 0.9); // Player units: cyan
        } else {
            color = vec3(0.9, 0.3, 0.2); // Enemy units: red
        }
    }
    else if (cellType == CELL_OBSTACLE) {
        // Gray for obstacles
        color = vec3(0.3, 0.3, 0.35);
    }
    else {
        // Unknown - magenta for debugging
        color = vec3(1.0, 0.0, 1.0);
    }
    
    fragColor = vec4(color, 1.0);
}
