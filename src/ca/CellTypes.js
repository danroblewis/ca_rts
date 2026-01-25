/**
 * Cell Type Constants (must match GLSL definitions in constants.glsl)
 * 
 * Note: Factories are used for both built and unbuilt states.
 * The "built" status is determined by checking if the sum of G values
 * across the 3x3 factory grid >= BUILD_THRESHOLD (8).
 */

export const CELL_EMPTY = 0;
export const CELL_RESOURCE = 1;
export const CELL_MINING_UNIT = 2;       // Player 1 unit
export const CELL_MINING_FACTORY = 3;    // Player 1 factory (built or unbuilt)
export const CELL_WALL = 4;
export const CELL_MINING_UNIT_P2 = 5;    // Player 2 unit
export const CELL_DEMOLISH = 6;
export const CELL_MINING_FACTORY_P2 = 7; // Player 2 factory (built or unbuilt)

// Player constants
export const PLAYER_1 = 1;
export const PLAYER_2 = 2;

// Factory building constants
export const MAX_BUILD_PER_CELL = 1.0;
export const BUILD_THRESHOLD = 8.0;

// Helper functions
export function isUnit(cellType) {
    return cellType === CELL_MINING_UNIT || cellType === CELL_MINING_UNIT_P2;
}

export function isFactory(cellType) {
    return cellType === CELL_MINING_FACTORY || cellType === CELL_MINING_FACTORY_P2;
}

export function getPlayer(cellType) {
    if (cellType === CELL_MINING_UNIT || cellType === CELL_MINING_FACTORY) return PLAYER_1;
    if (cellType === CELL_MINING_UNIT_P2 || cellType === CELL_MINING_FACTORY_P2) return PLAYER_2;
    return 0;
}

export function getUnitTypeForPlayer(player) {
    return player === PLAYER_2 ? CELL_MINING_UNIT_P2 : CELL_MINING_UNIT;
}

export function getFactoryTypeForPlayer(player) {
    return player === PLAYER_2 ? CELL_MINING_FACTORY_P2 : CELL_MINING_FACTORY;
}
