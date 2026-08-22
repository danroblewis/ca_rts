// Cell Types - Raw encoding/decoding for all cell types
//
// Each cell is stored as vec4f (RGBA float):
//   R = type ID
//   G, B, A = type-specific data

#include "./constants.wgsl"

// ============================================================================
// Raw Access
// ============================================================================

fn getType(raw: vec4f) -> i32 {
    return i32(floor(raw.r + 0.5));
}

// ============================================================================
// Player-Aware Type Helpers
// ============================================================================

fn isUnit(cellType: i32) -> bool {
    return cellType == TYPE_UNIT || cellType == TYPE_UNIT_P2;
}

fn isFactory(cellType: i32) -> bool {
    return cellType == TYPE_FACTORY || cellType == TYPE_FACTORY_P2;
}

fn isP1Unit(cellType: i32) -> bool {
    return cellType == TYPE_UNIT;
}

fn isP2Unit(cellType: i32) -> bool {
    return cellType == TYPE_UNIT_P2;
}

fn isP1Factory(cellType: i32) -> bool {
    return cellType == TYPE_FACTORY;
}

fn isP2Factory(cellType: i32) -> bool {
    return cellType == TYPE_FACTORY_P2;
}

fn getPlayer(cellType: i32) -> i32 {
    if (cellType == TYPE_UNIT || cellType == TYPE_FACTORY || cellType == TYPE_MISSILE) { return PLAYER_1; }
    if (cellType == TYPE_UNIT_P2 || cellType == TYPE_FACTORY_P2 || cellType == TYPE_MISSILE_P2) { return PLAYER_2; }
    return 0;
}

fn getUnitTypeForPlayer(player: i32) -> i32 {
    if (player == PLAYER_2) { return TYPE_UNIT_P2; }
    return TYPE_UNIT;
}

fn getFactoryTypeForPlayer(player: i32) -> i32 {
    if (player == PLAYER_2) { return TYPE_FACTORY_P2; }
    return TYPE_FACTORY;
}

// ============================================================================
// Coordinate Packing
// ============================================================================

fn packCoords(pos: vec2f) -> f32 {
    if (pos.x < 0.0 || pos.y < 0.0) {
        return INVALID_PACKED_COORDS;
    }
    return floor(pos.x) + floor(pos.y) * COORD_PACK_BASE;
}

fn unpackCoords(packed: f32) -> vec2f {
    if (packed < 0.0) {
        return vec2f(-1.0);
    }
    return vec2f(packed % COORD_PACK_BASE, floor(packed / COORD_PACK_BASE));
}

// ============================================================================
// EMPTY
// ============================================================================

fn encodeEmpty() -> vec4f {
    return vec4f(f32(TYPE_EMPTY), 0.0, 0.0, 0.0);
}

// ============================================================================
// RESOURCE
// ============================================================================

fn getResourceAmount(raw: vec4f) -> f32 {
    return raw.g;
}

fn getResourcePhase(raw: vec4f) -> f32 {
    return raw.b;
}

fn encodeResource(amount: f32) -> vec4f {
    return vec4f(f32(TYPE_RESOURCE), amount, 0.0, 0.0);
}

fn encodeResourceWithPhase(amount: f32, phase: f32) -> vec4f {
    return vec4f(f32(TYPE_RESOURCE), amount, phase, 0.0);
}

// ============================================================================
// UNIT
// G = holding (bit 0) + counter*2 (bits 1-4) + selected*32 (bit 5) + age*64 (bits 6+)
// B = packed factory location
// A = packed resource memory OR negative homesick timer
// ============================================================================

fn getUnitHolding(raw: vec4f) -> bool {
    return (floor(raw.g) % 2.0) > 0.5;
}

fn getUnitCounter(raw: vec4f) -> i32 {
    return i32(floor(raw.g / 2.0) % 16.0);
}

fn getUnitSelected(raw: vec4f) -> bool {
    return (floor(raw.g / SELECTED_PACK_BASE) % 2.0) > 0.5;
}

fn getUnitAge(raw: vec4f) -> f32 {
    return floor(raw.g / AGE_PACK_BASE);
}

fn getUnitFactory(raw: vec4f) -> vec2f {
    return unpackCoords(raw.b);
}

fn getUnitMemoryPos(raw: vec4f) -> vec2f {
    if (raw.a < 0.0) { return vec2f(-1.0); }
    return unpackCoords(raw.a % MEMORY_PACK_BASE);
}

