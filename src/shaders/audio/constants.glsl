/**
 * Audio Reduction Constants
 * 
 * Shared constants for the audio reduction shader pipeline.
 */

#ifndef AUDIO_CONSTANTS_GLSL
#define AUDIO_CONSTANTS_GLSL

// Cell type constants (must match main game)
const float CELL_EMPTY = 0.0;
const float CELL_RESOURCE = 1.0;
const float CELL_MINING_UNIT = 2.0;
const float CELL_MINING_FACTORY = 3.0;
const float CELL_WALL = 4.0;
const float CELL_MINING_UNIT_P2 = 5.0;
const float CELL_DEMOLISH = 6.0;
const float CELL_MINING_FACTORY_P2 = 7.0;

// Helper functions
bool isUnit(float cellType) {
    return cellType == CELL_MINING_UNIT || cellType == CELL_MINING_UNIT_P2;
}

bool isFactory(float cellType) {
    return cellType == CELL_MINING_FACTORY || cellType == CELL_MINING_FACTORY_P2;
}

bool isP1Unit(float cellType) {
    return cellType == CELL_MINING_UNIT;
}

bool isP2Unit(float cellType) {
    return cellType == CELL_MINING_UNIT_P2;
}

bool isP1Factory(float cellType) {
    return cellType == CELL_MINING_FACTORY;
}

bool isP2Factory(float cellType) {
    return cellType == CELL_MINING_FACTORY_P2;
}

int getPlayer(float cellType) {
    if (cellType == CELL_MINING_UNIT || cellType == CELL_MINING_FACTORY) return 1;
    if (cellType == CELL_MINING_UNIT_P2 || cellType == CELL_MINING_FACTORY_P2) return 2;
    return 0;
}

// Get unit holding state (bit 0 of G channel)
bool getUnitHolding(vec4 cell) {
    return mod(floor(cell.g), 2.0) > 0.5;
}

// Get factory resources
float getFactoryResources(vec4 cell) {
    return cell.g;
}

#endif

