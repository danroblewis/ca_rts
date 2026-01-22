#version 300 es
precision highp float;

uniform sampler2D u_state;
uniform vec2 u_resolution;

in vec2 v_uv;
out vec4 fragColor;

void main() {
    vec2 texelSize = 1.0 / u_resolution;
    
    // Sample current cell and 8 neighbors
    float self = texture(u_state, v_uv).r;
    
    float neighbors = 0.0;
    neighbors += texture(u_state, v_uv + vec2(-1, -1) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2( 0, -1) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2( 1, -1) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2(-1,  0) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2( 1,  0) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2(-1,  1) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2( 0,  1) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2( 1,  1) * texelSize).r;
    
    // Conway's rules:
    // - Alive cell with 2 or 3 neighbors survives
    // - Dead cell with exactly 3 neighbors becomes alive
    float alive = 0.0;
    if (self > 0.5) {
        // Currently alive
        if (neighbors >= 2.0 && neighbors <= 3.0) {
            alive = 1.0;
        }
    } else {
        // Currently dead
        if (neighbors >= 2.5 && neighbors <= 3.5) {
            alive = 1.0;
        }
    }
    
    fragColor = vec4(alive, 0.0, 0.0, 1.0);
}