fn getUnitMemoryFreshness(raw: vec4f) -> f32 {
    if (raw.a < 0.0) { return 0.0; }
    return floor(raw.a / MEMORY_PACK_BASE);
}

fn getUnitHomesickTimer(raw: vec4f) -> f32 {
    if (raw.a >= 0.0) { return 0.0; }
    return -raw.a - 1.0;
}

fn encodeUnitRaw(player: i32, holding: bool, counter: i32, selected: bool, age: f32, factoryPos: vec2f, memoryPos: vec2f, freshness: f32, homesickTimer: f32) -> vec4f {
    var g: f32 = select(0.0, 1.0, holding) + f32(counter) * 2.0 + select(0.0, SELECTED_PACK_BASE, selected) + age * AGE_PACK_BASE;
    let b: f32 = packCoords(factoryPos);
    var a: f32;
    if (freshness > 0.0 && memoryPos.x >= 0.0) {
        a = packCoords(memoryPos) + freshness * MEMORY_PACK_BASE;
    } else {
        a = -(homesickTimer + 1.0);
    }
    return vec4f(f32(getUnitTypeForPlayer(player)), g, b, a);
}

fn encodeUnitSimple(player: i32, holding: bool, counter: i32, factoryPos: vec2f) -> vec4f {
    return encodeUnitRaw(player, holding, counter, false, 0.0, factoryPos, vec2f(-1.0), 0.0, 0.0);
}

fn encodeNewbornUnit(player: i32, factoryPos: vec2f) -> vec4f {
    return encodeUnitRaw(player, false, 0, false, NEWBORN_AGE, factoryPos, vec2f(-1.0), 0.0, 0.0);
}

fn encodeUnitWithSelection(existingUnit: vec4f, player: i32, selected: bool) -> vec4f {
    let holding: bool = getUnitHolding(existingUnit);
    let counter: i32 = getUnitCounter(existingUnit);
    let age: f32 = getUnitAge(existingUnit);
    let factoryPos: vec2f = getUnitFactory(existingUnit);
    let memoryPos: vec2f = getUnitMemoryPos(existingUnit);
    let freshness: f32 = getUnitMemoryFreshness(existingUnit);
    let homesickTimer: f32 = getUnitHomesickTimer(existingUnit);
    return encodeUnitRaw(player, holding, counter, selected, age, factoryPos, memoryPos, freshness, homesickTimer);
}

// ============================================================================
// FACTORY
// G = resource count (or build progress for unbuilt)
// B = center X
// A = center Y
// ============================================================================

fn getFactoryResources(raw: vec4f) -> f32 {
    return raw.g;
}

fn getFactoryBuildProgress(raw: vec4f) -> f32 {
    return raw.g;
}

fn getFactoryPos(raw: vec4f) -> vec2f {
    return vec2f(raw.b, raw.a);
}

fn sumFactoryBuildProgress(centerPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> f32 {
    var total: f32 = 0.0;
    for (var dy: i32 = -1; dy <= 1; dy++) {
        for (var dx: i32 = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) { continue; }
            let cellPos: vec2f = centerPos + vec2f(f32(dx), f32(dy));
            let cellRaw: vec4f = textureLoad(state, vec2i(cellPos), 0);
            if (isFactory(getType(cellRaw))) {
                total += getFactoryBuildProgress(cellRaw);
            }
        }
    }
    return total;
}

