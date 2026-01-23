/**
 * Trait System - Behaviors that cell types can have
 * 
 * A trait is a behavior (like "can move", "can spawn", "can be mined").
 * Each cell type is a collection of traits.
 * 
 * For each trait, there's ONE canonical evaluation function that determines
 * "what happens in this local region". Every pixel calls the same function
 * and extracts its role from the result.
 */

#ifndef TRAITS_GLSL
#define TRAITS_GLSL

#include "./types.glsl"

// ============================================================================
// Trait Constants (bitmask)
// ============================================================================

const int TRAIT_MOBILE = 1;      // Can move to adjacent cells
const int TRAIT_SPAWNER = 2;     // Can create new cells
const int TRAIT_MINABLE = 4;     // Can be extracted/mined

// ============================================================================
// Type -> Traits Mapping
// ============================================================================

int getTraits(int cellType) {
    if (cellType == TYPE_UNIT) return TRAIT_MOBILE;
    if (cellType == TYPE_FACTORY) return TRAIT_SPAWNER;
    if (cellType == TYPE_RESOURCE) return TRAIT_MINABLE;
    return 0;  // EMPTY has no traits
}

bool hasTrait(int cellType, int trait) {
    return (getTraits(cellType) & trait) != 0;
}

bool isMobile(int cellType) {
    return hasTrait(cellType, TRAIT_MOBILE);
}

bool isSpawner(int cellType) {
    return hasTrait(cellType, TRAIT_SPAWNER);
}

bool isMinable(int cellType) {
    return hasTrait(cellType, TRAIT_MINABLE);
}

// ============================================================================
// Direction Constants
// ============================================================================

const int DIR_NONE = 0;
const int DIR_RIGHT = 1;
const int DIR_UP = 2;
const int DIR_LEFT = 3;
const int DIR_DOWN = 4;

vec2 dirToOffset(int dir) {
    if (dir == DIR_RIGHT) return vec2(1.0, 0.0);
    if (dir == DIR_UP) return vec2(0.0, 1.0);
    if (dir == DIR_LEFT) return vec2(-1.0, 0.0);
    if (dir == DIR_DOWN) return vec2(0.0, -1.0);
    return vec2(0.0);
}

int oppositeDir(int dir) {
    if (dir == DIR_RIGHT) return DIR_LEFT;
    if (dir == DIR_UP) return DIR_DOWN;
    if (dir == DIR_LEFT) return DIR_RIGHT;
    if (dir == DIR_DOWN) return DIR_UP;
    return DIR_NONE;
}

#endif
