/**
 * Intent System for v2 CA Engine
 * 
 * An Intent represents what a cell "wants to do" this step.
 * The key insight: both the SOURCE cell and DESTINATION cell
 * can call getIntent() to predict behavior and agree on outcomes.
 * 
 * This solves the movement conservation problem:
 * - Source cell: "I want to move right" -> becomes empty
 * - Destination cell: "Neighbor to my left wants to move right" -> becomes that unit
 * 
 * Both cells run the SAME prediction logic, ensuring agreement.
 */

#ifndef INTENT_GLSL
#define INTENT_GLSL

#include "./cell.glsl"

// ============================================================================
// Intent Constants
// ============================================================================

// Movement directions (0 = stay, 1-4 = cardinal directions)
const int DIR_STAY = 0;
const int DIR_RIGHT = 1;
const int DIR_UP = 2;
const int DIR_LEFT = 3;
const int DIR_DOWN = 4;

// Intent types
const int INTENT_NONE = 0;      // Do nothing (empty cells, resources)
const int INTENT_MOVE = 1;      // Move in a direction
const int INTENT_DEPOSIT = 2;   // Deposit resource at factory (stay in place)
const int INTENT_SPAWN = 3;     // Factory spawning a unit

// ============================================================================
// Intent Structure
// ============================================================================

struct Intent {
    int action;         // INTENT_* constant
    int direction;      // DIR_* constant for INTENT_MOVE
    Cell cell;          // The cell data (for copying when moving)
};

// ============================================================================
// Direction Helpers
// ============================================================================

vec2 dirToOffset(int dir) {
    if (dir == DIR_RIGHT) return vec2(1.0, 0.0);
    if (dir == DIR_UP) return vec2(0.0, 1.0);
    if (dir == DIR_LEFT) return vec2(-1.0, 0.0);
    if (dir == DIR_DOWN) return vec2(0.0, -1.0);
    return vec2(0.0, 0.0);
}

int oppositeDir(int dir) {
    if (dir == DIR_RIGHT) return DIR_LEFT;
    if (dir == DIR_UP) return DIR_DOWN;
    if (dir == DIR_LEFT) return DIR_RIGHT;
    if (dir == DIR_DOWN) return DIR_UP;
    return DIR_STAY;
}

// Get direction from 'from' position toward 'to' position
// Uses seed for random axis selection when both axes are valid
int directionToward(vec2 from, vec2 to, float seed) {
    vec2 diff = to - from;
    
    // Already there
    if (abs(diff.x) < 0.5 && abs(diff.y) < 0.5) {
        return DIR_STAY;
    }
    
    bool canX = abs(diff.x) > 0.5;
    bool canY = abs(diff.y) > 0.5;
    
    if (canX && canY) {
        // Both valid - pick based on seed
        if (fract(seed * 0.7919) < 0.5) {
            return diff.x > 0.0 ? DIR_RIGHT : DIR_LEFT;
        } else {
            return diff.y > 0.0 ? DIR_UP : DIR_DOWN;
        }
    } else if (canX) {
        return diff.x > 0.0 ? DIR_RIGHT : DIR_LEFT;
    } else if (canY) {
        return diff.y > 0.0 ? DIR_UP : DIR_DOWN;
    }
    
    return DIR_STAY;
}

// ============================================================================
// Random Direction (for wandering)
// ============================================================================

float hash(vec2 p, float seed) {
    vec3 p3 = fract(vec3(p.x + seed, p.y + seed * 1.3, p.x * 0.7 + p.y) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

int randomDirection(vec2 pos, float seed) {
    float r = hash(pos, seed);
    int dir = int(floor(r * 4.0)) + 1; // 1-4
    return clamp(dir, 1, 4);
}

#endif
