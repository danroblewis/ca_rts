#version 300 es
precision highp float;

uniform sampler2D u_state;

in vec2 v_uv;
out vec4 fragColor;

void main() {
    float alive = texture(u_state, v_uv).r;
    
    // Dark blue background, bright cyan for alive cells
    vec3 deadColor = vec3(0.05, 0.08, 0.12);
    vec3 aliveColor = vec3(0.2, 0.8, 0.9);
    
    vec3 color = mix(deadColor, aliveColor, alive);
    fragColor = vec4(color, 1.0);
}
