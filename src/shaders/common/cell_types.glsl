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
const float CELL_UNIT = 2.0;
const float CELL_OBSTACLE = 3.0;

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

bool isUnit(vec4 cell) {
    return getCellType(cell) == CELL_UNIT;
}

bool isObstacle(vec4 cell) {
    return getCellType(cell) == CELL_OBSTACLE;
}

// Unit data accessors (when cell is a unit)
// G = direction X, B = direction Y, A = team
vec2 getUnitDirection(vec4 cell) {
    return vec2(cell.g, cell.b);
}

float getUnitTeam(vec4 cell) {
    return cell.a;
}

// Resource data (when cell is a resource)
// G = amount
float getResourceAmount(vec4 cell) {
    return cell.g;
}

// Create cells
vec4 createEmpty() {
    return vec4(CELL_EMPTY, 0.0, 0.0, 0.0);
}

vec4 createResource(float amount) {
    return vec4(CELL_RESOURCE, amount, 0.0, 0.0);
}

vec4 createUnit(float dirX, float dirY, float team) {
    return vec4(CELL_UNIT, dirX, dirY, team);
}

vec4 createObstacle() {
    return vec4(CELL_OBSTACLE, 0.0, 0.0, 0.0);
}
