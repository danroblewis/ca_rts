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
const float CELL_MINING_UNIT = 2.0;       // Player 1 unit
const float CELL_MINING_FACTORY = 3.0;    // Player 1 factory (built or unbuilt)
const float CELL_WALL = 4.0;
const float CELL_MINING_UNIT_P2 = 5.0;    // Player 2 unit
const float CELL_DEMOLISH = 6.0;
const float CELL_MINING_FACTORY_P2 = 7.0; // Player 2 factory (built or unbuilt)
const float CELL_MISSILE = 8.0;           // Player 1 missile
const float CELL_MISSILE_P2 = 9.0;        // Player 2 missile

// Player constants
const float PLAYER_1 = 1.0;
const float PLAYER_2 = 2.0;

// Factory building constants
const float MAX_BUILD_PER_CELL = 1.0;
const float BUILD_THRESHOLD = 8.0;

// ============================================================================
// Coordinate packing (for grids up to 512x512)
// Pack two 9-bit coordinates into one float
// ============================================================================

float packCoords(vec2 pos) {
    return floor(pos.x) + floor(pos.y) * 512.0;
}

vec2 unpackCoords(float packed) {
    return vec2(mod(packed, 512.0), floor(packed / 512.0));
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
    float t = getCellType(cell);
    return t == CELL_MINING_UNIT || t == CELL_MINING_UNIT_P2;
}

bool isMiningFactory(vec4 cell) {
    float t = getCellType(cell);
    return t == CELL_MINING_FACTORY || t == CELL_MINING_FACTORY_P2;
}

// Get player ID from cell (1 or 2, 0 for non-owned)
float getPlayerFromCell(vec4 cell) {
    float t = getCellType(cell);
    if (t == CELL_MINING_UNIT || t == CELL_MINING_FACTORY || t == CELL_MISSILE) return PLAYER_1;
    if (t == CELL_MINING_UNIT_P2 || t == CELL_MINING_FACTORY_P2 || t == CELL_MISSILE_P2) return PLAYER_2;
    return 0.0;
}

// Check if cell belongs to player 1
bool isPlayer1(vec4 cell) {
    float t = getCellType(cell);
    return t == CELL_MINING_UNIT || t == CELL_MINING_FACTORY || t == CELL_MISSILE;
}

// Check if cell belongs to player 2
bool isPlayer2(vec4 cell) {
    float t = getCellType(cell);
    return t == CELL_MINING_UNIT_P2 || t == CELL_MINING_FACTORY_P2 || t == CELL_MISSILE_P2;
}

// Check if cell is a missile (any player)
bool isMissileCell(vec4 cell) {
    float t = getCellType(cell);
    return t == CELL_MISSILE || t == CELL_MISSILE_P2;
}

// Missile states (must be before getMissileState)
const float MISSILE_BUILDING = 0.0;    // Being built by units
const float MISSILE_ARMED = 1.0;       // Fully built, waiting for destination
const float MISSILE_MOVING = 2.0;      // Has destination, moving toward it
const float MISSILE_EXPLODING = 3.0;   // At destination, exploding

// Get missile state (BUILDING, ARMED, MOVING, EXPLODING)
float getMissileState(vec4 cell) {
    return mod(floor(cell.g / 16.0), 4.0);  // bits 4-5
}

// Missile selection bit (at position 10, value 1024)
const float MISSILE_SELECTED_PACK_BASE = 1024.0;

// Get missile selected state
bool getMissileSelected(vec4 cell) {
    return mod(floor(cell.g / MISSILE_SELECTED_PACK_BASE), 2.0) > 0.5;  // bit 10
}

bool isWall(vec4 cell) {
    return getCellType(cell) == CELL_WALL;
}

// isFactoryBlueprint removed - use isFactoryUnbuilt instead

bool isDemolish(vec4 cell) {
    return getCellType(cell) == CELL_DEMOLISH;
}

// ============================================================================
// FACTORY BUILD STATUS
// For unbuilt factories: G = build progress (0-MAX_BUILD_PER_CELL per cell)
// For built factories: G = resources
// B = centerX (center of 3x3 factory)
// A = centerY
// 
// A factory is "built" when sum of G across all 8 outer cells >= BUILD_THRESHOLD
// ============================================================================

// Forward declare getFactoryPosition (needed by isFactoryUnbuilt below)
vec2 getFactoryPosition(vec4 cell) {
    return vec2(cell.b, cell.a);
}

float getFactoryBuildProgress(vec4 cell) {
    return cell.g;
}

