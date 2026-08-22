// Constants - All game constants in one place for easy tweaking
//
// This file is THE source of truth for all numeric constants.
// Import this file in any shader that needs constants.

// ============================================================================
// CELL TYPES
// ============================================================================

const TYPE_EMPTY: i32 = 0;
const TYPE_RESOURCE: i32 = 1;
const TYPE_UNIT: i32 = 2;        // Player 1 unit
const TYPE_FACTORY: i32 = 3;     // Player 1 factory (built or unbuilt)
const TYPE_WALL: i32 = 4;
const TYPE_UNIT_P2: i32 = 5;     // Player 2 unit
const TYPE_DEMOLISH: i32 = 6;    // Marked for destruction by units
const TYPE_FACTORY_P2: i32 = 7;  // Player 2 factory (built or unbuilt)
const TYPE_MISSILE: i32 = 8;     // Player 1 missile
const TYPE_MISSILE_P2: i32 = 9;  // Player 2 missile
const TYPE_EXPLOSION: i32 = 10;  // Explosion particle

// ============================================================================
// PLAYER CONSTANTS
// ============================================================================

const PLAYER_1: i32 = 1;
const PLAYER_2: i32 = 2;

// ============================================================================
// TRAIT FLAGS (bitmask)
// ============================================================================

const TRAIT_MOBILE: i32 = 1;
const TRAIT_SPAWNER: i32 = 2;
const TRAIT_MINABLE: i32 = 4;

// ============================================================================
// DIRECTION CONSTANTS
// ============================================================================

const DIR_NONE: i32 = 0;
const DIR_RIGHT: i32 = 1;
const DIR_UP: i32 = 2;
const DIR_LEFT: i32 = 3;
const DIR_DOWN: i32 = 4;
const DIR_UP_RIGHT: i32 = 5;
const DIR_UP_LEFT: i32 = 6;
const DIR_DOWN_LEFT: i32 = 7;
const DIR_DOWN_RIGHT: i32 = 8;

// ============================================================================
// COORDINATE PACKING
// ============================================================================

const COORD_PACK_BASE: f32 = 512.0;
const MEMORY_PACK_BASE: f32 = 262144.0;  // 512 * 512
const INVALID_PACKED_COORDS: f32 = -1.0;

// ============================================================================
// UNIT PROPERTIES
// ============================================================================

const SELECTED_PACK_BASE: f32 = 32.0;
const AGE_PACK_BASE: f32 = 64.0;
const MAX_AGE: f32 = 500.0;
const FACTORY_SAFE_ZONE: f32 = 10.0;
const NEWBORN_AGE: f32 = -30.0;

// ============================================================================
// MOVEMENT
// ============================================================================

const VISION_RANGE: i32 = 5;
const STATIONARY_THRESHOLD: f32 = 8.0;
const WALKING_EXIT_THRESHOLD: f32 = 1.0;
const MAX_WANDER_DISTANCE: f32 = 65.0;

// ============================================================================
// MEMORY SYSTEM
// ============================================================================

const MEMORY_MAX_FRESHNESS: f32 = 200.0;
const MEMORY_SHARE_PENALTY: f32 = 5.0;
const MEMORY_VISION_RANGE: i32 = 5;
const HOMESICK_THRESHOLD: f32 = 1000.0;

// ============================================================================
// FACTORY / SPAWNING
// ============================================================================

const SPAWN_COST: f32 = 50.0;

// ============================================================================
// FACTORY BUILDING
// ============================================================================

const MAX_BUILD_PER_CELL: f32 = 1.0;
const BUILD_THRESHOLD: f32 = 8.0;

// ============================================================================
// MISSILE SYSTEM
// ============================================================================

const MISSILE_BUILDING: i32 = 0;
const MISSILE_ARMED: i32 = 1;
const MISSILE_MOVING: i32 = 2;
const MISSILE_EXPLODING: i32 = 3;

const MISSILE_BUILD_THRESHOLD: f32 = 8.0;
const MISSILE_EXPLOSION_RADIUS: f32 = 5.0;
const MISSILE_EXPLOSION_DURATION: i32 = 15;
const MISSILE_SURROUND_REQUIRED: i32 = 8;
const MISSILE_PATH_WIDTH: f32 = 3.0;
const MISSILE_MOVE_DELAY: i32 = 6;

const EXPLOSION_PARTICLE_LIFETIME: i32 = 30;
const EXPLOSION_PARTICLES_PER_FRAME: i32 = 3;

// Helper constants for audio shader
const CELL_RESOURCE: f32 = 1.0;
