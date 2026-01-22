/**
 * Pseudo-random number generation for shaders
 */

// Hash function for pseudo-random numbers (0.0 to 1.0)
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Hash with seed - use seed to offset position
float hash(vec2 p, float seed) {
    return hash(p + vec2(seed * 7.23, seed * 13.17));
}

// Random direction: returns 1=right, 2=up, 3=left, 4=down
// No "stay" option - always moves
int randomDirection(vec2 pos, float seed) {
    float r = hash(pos, seed);
    // Map 0-1 to 1-4 evenly
    return int(floor(r * 4.0)) + 1;
}

// Convert direction ID to offset
vec2 directionToOffset(int dir) {
    if (dir == 1) return vec2(1.0, 0.0);  // right
    if (dir == 2) return vec2(0.0, 1.0);  // up
    if (dir == 3) return vec2(-1.0, 0.0); // left
    if (dir == 4) return vec2(0.0, -1.0); // down
    return vec2(0.0, 0.0); // stay (dir == 0)
}

// Get direction toward a target (picks axis randomly to avoid straight-line movement)
int directionToward(vec2 from, vec2 to, float seed) {
    vec2 diff = to - from;
    
    // If we're at the target, stay
    if (abs(diff.x) < 0.5 && abs(diff.y) < 0.5) {
        return 0;
    }
    
    bool canMoveX = abs(diff.x) > 0.5;
    bool canMoveY = abs(diff.y) > 0.5;
    
    if (canMoveX && canMoveY) {
        // Both axes valid - pick randomly
        float r = hash(from, seed);
        if (r < 0.5) {
            return diff.x > 0.0 ? 1 : 3; // right or left
        } else {
            return diff.y > 0.0 ? 2 : 4; // up or down
        }
    } else if (canMoveX) {
        return diff.x > 0.0 ? 1 : 3;
    } else if (canMoveY) {
        return diff.y > 0.0 ? 2 : 4;
    }
    
    return 0;
}
