/**
 * Constants - All game constants in one place for easy tweaking
 * 
 * This file is THE source of truth for all numeric constants.
 * Import this file in any shader that needs constants.
 */

#ifndef CONSTANTS_GLSL
#define CONSTANTS_GLSL

// ============================================================================
// CELL TYPES
// ============================================================================

const int TYPE_EMPTY = 0;
const int TYPE_RESOURCE = 1;
const int TYPE_UNIT = 2;        // Player 1 unit
const int TYPE_FACTORY = 3;     // Player 1 factory (built or unbuilt)
const int TYPE_WALL = 4;
const int TYPE_UNIT_P2 = 5;     // Player 2 unit
const int TYPE_DEMOLISH = 6;    // Marked for destruction by units
const int TYPE_FACTORY_P2 = 7;  // Player 2 factory (built or unbuilt)

// ============================================================================
// PLAYER CONSTANTS
// ============================================================================

const int PLAYER_1 = 1;
const int PLAYER_2 = 2;

// ============================================================================
// TRAIT FLAGS (bitmask)
// ============================================================================

const int TRAIT_MOBILE = 1;      // Can move to adjacent cells
const int TRAIT_SPAWNER = 2;     // Can create new cells
const int TRAIT_MINABLE = 4;     // Can be extracted/mined

// ============================================================================
// DIRECTION CONSTANTS
// ============================================================================

const int DIR_NONE = 0;
const int DIR_RIGHT = 1;
const int DIR_UP = 2;
const int DIR_LEFT = 3;
const int DIR_DOWN = 4;
// Diagonal directions
const int DIR_UP_RIGHT = 5;
const int DIR_UP_LEFT = 6;
const int DIR_DOWN_LEFT = 7;
const int DIR_DOWN_RIGHT = 8;

// ============================================================================
// COORDINATE PACKING
// ============================================================================

const float COORD_PACK_BASE = 256.0;
const float MEMORY_PACK_BASE = 65536.0;  // 256 * 256
const float INVALID_PACKED_COORDS = -1.0;

// ============================================================================
// UNIT PROPERTIES
// ============================================================================

// G channel bit packing: holding (bit 0) + counter*2 (bits 1-4) + selected*32 (bit 5) + age*64 (bits 6+)
const float SELECTED_PACK_BASE = 32.0;   // Selection flag at bit 5
const float AGE_PACK_BASE = 64.0;        // Age starts at bit 6 (after selection bit)
const float MAX_AGE = 500.0;             // Steps before unit dies from starvation
const float FACTORY_SAFE_ZONE = 10.0;    // Units within this distance of factory don't starve
const float NEWBORN_AGE = -30.0;         // Starting age for newly spawned units (negative = newborn glow)

// ============================================================================
// MOVEMENT
// ============================================================================

const int VISION_RANGE = 5;              // How far units can see resources/blueprints
const float STATIONARY_THRESHOLD = 8.0;  // Counter value that triggers entering walking mode
const float WALKING_EXIT_THRESHOLD = 1.0; // Counter must drop TO this to exit walking mode (hysteresis)
const float MAX_WANDER_DISTANCE = 65.0;  // Max distance from factory before returning

// ============================================================================
// MEMORY SYSTEM
// ============================================================================

const float MEMORY_MAX_FRESHNESS = 200.0;  // How long memory lasts
const float MEMORY_SHARE_PENALTY = 5.0;    // Freshness cost when sharing memory
const int MEMORY_VISION_RANGE = 5;         // Range for memory sharing
const float HOMESICK_THRESHOLD = 1000.0;    // Steps before returning to factory

// ============================================================================
// FACTORY / SPAWNING
// ============================================================================

const float SPAWN_COST = 50.0;  // Resources needed to spawn a unit

// ============================================================================
// FACTORY BUILDING (unbuilt factories need to be constructed)
// ============================================================================

const float MAX_BUILD_PER_CELL = 1.0;  // Max build count per factory cell
const float BUILD_THRESHOLD = 8.0;     // Total build count across 3x3 to complete

#endif

