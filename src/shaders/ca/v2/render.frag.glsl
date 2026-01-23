#version 300 es
precision highp float;

#include "./core/types.glsl"

uniform sampler2D u_state;

in vec2 v_uv;
out vec4 fragColor;

void main() {
    vec4 raw = texture(u_state, v_uv);
    int cellType = getType(raw);
    
    vec3 color;
    
    if (cellType == TYPE_EMPTY) {
        color = vec3(0.08, 0.1, 0.14);
    }
    else if (cellType == TYPE_RESOURCE) {
        color = vec3(0.9, 0.7, 0.2);
    }
    else if (cellType == TYPE_UNIT) {
        if (getUnitHolding(raw)) {
            color = vec3(0.3, 0.9, 0.4);  // Green = carrying
        } else {
            color = vec3(0.2, 0.7, 0.9);  // Cyan = searching
        }
    }
    else if (cellType == TYPE_FACTORY) {
        float brightness = 0.5 + min(getFactoryResources(raw) / 10.0, 0.5);
        color = vec3(0.7, 0.2, 0.8) * brightness;
    }
    else if (cellType == TYPE_WALL) {
        color = vec3(0.35, 0.35, 0.4);  // Gray wall
    }
    else {
        color = vec3(1.0, 0.0, 0.0);  // Red = unknown
    }
    
    fragColor = vec4(color, 1.0);
}