fn isFactoryBuilt(centerPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> bool {
    return sumFactoryBuildProgress(centerPos, state, resolution) >= BUILD_THRESHOLD;
}

fn encodeFactory(resources: f32, selfPos: vec2f, player: i32) -> vec4f {
    let factoryType: i32 = getFactoryTypeForPlayer(player);
    return vec4f(f32(factoryType), resources, selfPos.x, selfPos.y);
}

fn encodeUnbuiltFactory(buildProgress: f32, centerPos: vec2f, player: i32) -> vec4f {
    let factoryType: i32 = getFactoryTypeForPlayer(player);
    return vec4f(f32(factoryType), min(buildProgress, MAX_BUILD_PER_CELL), centerPos.x, centerPos.y);
}

// ============================================================================
// WALL
// ============================================================================

fn encodeWall() -> vec4f {
    return vec4f(f32(TYPE_WALL), 0.0, 0.0, 0.0);
}

// ============================================================================
// DEMOLISH
// ============================================================================

fn getDemolishCenter(raw: vec4f) -> vec2f {
    return vec2f(raw.b, raw.a);
}

fn encodeDemolish(centerPos: vec2f) -> vec4f {
    return vec4f(f32(TYPE_DEMOLISH), 0.0, centerPos.x, centerPos.y);
}

// ============================================================================
// MISSILE
// ============================================================================

const MISSILE_SELECTED_PACK_BASE: f32 = 1024.0;

fn isMissile(cellType: i32) -> bool {
    return cellType == TYPE_MISSILE || cellType == TYPE_MISSILE_P2;
}

fn getMissileTypeForPlayer(player: i32) -> i32 {
    if (player == PLAYER_2) { return TYPE_MISSILE_P2; }
    return TYPE_MISSILE;
}

fn getMissileBuildProgress(raw: vec4f) -> f32 {
    return floor(raw.g) % 16.0;
}

fn getMissileState(raw: vec4f) -> i32 {
    return i32(floor(raw.g / 16.0) % 4.0);
}

fn getMissileExplosionTimer(raw: vec4f) -> i32 {
    return i32(floor(raw.g / 64.0) % 16.0);
}

fn getMissileSelected(raw: vec4f) -> bool {
    return (floor(raw.g / MISSILE_SELECTED_PACK_BASE) % 2.0) > 0.5;
}

fn getMissileDestination(raw: vec4f) -> vec2f {
    return unpackCoords(raw.b);
}

fn getMissileCenter(raw: vec4f) -> vec2f {
    return unpackCoords(raw.a);
}

fn missileHasDestination(raw: vec4f) -> bool {
    return raw.b >= 0.0;
}

fn encodeMissile(buildProgress: f32, state: i32, explosionTimer: i32, selected: bool, destination: vec2f, center: vec2f, player: i32) -> vec4f {
    let missileType: i32 = getMissileTypeForPlayer(player);
    let g: f32 = buildProgress + f32(state) * 16.0 + f32(explosionTimer) * 64.0 + select(0.0, MISSILE_SELECTED_PACK_BASE, selected);
    let b: f32 = packCoords(destination);
    let a: f32 = packCoords(center);
    return vec4f(f32(missileType), g, b, a);
}

fn encodeMissileBuilding(buildProgress: f32, center: vec2f, player: i32) -> vec4f {
    return encodeMissile(buildProgress, MISSILE_BUILDING, 0, false, vec2f(-1.0), center, player);
}

fn encodeMissileArmed(center: vec2f, player: i32, selected: bool) -> vec4f {
    return encodeMissile(MISSILE_BUILD_THRESHOLD, MISSILE_ARMED, 0, selected, vec2f(-1.0), center, player);
}

fn encodeMissileMoving(destination: vec2f, center: vec2f, player: i32) -> vec4f {
    return encodeMissile(MISSILE_BUILD_THRESHOLD, MISSILE_MOVING, 0, false, destination, center, player);
}

fn encodeMissileExploding(timer: i32, center: vec2f, player: i32) -> vec4f {
    return encodeMissile(MISSILE_BUILD_THRESHOLD, MISSILE_EXPLODING, timer, false, center, center, player);
}

fn sumMissileBuildProgress(centerPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> f32 {
    var total: f32 = 0.0;
    for (var dy: i32 = -1; dy <= 1; dy++) {
        for (var dx: i32 = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) { continue; }
            let cellPos: vec2f = centerPos + vec2f(f32(dx), f32(dy));
            let cellRaw: vec4f = textureLoad(state, vec2i(cellPos), 0);
            if (isMissile(getType(cellRaw))) {
                total += getMissileBuildProgress(cellRaw);
            }
        }
    }
    return total;
}

fn isMissileBuilt(centerPos: vec2f, state: texture_2d<f32>, resolution: vec2f) -> bool {
    return sumMissileBuildProgress(centerPos, state, resolution) >= MISSILE_BUILD_THRESHOLD;
}

// ============================================================================
// EXPLOSION PARTICLE
// ============================================================================

fn isExplosion(cellType: i32) -> bool {
    return cellType == TYPE_EXPLOSION;
}

fn getExplosionLifetime(raw: vec4f) -> i32 {
    return i32(raw.g);
}

fn encodeExplosion(lifetime: i32) -> vec4f {
    return vec4f(f32(TYPE_EXPLOSION), f32(lifetime), 0.0, 0.0);
}
