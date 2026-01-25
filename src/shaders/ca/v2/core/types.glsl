/**
 * Cell Types - Raw encoding/decoding for all cell types
 * 
 * Each cell is stored as vec4 (RGBA float):
 *   R = type ID
 *   G, B, A = type-specific data
 */

#ifndef TYPES_GLSL
#define TYPES_GLSL

#include "./constants.glsl"

// ============================================================================
// Raw Access
// ============================================================================

int getType(vec4 raw) {
    return int(floor(raw.r + 0.5));
}

// ============================================================================
// Player-Aware Type Helpers
// ============================================================================

// Check if a cell is any type of unit (player 1 or 2)
bool isUnit(int cellType) {
    return cellType == TYPE_UNIT || cellType == TYPE_UNIT_P2;
}

// Check if a cell is any type of factory (player 1 or 2)
bool isFactory(int cellType) {
    return cellType == TYPE_FACTORY || cellType == TYPE_FACTORY_P2;
}

// Get player ID from a unit or factory type (returns 0 for non-owned types)
int getPlayer(int cellType) {
    if (cellType == TYPE_UNIT || cellType == TYPE_FACTORY) return PLAYER_1;
    if (cellType == TYPE_UNIT_P2 || cellType == TYPE_FACTORY_P2) return PLAYER_2;
    return 0;
}

// Get the unit type for a specific player
int getUnitTypeForPlayer(int player) {
    return player == PLAYER_2 ? TYPE_UNIT_P2 : TYPE_UNIT;
}

// Get the factory type for a specific player
int getFactoryTypeForPlayer(int player) {
    return player == PLAYER_2 ? TYPE_FACTORY_P2 : TYPE_FACTORY;
}

// ============================================================================
// Coordinate Packing (for 128x128 grids)
// ============================================================================

float packCoords(vec2 pos) {
    // Handle invalid coordinates (negative values mean "no position")
    if (pos.x < 0.0 || pos.y < 0.0) {
        return INVALID_PACKED_COORDS;
    }
    return floor(pos.x) + floor(pos.y) * COORD_PACK_BASE;
}

vec2 unpackCoords(float packed) {
    // Handle invalid packed value
    if (packed < 0.0) {
        return vec2(-1.0);
    }
    return vec2(mod(packed, COORD_PACK_BASE), floor(packed / COORD_PACK_BASE));
}

// ============================================================================
// EMPTY
// ============================================================================

vec4 encodeEmpty() {
    return vec4(float(TYPE_EMPTY), 0.0, 0.0, 0.0);
}

// ============================================================================
// RESOURCE
// G = amount
// ============================================================================

float getResourceAmount(vec4 raw) {
    return raw.g;
}

vec4 encodeResource(float amount) {
    return vec4(float(TYPE_RESOURCE), amount, 0.0, 0.0);
}

// ============================================================================
// UNIT
// G = holding (bit 0) + stationaryCounter * 2 + age * 32
//     holding: 0 or 1
//     counter: 0-15 (4 bits)
//     age: 0-∞ (hunger/starvation counter)
// B = packed factory location
// A = packed resource memory with freshness, OR negative homesick timer
//     A >= 0: has memory (packCoords + freshness * MEMORY_PACK_BASE)
//     A < 0: no memory, homesick timer = -A - 1  (so -1 = timer 0, -2 = timer 1, etc)
// ============================================================================

bool getUnitHolding(vec4 raw) {
    return mod(floor(raw.g), 2.0) > 0.5;
}

int getUnitCounter(vec4 raw) {
    return int(mod(floor(raw.g / 2.0), 16.0));  // 4 bits for counter (0-15)
}

float getUnitAge(vec4 raw) {
    return floor(raw.g / AGE_PACK_BASE);
}

vec2 getUnitFactory(vec4 raw) {
    return unpackCoords(raw.b);
}

vec2 getUnitMemoryPos(vec4 raw) {
    if (raw.a < 0.0) return vec2(-1.0);
    return unpackCoords(mod(raw.a, MEMORY_PACK_BASE));
}

float getUnitMemoryFreshness(vec4 raw) {
    if (raw.a < 0.0) return 0.0;
    return floor(raw.a / MEMORY_PACK_BASE);
}

