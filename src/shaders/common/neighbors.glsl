/**
 * Neighbor sampling utilities for cellular automata
 */

// Count alive neighbors in Moore neighborhood (8 surrounding cells)
float countMooreNeighbors(sampler2D state, vec2 uv, vec2 texelSize) {
    float count = 0.0;
    count += texture(state, uv + vec2(-1, -1) * texelSize).r;
    count += texture(state, uv + vec2( 0, -1) * texelSize).r;
    count += texture(state, uv + vec2( 1, -1) * texelSize).r;
    count += texture(state, uv + vec2(-1,  0) * texelSize).r;
    count += texture(state, uv + vec2( 1,  0) * texelSize).r;
    count += texture(state, uv + vec2(-1,  1) * texelSize).r;
    count += texture(state, uv + vec2( 0,  1) * texelSize).r;
    count += texture(state, uv + vec2( 1,  1) * texelSize).r;
    return count;
}

// Count alive neighbors in Von Neumann neighborhood (4 adjacent cells)
float countVonNeumannNeighbors(sampler2D state, vec2 uv, vec2 texelSize) {
    float count = 0.0;
    count += texture(state, uv + vec2( 0, -1) * texelSize).r;
    count += texture(state, uv + vec2(-1,  0) * texelSize).r;
    count += texture(state, uv + vec2( 1,  0) * texelSize).r;
    count += texture(state, uv + vec2( 0,  1) * texelSize).r;
    return count;
}

// Sample a neighbor cell
vec4 sampleNeighbor(sampler2D state, vec2 uv, vec2 texelSize, int dx, int dy) {
    return texture(state, uv + vec2(float(dx), float(dy)) * texelSize);
}
