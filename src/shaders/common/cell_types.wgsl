// Cell Type Definitions for Render Shaders (WGSL)
//
// This is the render-side equivalent of ca/v2/core/types.wgsl.
// Uses float-based type IDs for compatibility with texture sampling
// (textureSample returns float, not int).

// Cell type constants (float for render shader compatibility)
const CELL_EMPTY: f32 = 0.0;
const CELL_RESOURCE: f32 = 1.0;
const CELL_MINING_UNIT: f32 = 2.0;       // Player 1 unit
const CELL_MINING_FACTORY: f32 = 3.0;    // Player 1 factory (built or unbuilt)
const CELL_WALL: f32 = 4.0;
const CELL_MINING_UNIT_P2: f32 = 5.0;    // Player 2 unit
const CELL_DEMOLISH: f32 = 6.0;
const CELL_MINING_FACTORY_P2: f32 = 7.0; // Player 2 factory (built or unbuilt)
const CELL_MISSILE: f32 = 8.0;           // Player 1 missile
const CELL_MISSILE_P2: f32 = 9.0;        // Player 2 missile
const CELL_EXPLOSION: f32 = 10.0;        // Explosion particle

// Explosion particle constants
const EXPLOSION_PARTICLE_LIFETIME_F: f32 = 30.0;

// Player constants
const PLAYER_1: f32 = 1.0;
const PLAYER_2: f32 = 2.0;

// Factory building constants
const MAX_BUILD_PER_CELL: f32 = 1.0;
const BUILD_THRESHOLD: f32 = 8.0;

// Unit age constants
const MAX_AGE: f32 = 500.0;
const NEWBORN_AGE: f32 = -30.0;

// Missile states
const MISSILE_BUILDING: f32 = 0.0;
const MISSILE_ARMED: f32 = 1.0;
const MISSILE_MOVING: f32 = 2.0;
const MISSILE_EXPLODING: f32 = 3.0;
const MISSILE_EXPLOSION_DURATION: f32 = 15.0;

// Missile selected pack base
const MISSILE_SELECTED_PACK_BASE: f32 = 1024.0;

// Coordinate packing
const COORD_PACK_BASE: f32 = 512.0;
const COORD_PACK_SIZE: f32 = 262144.0;  // 512 * 512

// Unit G channel packing
const SELECTED_PACK_BASE: f32 = 32.0;
const AGE_PACK_BASE: f32 = 64.0;
const STATIONARY_THRESHOLD: f32 = 8.0;

// ============================================================================
// Basic Helpers
// ============================================================================

fn getCellType(cell: vec4f) -> f32 {
    return floor(cell.r + 0.5);
}

fn isEmpty(cell: vec4f) -> bool {
    return getCellType(cell) == CELL_EMPTY;
}

fn isResource(cell: vec4f) -> bool {
    return getCellType(cell) == CELL_RESOURCE;
}

fn isMiningUnit(cell: vec4f) -> bool {
    let t: f32 = getCellType(cell);
    return t == CELL_MINING_UNIT || t == CELL_MINING_UNIT_P2;
}

fn isMiningFactory(cell: vec4f) -> bool {
    let t: f32 = getCellType(cell);
    return t == CELL_MINING_FACTORY || t == CELL_MINING_FACTORY_P2;
}

fn getPlayerFromCell(cell: vec4f) -> f32 {
    let t: f32 = getCellType(cell);
    if (t == CELL_MINING_UNIT || t == CELL_MINING_FACTORY || t == CELL_MISSILE) { return PLAYER_1; }
    if (t == CELL_MINING_UNIT_P2 || t == CELL_MINING_FACTORY_P2 || t == CELL_MISSILE_P2) { return PLAYER_2; }
    return 0.0;
}

fn isPlayer1(cell: vec4f) -> bool {
    let t: f32 = getCellType(cell);
    return t == CELL_MINING_UNIT || t == CELL_MINING_FACTORY || t == CELL_MISSILE;
}

fn isPlayer2(cell: vec4f) -> bool {
    let t: f32 = getCellType(cell);
    return t == CELL_MINING_UNIT_P2 || t == CELL_MINING_FACTORY_P2 || t == CELL_MISSILE_P2;
}

fn isMissileCell(cell: vec4f) -> bool {
    let t: f32 = getCellType(cell);
    return t == CELL_MISSILE || t == CELL_MISSILE_P2;
}

fn isExplosionCell(cell: vec4f) -> bool {
    return getCellType(cell) == CELL_EXPLOSION;
}

fn getExplosionLifetimeFromCell(cell: vec4f) -> f32 {
    return cell.g;
}

fn getMissileStateF(cell: vec4f) -> f32 {
    return floor(cell.g / 16.0) % 4.0;
}

fn getMissileSelectedF(cell: vec4f) -> bool {
    return (floor(cell.g / MISSILE_SELECTED_PACK_BASE) % 2.0) > 0.5;
}

fn isWallCell(cell: vec4f) -> bool {
    return getCellType(cell) == CELL_WALL;
}

fn isDemolishCell(cell: vec4f) -> bool {
    return getCellType(cell) == CELL_DEMOLISH;
}

fn isHoldingResource(cell: vec4f) -> bool {
    return (floor(cell.g) % 2.0) > 0.5;
}

fn getUnitSelectedF(cell: vec4f) -> bool {
    return (floor(cell.g / SELECTED_PACK_BASE) % 2.0) > 0.5;
}

fn getUnitAgeF(cell: vec4f) -> f32 {
    return floor(cell.g / AGE_PACK_BASE);
}

fn getFactoryPosition(cell: vec4f) -> vec2f {
    return vec2f(cell.b, cell.a);
}

fn getFactoryResourceCount(cell: vec4f) -> f32 {
    return cell.g;
}

fn getFactoryBuildProgressF(cell: vec4f) -> f32 {
    return cell.g;
}

fn getDemolishCenterF(cell: vec4f) -> vec2f {
    return vec2f(cell.b, cell.a);
}

fn getMissileCenterF(cell: vec4f) -> vec2f {
    let packed: f32 = cell.a;
    if (packed < 0.0) { return vec2f(-1.0); }
    return vec2f(packed % COORD_PACK_BASE, floor(packed / COORD_PACK_BASE));
}

fn getMissileExplosionTimerF(cell: vec4f) -> f32 {
    return floor(cell.g / 64.0) % 16.0;
}

// Sum build progress across factory 3x3 grid
// NOTE: For render shaders, we use textureSampleLevel with UV coordinates
fn sumFactoryBuildProgressSampled(centerPos: vec2f, state_tex: texture_2d<f32>, state_sampler: sampler, resolution: vec2f) -> f32 {
    var total: f32 = 0.0;
    for (var dy: i32 = -1; dy <= 1; dy++) {
        for (var dx: i32 = -1; dx <= 1; dx++) {
            let cellPos: vec2f = centerPos + vec2f(f32(dx), f32(dy));
            let sampleUV: vec2f = (cellPos + 0.5) / resolution;
            let cellRaw: vec4f = textureSampleLevel(state_tex, state_sampler, sampleUV, 0.0);
            if (isMiningFactory(cellRaw)) {
                total += getFactoryBuildProgressF(cellRaw);
            }
        }
    }
    return total;
}
