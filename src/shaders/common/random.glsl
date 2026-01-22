/**
 * Pseudo-random number generation for shaders
 */

// Hash function for pseudo-random numbers
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Hash with seed
float hash(vec2 p, float seed) {
    return fract(sin(dot(p + seed, vec2(127.1, 311.7))) * 43758.5453123);
}

// Random direction (returns one of 4 cardinal directions or stay)
// Returns: 0=stay, 1=right, 2=up, 3=left, 4=down
int randomDirection(vec2 pos, float seed) {
    float r = hash(pos, seed);
    if (r < 0.2) return 0; // stay (20% chance)
    if (r < 0.4) return 1; // right
    if (r < 0.6) return 2; // up
    if (r < 0.8) return 3; // left
    return 4; // down
}

// Convert direction ID to offset
vec2 directionToOffset(int dir) {
    if (dir == 1) return vec2(1.0, 0.0);  // right
    if (dir == 2) return vec2(0.0, 1.0);  // up
    if (dir == 3) return vec2(-1.0, 0.0); // left
    if (dir == 4) return vec2(0.0, -1.0); // down
    return vec2(0.0, 0.0); // stay
}
