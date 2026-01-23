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

// Random direction 1-4 (RIGHT, UP, LEFT, DOWN)
int randomDir(vec2 pos, float seed) {
    return int(floor(hash(pos, seed) * 4.0)) + 1;
}

// Direction toward target, with random axis selection
int dirToward(vec2 from, vec2 to, float seed) {
    vec2 diff = to - from;
    
    if (abs(diff.x) < 0.5 && abs(diff.y) < 0.5) {
        return 0;  // Already there
    }
    
    bool canX = abs(diff.x) > 0.5;
    bool canY = abs(diff.y) > 0.5;
    
    if (canX && canY) {
        if (hash(from, seed) < 0.5) {
            return diff.x > 0.0 ? 1 : 3;  // RIGHT or LEFT
        } else {
            return diff.y > 0.0 ? 2 : 4;  // UP or DOWN
        }
    } else if (canX) {
        return diff.x > 0.0 ? 1 : 3;
    } else if (canY) {
        return diff.y > 0.0 ? 2 : 4;
    }
    
    return 0;
}

#endif
