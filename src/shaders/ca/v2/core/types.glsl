/**
 * Cell Types - Raw encoding/decoding for all cell types
 * 
 * Each cell is stored as vec4 (RGBA float):
 *   R = type ID
 *   G, B, A = type-specific data
 */

#ifndef TYPES_GLSL
#define TYPES_GLSL

// ============================================================================
// Type Constants
// ============================================================================

const int TYPE_EMPTY = 0;
const int TYPE_RESOURCE = 1;
const int TYPE_UNIT = 2;
const int TYPE_FACTORY = 3;

// ============================================================================
// Encoding Constants  
// ============================================================================

const float COORD_PACK_BASE = 128.0;
const float MEMORY_PACK_BASE = 16384.0;  // 128 * 128

// ============================================================================
// Raw Access
// ============================================================================

int getType(vec4 raw) {
    return int(floor(raw.r + 0.5));
}

// ============================================================================
// Coordinate Packing (for 128x128 grids)
// ============================================================================

float packCoords(vec2 pos) {
    return floor(pos.x) + floor(pos.y) * COORD_PACK_BASE;
}

vec2 unpackCoords(float packed) {
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
// G = holding (bit 0) + stationaryCounter * 2
// B = packed factory location
// A = packed resource memory with freshness, OR negative homesick timer
//     A >= 0: has memory (packCoords + freshness * MEMORY_PACK_BASE)
//     A < 0: no memory, homesick timer = -A - 1  (so -1 = timer 0, -2 = timer 1, etc)
// ============================================================================

bool getUnitHolding(vec4 raw) {
    return mod(floor(raw.g), 2.0) > 0.5;
}

int getUnitCounter(vec4 raw) {
    return int(floor(raw.g / 2.0));
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
vec4 encodeUnitRaw(bool holding, int counter, vec2 factoryPos, vec2 memoryPos, float freshness, float homesickTimer) {
    float g = (holding ? 1.0 : 0.0) + float(counter) * 2.0;
    float b = packCoords(factoryPos);
    float a;
    if (freshness > 0.0 && memoryPos.x >= 0.0) {
        // Has memory
        a = packCoords(memoryPos) + freshness * MEMORY_PACK_BASE;
    } else {
        // No memory - encode homesick timer as negative
        a = -(homesickTimer + 1.0);
    }
    return vec4(float(TYPE_UNIT), g, b, a);
}

vec4 encodeUnitSimple(bool holding, int counter, vec2 factoryPos) {
    return encodeUnitRaw(holding, counter, factoryPos, vec2(-1.0), 0.0, 0.0);
}

// ============================================================================
// FACTORY
// G = resource count
// B = self X
// A = self Y
// ============================================================================

float getFactoryResources(vec4 raw) {
    return raw.g;
}

vec2 getFactoryPos(vec4 raw) {
    return vec2(raw.b, raw.a);
}

vec4 encodeFactory(float resources, vec2 selfPos) {
    return vec4(float(TYPE_FACTORY), resources, selfPos.x, selfPos.y);
}

#endif
