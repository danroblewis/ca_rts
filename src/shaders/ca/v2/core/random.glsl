/**
 * Random/Hash Functions - INTEGER-ONLY for cross-platform determinism
 * 
 * These functions use only integer operations to ensure identical results
 * across different GPU architectures (PC, Mac M4, etc.)
 * 
 * NO fract(), NO floating-point multiplication for randomness.
 */

#ifndef RANDOM_GLSL
#define RANDOM_GLSL

// Integer hash using simple mixing - deterministic across all GPUs
// Uses int instead of uint for better compatibility
int ihash(int x) {
    // Simple integer hash - avoid bitwise for maximum compatibility
    // Based on simple linear congruential mixing
    x = x * 1103515245 + 12345;
    x = x / 65536;  // Integer division to mix bits
    x = x * 1103515245 + 12345;
    return x;
}

// Hash position and seed to get a deterministic integer
int hashPosTime(vec2 pos, float time) {
    // Convert floats to integers carefully
    // Position should always be integer-valued (cell coordinates)
    int px = int(pos.x + 0.5);  // Round to nearest integer
    int py = int(pos.y + 0.5);
    int t = int(time);
    
    // Combine using simple multiplication and addition
    int h = px * 73856 + py * 19349 + t * 83492;
    
    return ihash(h);
}

// Get a float 0.0-1.0 from integer hash (for compatibility with existing code)
float hash(vec2 p, float time) {
    int h = hashPosTime(p, time);
    // Make positive and get 0.0-1.0 range
    if (h < 0) h = -h;
    return float(h - (h / 10000) * 10000) / 10000.0;  // h % 10000 using integer division
}

// Random direction 1-8 (including diagonals) - pure integer
int randomDir(vec2 pos, float time) {
    int h = hashPosTime(pos, time);
    if (h < 0) h = -h;  // Make positive
    return (h - (h / 8) * 8) + 1;  // h % 8 using integer division
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
