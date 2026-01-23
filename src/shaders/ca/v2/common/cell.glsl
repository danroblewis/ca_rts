/**
 * Cell Type Definitions and Structures for v2 CA Engine
 * 
 * Key concepts:
 * - Cell struct holds all parsed cell data in a typed way
 * - Factory functions create cells with correct encoding
 * - Accessor functions read cell properties
 */

#ifndef CELL_GLSL
#define CELL_GLSL

// ============================================================================
// Cell Type Constants
// ============================================================================

const int TYPE_EMPTY = 0;
const int TYPE_RESOURCE = 1;
const int TYPE_UNIT = 2;
const int TYPE_FACTORY = 3;

// ============================================================================
// Cell Data Structure
// ============================================================================

struct Cell {
    int type;
    
    // Unit-specific
    bool holding;
    int stationaryCounter;
    vec2 factoryPos;
    vec2 resourceMemory;
    float memoryFreshness;
    
    // Factory-specific  
    float resources;
    vec2 selfPos;
    
    // Resource-specific
    float amount;
};

// ============================================================================
// Encoding Constants
// ============================================================================

const float COORD_PACK_BASE = 128.0;
const float MEMORY_PACK_BASE = 16384.0; // 128 * 128
const float STATIONARY_THRESHOLD = 8.0;
const float MEMORY_MAX_FRESHNESS = 30.0;
const float MEMORY_SHARE_PENALTY = 5.0;
const float SPAWN_COST = 10.0;
const int VISION_RANGE = 5;

// ============================================================================
// Coordinate Packing
// ============================================================================

float packCoords(vec2 pos) {
    return floor(pos.x) + floor(pos.y) * COORD_PACK_BASE;
}

vec2 unpackCoords(float packed) {
    return vec2(mod(packed, COORD_PACK_BASE), floor(packed / COORD_PACK_BASE));
}

float packMemory(vec2 pos, float freshness) {
    if (freshness <= 0.0) return -1.0;
    return packCoords(pos) + floor(freshness) * MEMORY_PACK_BASE;
}

// ============================================================================
// Parse Raw Cell Data -> Cell Struct
// ============================================================================

Cell parseCell(vec4 raw) {
    Cell c;
    c.type = int(floor(raw.r + 0.5));
    
    // Initialize all fields to defaults
    c.holding = false;
    c.stationaryCounter = 0;
    c.factoryPos = vec2(0.0);
    c.resourceMemory = vec2(-1.0);
    c.memoryFreshness = 0.0;
    c.resources = 0.0;
    c.selfPos = vec2(0.0);
    c.amount = 0.0;
    
    if (c.type == TYPE_UNIT) {
        // G = holding (bit 0) + counter * 2
        float g = raw.g;
        c.holding = mod(floor(g), 2.0) > 0.5;
        c.stationaryCounter = int(floor(g / 2.0));
        
        // B = packed factory location
        c.factoryPos = unpackCoords(raw.b);
        
        // A = packed resource memory with freshness, or -1
        if (raw.a >= 0.0) {
            float coordPart = mod(raw.a, MEMORY_PACK_BASE);
            c.resourceMemory = unpackCoords(coordPart);
            c.memoryFreshness = floor(raw.a / MEMORY_PACK_BASE);
        }
    }
    else if (c.type == TYPE_FACTORY) {
        c.resources = raw.g;
        c.selfPos = vec2(raw.b, raw.a);
    }
    else if (c.type == TYPE_RESOURCE) {
        c.amount = raw.g;
    }
    
    return c;
}

// ============================================================================
// Cell Struct -> Raw Cell Data (for output)
// ============================================================================

vec4 encodeEmpty() {
    return vec4(float(TYPE_EMPTY), 0.0, 0.0, 0.0);
}

vec4 encodeResource(float amount) {
    return vec4(float(TYPE_RESOURCE), amount, 0.0, 0.0);
}

vec4 encodeUnit(bool holding, int counter, vec2 factoryPos, vec2 resourceMem, float freshness) {
    float g = (holding ? 1.0 : 0.0) + float(counter) * 2.0;
    float b = packCoords(factoryPos);
    float a = packMemory(resourceMem, freshness);
    return vec4(float(TYPE_UNIT), g, b, a);
}

vec4 encodeUnitSimple(bool holding, int counter, vec2 factoryPos) {
    return encodeUnit(holding, counter, factoryPos, vec2(-1.0), 0.0);
}

vec4 encodeFactory(float resources, vec2 selfPos) {
    return vec4(float(TYPE_FACTORY), resources, selfPos.x, selfPos.y);
}

// ============================================================================
// Cell Type Checks
// ============================================================================

bool isEmpty(Cell c) { return c.type == TYPE_EMPTY; }
bool isResource(Cell c) { return c.type == TYPE_RESOURCE; }
bool isUnit(Cell c) { return c.type == TYPE_UNIT; }
bool isFactory(Cell c) { return c.type == TYPE_FACTORY; }

bool isWalking(Cell c) {
    return c.type == TYPE_UNIT && c.stationaryCounter >= int(STATIONARY_THRESHOLD);
}

bool hasResourceMemory(Cell c) {
    return c.type == TYPE_UNIT && c.memoryFreshness > 0.0 && c.resourceMemory.x >= 0.0;
}

#endif
