/**
 * Cell Type Definitions for CA Shaders
 * 
 * Cell encoding (RGBA float):
 *   R: cell type
 *   G: data A (type-specific)
 *   B: data B (type-specific)
 *   A: data C (type-specific)
 */

// Cell type constants
const float CELL_EMPTY = 0.0;
const float CELL_RESOURCE = 1.0;
const float CELL_MINING_UNIT = 2.0;
const float CELL_MINING_FACTORY = 3.0;
const float CELL_WALL = 4.0;

// ============================================================================
// Coordinate packing (for grids up to 256x256)
// Pack two 8-bit coordinates into one float
// ============================================================================

float packCoords(vec2 pos) {
    return floor(pos.x) + floor(pos.y) * 256.0;
}

vec2 unpackCoords(float packed) {
    return vec2(mod(packed, 256.0), floor(packed / 256.0));
}

// Special value for "no location"
const float NO_LOCATION = -1.0;

bool hasLocation(float packed) {
    return packed >= 0.0;
}

// ============================================================================
// Get cell type from cell data
// ============================================================================

float getCellType(vec4 cell) {
    return floor(cell.r + 0.5);
}

// Check cell types
bool isEmpty(vec4 cell) {
    return getCellType(cell) == CELL_EMPTY;
}

bool isResource(vec4 cell) {
    return getCellType(cell) == CELL_RESOURCE;
}

bool isMiningUnit(vec4 cell) {
    return getCellType(cell) == CELL_MINING_UNIT;
}

bool isMiningFactory(vec4 cell) {
    return getCellType(cell) == CELL_MINING_FACTORY;
}

bool isWall(vec4 cell) {
    return getCellType(cell) == CELL_WALL;
}

// ============================================================================
// RESOURCE
// G = amount (unused for now)
// ============================================================================

float getResourceAmount(vec4 cell) {
    return cell.g;
}

vec4 createResource(float amount) {
    return vec4(CELL_RESOURCE, amount, 0.0, 0.0);
}

// ============================================================================
// MINING UNIT (with bit-packed locations)
// G = packed: holding (bit 0) + stationary_counter * 2 (bits 1+)
//     holding: 0 = empty, 1 = carrying resource
//     stationary_counter: how long stuck, or countdown when walking
// B = packed factory location (x + y * 128)
// A = packed: resource location + freshness * 16384, or -1 if none
//     location: x + y * 128 (0-16383)
//     freshness: how fresh the memory is (decrements each step, 0 = expired)
// ============================================================================

// Threshold: after this many steps stuck, start walking
const float STATIONARY_THRESHOLD = 8.0;

// Memory freshness settings
const float MEMORY_MAX_FRESHNESS = 30.0;  // Starts at this when mining
const float MEMORY_SHARE_PENALTY = 5.0;   // Lose this much freshness when shared
const float COORD_PACK_SIZE = 65536.0;    // 256 * 256 for coord packing

// Unpack G channel
float getHoldingBit(vec4 cell) {
    return mod(floor(cell.g), 2.0);
}

float getStationaryCounter(vec4 cell) {
    return floor(cell.g / 2.0);
}

// Pack holding + counter into G
float packHoldingAndCounter(float holding, float counter) {
    return floor(holding) + floor(counter) * 2.0;
}

bool isHoldingResource(vec4 cell) {
    return getHoldingBit(cell) > 0.5;
}

bool isWalking(vec4 cell) {
    return getStationaryCounter(cell) >= STATIONARY_THRESHOLD;
}

vec2 getFactoryLocation(vec4 cell) {
    return unpackCoords(cell.b);
}

// Resource memory with freshness
vec2 getLastResourceLocation(vec4 cell) {
    float packed = cell.a;
    if (packed < 0.0) return vec2(-1.0);
    float coordPart = mod(packed, COORD_PACK_SIZE);
    return unpackCoords(coordPart);
}

float getMemoryFreshness(vec4 cell) {
    float packed = cell.a;
    if (packed < 0.0) return 0.0;
    return floor(packed / COORD_PACK_SIZE);
}

bool hasLastResourceLocation(vec4 cell) {
    return cell.a >= 0.0 && getMemoryFreshness(cell) > 0.0;
}

float packMemory(vec2 pos, float freshness) {
    if (freshness <= 0.0) return -1.0;
    return packCoords(pos) + floor(freshness) * COORD_PACK_SIZE;
}

// Create unit with memory (specify freshness)
vec4 createMiningUnitWithMemory(float holding, float stationaryCounter, vec2 factoryPos, vec2 lastResourcePos, float freshness) {
    return vec4(
        CELL_MINING_UNIT,
        packHoldingAndCounter(holding, stationaryCounter),
        packCoords(factoryPos),
        packMemory(lastResourcePos, freshness)
    );
}

// Create unit with fresh memory (just mined - max freshness)
vec4 createMiningUnit(float holding, float stationaryCounter, vec2 factoryPos, vec2 lastResourcePos) {
    return createMiningUnitWithMemory(holding, stationaryCounter, factoryPos, lastResourcePos, MEMORY_MAX_FRESHNESS);
}

// Convenience: create unit with no last resource memory
vec4 createMiningUnitSimple(float holding, float stationaryCounter, vec2 factoryPos) {
    return vec4(
        CELL_MINING_UNIT,
        packHoldingAndCounter(holding, stationaryCounter),
        packCoords(factoryPos),
        NO_LOCATION
    );
}

// ============================================================================
// MINING FACTORY
// G = resource count
// B = self X coordinate
// A = self Y coordinate
// ============================================================================

float getFactoryResourceCount(vec4 cell) {
    return cell.g;
}

vec2 getFactoryPosition(vec4 cell) {
    return vec2(cell.b, cell.a);
}

vec4 createMiningFactory(float resourceCount, float selfX, float selfY) {
    return vec4(CELL_MINING_FACTORY, resourceCount, selfX, selfY);
}

// ============================================================================
// EMPTY
// ============================================================================

vec4 createEmpty() {
    return vec4(CELL_EMPTY, 0.0, 0.0, 0.0);
}

// ============================================================================
// WALL
// Simple obstacle - immovable and not minable
// ============================================================================

vec4 createWall() {
    return vec4(CELL_WALL, 0.0, 0.0, 0.0);
}
