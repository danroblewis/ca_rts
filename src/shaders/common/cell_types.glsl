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

// Get cell type from cell data
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

// === RESOURCE ===
// G = amount (unused for now)

float getResourceAmount(vec4 cell) {
    return cell.g;
}

vec4 createResource(float amount) {
    return vec4(CELL_RESOURCE, amount, 0.0, 0.0);
}

// === MINING UNIT ===
// G = holding (0 = empty, 1 = carrying resource)
// B = factory X coordinate
// A = factory Y coordinate

bool isHoldingResource(vec4 cell) {
    return cell.g > 0.5;
}

vec2 getFactoryLocation(vec4 cell) {
    return vec2(cell.b, cell.a);
}

vec4 createMiningUnit(float holding, float factoryX, float factoryY) {
    return vec4(CELL_MINING_UNIT, holding, factoryX, factoryY);
}

// === MINING FACTORY ===
// G = resource count
// B = self X coordinate
// A = self Y coordinate

float getFactoryResourceCount(vec4 cell) {
    return cell.g;
}

vec2 getFactoryPosition(vec4 cell) {
    return vec2(cell.b, cell.a);
}

vec4 createMiningFactory(float resourceCount, float selfX, float selfY) {
    return vec4(CELL_MINING_FACTORY, resourceCount, selfX, selfY);
}

// === EMPTY ===

vec4 createEmpty() {
    return vec4(CELL_EMPTY, 0.0, 0.0, 0.0);
}
