// Trait System - Behaviors that cell types can have

#include "./types.wgsl"

// ============================================================================
// Type -> Traits Mapping
// ============================================================================

fn getTraits(cellType: i32) -> i32 {
    if (isUnit(cellType)) { return TRAIT_MOBILE; }
    if (isFactory(cellType)) { return TRAIT_SPAWNER; }
    if (cellType == TYPE_RESOURCE) { return TRAIT_MINABLE; }
    return 0;
}

fn blocksMovement(cellType: i32) -> bool {
    return cellType == TYPE_WALL || isFactory(cellType) || isMissile(cellType) || cellType == TYPE_DEMOLISH;
}

fn isDestructible(cellType: i32) -> bool {
    return cellType != TYPE_EMPTY;
}

fn hasTrait(cellType: i32, trait_flag: i32) -> bool {
    return (getTraits(cellType) & trait_flag) != 0;
}

fn isMobile(cellType: i32) -> bool {
    return hasTrait(cellType, TRAIT_MOBILE);
}

fn isSpawner(cellType: i32) -> bool {
    return hasTrait(cellType, TRAIT_SPAWNER);
}

fn isMinable(cellType: i32) -> bool {
    return hasTrait(cellType, TRAIT_MINABLE);
}

// ============================================================================
// Direction Helpers
// ============================================================================

fn dirToOffset(dir: i32) -> vec2f {
    if (dir == DIR_RIGHT) { return vec2f(1.0, 0.0); }
    if (dir == DIR_UP) { return vec2f(0.0, 1.0); }
    if (dir == DIR_LEFT) { return vec2f(-1.0, 0.0); }
    if (dir == DIR_DOWN) { return vec2f(0.0, -1.0); }
    if (dir == DIR_UP_RIGHT) { return vec2f(1.0, 1.0); }
    if (dir == DIR_UP_LEFT) { return vec2f(-1.0, 1.0); }
    if (dir == DIR_DOWN_LEFT) { return vec2f(-1.0, -1.0); }
    if (dir == DIR_DOWN_RIGHT) { return vec2f(1.0, -1.0); }
    return vec2f(0.0);
}

fn oppositeDir(dir: i32) -> i32 {
    if (dir == DIR_RIGHT) { return DIR_LEFT; }
    if (dir == DIR_UP) { return DIR_DOWN; }
    if (dir == DIR_LEFT) { return DIR_RIGHT; }
    if (dir == DIR_DOWN) { return DIR_UP; }
    if (dir == DIR_UP_RIGHT) { return DIR_DOWN_LEFT; }
    if (dir == DIR_UP_LEFT) { return DIR_DOWN_RIGHT; }
    if (dir == DIR_DOWN_LEFT) { return DIR_UP_RIGHT; }
    if (dir == DIR_DOWN_RIGHT) { return DIR_UP_LEFT; }
    return DIR_NONE;
}
