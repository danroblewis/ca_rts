#version 300 es
precision highp float;

#include "./common/cell.glsl"

uniform sampler2D u_state;

in vec2 v_uv;
out vec4 fragColor;

void main() {
    vec4 raw = texture(u_state, v_uv);
    Cell cell = parseCell(raw);
    
    vec3 color;
    
    if (cell.type == TYPE_EMPTY) {
        color = vec3(0.08, 0.1, 0.14);
    }
    else if (cell.type == TYPE_RESOURCE) {
        color = vec3(0.9, 0.7, 0.2);
    }
    else if (cell.type == TYPE_UNIT) {
        if (cell.holding) {
            color = vec3(0.3, 0.9, 0.4); // Green = carrying
        } else {
            color = vec3(0.2, 0.7, 0.9); // Cyan = searching
        }
    }
    else if (cell.type == TYPE_FACTORY) {
        float brightness = 0.5 + min(cell.resources / 10.0, 0.5);
        color = vec3(0.7, 0.2, 0.8) * brightness;
    }
    else {
        color = vec3(1.0, 0.0, 0.0); // Red = unknown
    }
    
    fragColor = vec4(color, 1.0);
}
