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
// Type -> Traits Mapping
// ============================================================================

int getTraits(int cellType) {
    if (cellType == TYPE_UNIT) return TRAIT_MOBILE;
    if (cellType == TYPE_FACTORY) return TRAIT_SPAWNER;
    if (cellType == TYPE_RESOURCE) return TRAIT_MINABLE;
    // TYPE_WALL and TYPE_EMPTY have no traits
    return 0;
}

// Check if a cell type blocks movement (cannot be entered)
bool blocksMovement(int cellType) {
    // Can move into: empty, resources (to mine), units (collision handled separately)
    // Cannot move into: walls, factories (built or unbuilt), demolish markers
    return cellType == TYPE_WALL || cellType == TYPE_FACTORY || cellType == TYPE_DEMOLISH;
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
// Direction Helpers
// ============================================================================

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
