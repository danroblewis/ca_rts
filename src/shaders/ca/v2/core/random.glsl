/**
 * Random/Hash Functions
 */

#ifndef RANDOM_GLSL
#define RANDOM_GLSL

float hash(vec2 p, float seed) {
    vec3 p3 = fract(vec3(p.x + seed, p.y + seed * 1.3, p.x * 0.7 + p.y) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Random direction 1-8 (including diagonals)
int randomDir(vec2 pos, float seed) {
    return int(floor(hash(pos, seed) * 8.0)) + 1;
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
