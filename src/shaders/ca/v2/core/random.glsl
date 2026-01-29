/**
 * Random/Hash Functions - xorshift128++ based
 * 
 * Uses xorshift128++ algorithm adapted for stateless shader use.
 * Position and time seed the state, then xorshift mixing produces output.
 * 
 * xorshift128++ is a high-quality PRNG with good statistical properties
 * and fast execution on GPUs.
 */

#ifndef RANDOM_GLSL
#define RANDOM_GLSL

// xorshift128++ state - we use uvec4 for 128 bits of state
// WebGL2 supports unsigned integers

// Initialize state from position and time
uvec4 xorshiftSeed(vec2 pos, float time) {
    // Convert inputs to uints
    uint px = uint(int(floor(pos.x + 0.5)));
    uint py = uint(int(floor(pos.y + 0.5)));
    uint t = uint(int(floor(time)));
    
    // Create 4 different seed values using prime multipliers
    // This spreads the entropy across all 128 bits
    uvec4 s;
    s.x = px * 73856093u ^ py * 19349663u ^ t * 83492791u;
    s.y = px * 41729371u ^ py * 73856093u ^ t * 19349663u;
    s.z = px * 83492791u ^ py * 41729371u ^ t * 73856093u;
    s.w = px * 19349663u ^ py * 83492791u ^ t * 41729371u;
    
    // Ensure no zero state (xorshift fails with all zeros)
    if (s.x == 0u && s.y == 0u && s.z == 0u && s.w == 0u) {
        s.x = 1u;
    }
    
    return s;
}

// Single xorshift128++ iteration
// Returns the random value and updates state in-place
uint xorshift128pp(inout uvec4 s) {
    uint t = s.x;
    uint const_s = s.w;
    
    // Shift state
    s.x = s.y;
    s.y = s.z;
    s.z = s.w;
    
    // xorshift
    t ^= t << 11u;
    t ^= t >> 8u;
    s.w = t ^ const_s ^ (const_s >> 19u);
    
    // ++ scrambler: add s[0] for better low bits
    return s.w + s.y;
}

// Get a random uint from position and time
uint hashUint(vec2 pos, float time) {
    uvec4 state = xorshiftSeed(pos, time);
    
    // Run a few iterations to mix the state well
    xorshift128pp(state);
    xorshift128pp(state);
    return xorshift128pp(state);
}

// Get a float 0.0-1.0 from position and time
float hash(vec2 pos, float time) {
    uint h = hashUint(pos, time);
    // Convert to float in [0, 1)
    return float(h) / 4294967296.0;  // 2^32
}

// Get a second independent random value (using time offset)
float hash2(vec2 pos, float time) {
    return hash(pos, time + 10000.0);
}

// Random direction 1-8 (including diagonals)
int randomDir(vec2 pos, float time) {
    uint h = hashUint(pos, time);
    return int(h % 8u) + 1;  // Returns 1-8
}

// Random direction 1-4 (cardinal only: RIGHT, UP, LEFT, DOWN)
int randomDir4(vec2 pos, float time) {
    uint h = hashUint(pos, time);
    return int(h % 4u) + 1;  // Returns 1-4
}

// Direction toward target - prefers diagonal when both axes differ
int dirToward(vec2 from, vec2 to, float seed) {
    vec2 diff = to - from;
    
    if (abs(diff.x) < 0.5 && abs(diff.y) < 0.5) {
        return 0;  // Already there
    }
    
    bool canX = abs(diff.x) > 0.5;
    bool canY = abs(diff.y) > 0.5;
    
    // If both axes differ, use diagonal movement
    if (canX && canY) {
        if (diff.x > 0.0 && diff.y > 0.0) return 5;  // DIR_UP_RIGHT
        if (diff.x < 0.0 && diff.y > 0.0) return 6;  // DIR_UP_LEFT
        if (diff.x < 0.0 && diff.y < 0.0) return 7;  // DIR_DOWN_LEFT
        if (diff.x > 0.0 && diff.y < 0.0) return 8;  // DIR_DOWN_RIGHT
    } else if (canX) {
        return diff.x > 0.0 ? 1 : 3;  // RIGHT or LEFT
    } else if (canY) {
        return diff.y > 0.0 ? 2 : 4;  // UP or DOWN
    }
    
    return 0;
}

#endif