// Homesick timer: stored as negative values when no memory
// -1 = timer 0, -2 = timer 1, etc.
float getUnitHomesickTimer(vec4 raw) {
    if (raw.a >= 0.0) return 0.0;  // Has memory, no homesick timer
    return -raw.a - 1.0;
}

// Forward declare MemoryState struct (defined in memory.glsl)
// We use raw components here to avoid circular dependency
// homesickTimer is only used when freshness <= 0
vec4 encodeUnitRaw(int player, bool holding, int counter, float age, vec2 factoryPos, vec2 memoryPos, float freshness, float homesickTimer) {
    float g = (holding ? 1.0 : 0.0) + float(counter) * 2.0 + age * AGE_PACK_BASE;
    float b = packCoords(factoryPos);
    float a;
    if (freshness > 0.0 && memoryPos.x >= 0.0) {
        // Has memory
        a = packCoords(memoryPos) + freshness * MEMORY_PACK_BASE;
    } else {
        // No memory - encode homesick timer as negative
        a = -(homesickTimer + 1.0);
    }
    return vec4(float(getUnitTypeForPlayer(player)), g, b, a);
}

vec4 encodeUnitSimple(int player, bool holding, int counter, vec2 factoryPos) {
    return encodeUnitRaw(player, holding, counter, 0.0, factoryPos, vec2(-1.0), 0.0, 0.0);
}

// ============================================================================
// FACTORY (unified: built or unbuilt)
// G = resource count (or build progress for unbuilt factories)
//     For unbuilt: each cell stores its individual build progress (0-MAX_BUILD_PER_CELL)
//     For built: each cell stores resources
// B = center X (center of 3x3 factory)
// A = center Y
// 
// A factory is "built" when the sum of G across all 8 outer cells >= BUILD_THRESHOLD
// ============================================================================

float getFactoryResources(vec4 raw) {
    return raw.g;
}

// For unbuilt factories, G represents build progress per cell
float getFactoryBuildProgress(vec4 raw) {
    return raw.g;
}

vec2 getFactoryPos(vec4 raw) {
    return vec2(raw.b, raw.a);
}

// Sum build progress across all 8 outer cells of a 3x3 factory
// (center cell is empty, so we skip it)
float sumFactoryBuildProgress(vec2 centerPos, sampler2D state, vec2 resolution) {
    float total = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) continue;  // Skip center
            vec2 cellPos = centerPos + vec2(float(dx), float(dy));
            vec4 cellRaw = texture(state, (cellPos + 0.5) / resolution);
            if (isFactory(getType(cellRaw))) {  // Check for any player's factory
                total += getFactoryBuildProgress(cellRaw);
            }
        }
    }
    return total;
}

// Check if a factory at centerPos is fully built
bool isFactoryBuilt(vec2 centerPos, sampler2D state, vec2 resolution) {
    return sumFactoryBuildProgress(centerPos, state, resolution) >= BUILD_THRESHOLD;
}

vec4 encodeFactory(float resources, vec2 selfPos, int player) {
    int factoryType = getFactoryTypeForPlayer(player);
    return vec4(float(factoryType), resources, selfPos.x, selfPos.y);
}

// Encode an unbuilt factory cell (same encoding, just clearer intent)
vec4 encodeUnbuiltFactory(float buildProgress, vec2 centerPos, int player) {
    int factoryType = getFactoryTypeForPlayer(player);
    return vec4(float(factoryType), min(buildProgress, MAX_BUILD_PER_CELL), centerPos.x, centerPos.y);
}

// ============================================================================
// WALL
// Simple obstacle - no additional data needed
// ============================================================================

vec4 encodeWall() {
    return vec4(float(TYPE_WALL), 0.0, 0.0, 0.0);
}


// ============================================================================
// DEMOLISH (marked for destruction)
// G = unused
// B = centerX (center of 3x3 structure)
// A = centerY
// 
// When a non-holding unit is adjacent, it destroys this cell and picks up a resource
// ============================================================================

vec2 getDemolishCenter(vec4 raw) {
    return vec2(raw.b, raw.a);
}

vec4 encodeDemolish(vec2 centerPos) {
    return vec4(float(TYPE_DEMOLISH), 0.0, centerPos.x, centerPos.y);
}

#endif