// Sum build progress / resources across 3x3 factory grid
float sumFactoryBuildProgress(vec2 centerPos, sampler2D state, vec2 resolution) {
    float total = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            vec2 cellPos = centerPos + vec2(float(dx), float(dy));
            vec4 cellRaw = texture(state, (cellPos + 0.5) / resolution);
            if (isMiningFactory(cellRaw)) {
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

// Check if a factory cell is unbuilt (for rendering purposes)
bool isFactoryUnbuilt(vec4 cell, sampler2D state, vec2 resolution) {
    if (!isMiningFactory(cell)) return false;
    vec2 center = getFactoryPosition(cell);
    return !isFactoryBuilt(center, state, resolution);
}

// ============================================================================
// DEMOLISH (marked for destruction)
// B = centerX, A = centerY
// ============================================================================

vec2 getDemolishCenter(vec4 cell) {
    return vec2(cell.b, cell.a);
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
// G = packed: holding (bit 0) + stationary_counter * 2 + age * 32
//     holding: 0 = empty, 1 = carrying resource
//     stationary_counter: how long stuck (0-15)
//     age: hunger/starvation counter (increments when empty-handed)
// B = packed factory location (x + y * 256)
// A = packed: resource location + freshness * 65536, or -1 if none
//     location: x + y * 256 (0-65535)
//     freshness: how fresh the memory is (decrements each step, 0 = expired)
// ============================================================================

// Threshold: after this many steps stuck, start walking
const float STATIONARY_THRESHOLD = 8.0;

// G channel bit packing: holding (bit 0) + counter*2 (bits 1-4) + selected*32 (bit 5) + age*64 (bits 6+)
const float SELECTED_PACK_BASE = 32.0;  // Selection flag at bit 5
const float AGE_PACK_BASE = 64.0;       // Age starts at bit 6 (after selection bit)
const float MAX_AGE = 500.0;            // Steps before unit dies from starvation
const float NEWBORN_AGE = -30.0;        // Starting age for newly spawned units (negative = newborn glow)

// Memory freshness settings
const float MEMORY_MAX_FRESHNESS = 30.0;  // Starts at this when mining
const float MEMORY_SHARE_PENALTY = 5.0;   // Lose this much freshness when shared
const float COORD_PACK_SIZE = 262144.0;   // 512 * 512 for coord packing

// Unpack G channel
float getHoldingBit(vec4 cell) {
    return mod(floor(cell.g), 2.0);
}

float getStationaryCounter(vec4 cell) {
    return mod(floor(cell.g / 2.0), 16.0);  // 4 bits for counter (0-15)
}

bool getUnitSelected(vec4 cell) {
    return mod(floor(cell.g / SELECTED_PACK_BASE), 2.0) > 0.5;  // bit 5
}

float getUnitAge(vec4 cell) {
    return floor(cell.g / AGE_PACK_BASE);  // bits 6+
}

// Pack holding + counter + selected + age into G
float packHoldingCounterSelectedAge(float holding, float counter, float selected, float age) {
    return floor(holding) + floor(counter) * 2.0 + floor(selected) * SELECTED_PACK_BASE + floor(age) * AGE_PACK_BASE;
}

// Legacy: Pack holding + counter + age (no selection)
float packHoldingCounterAge(float holding, float counter, float age) {
    return packHoldingCounterSelectedAge(holding, counter, 0.0, age);
}

// Legacy function for backward compatibility
float packHoldingAndCounter(float holding, float counter) {
    return packHoldingCounterAge(holding, counter, 0.0);
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

// getFactoryPosition is defined earlier (needed by isFactoryUnbuilt)

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

// ============================================================================
// MISSILE (additional helper functions)
// R = CELL_MISSILE or CELL_MISSILE_P2
// G = buildProgress (bits 0-3) + state*16 (bits 4-5) + explosionTimer*64 (bits 6+)
// B = packed destination coords (or -1 if no destination)
// A = packed center coords
// ============================================================================

// Get missile build progress (0-8)
float getMissileBuildProgress(vec4 cell) {
    return mod(floor(cell.g), 16.0);  // bits 0-3
}

// Get missile explosion timer (0-10)
float getMissileExplosionTimer(vec4 cell) {
    return floor(cell.g / 64.0);  // bits 6+
}

// Get missile destination
vec2 getMissileDestination(vec4 cell) {
    return unpackCoords(cell.b);
}

// Get missile center position
vec2 getMissileCenter(vec4 cell) {
    return unpackCoords(cell.a);
}
