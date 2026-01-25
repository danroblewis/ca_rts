/**
 * Cell Type Constants (must match GLSL definitions in cell_types.glsl)
 * 
 * Note: CELL_MINING_FACTORY is used for both built and unbuilt factories.
 * The "built" status is determined by checking if the sum of G values
 * across the 3x3 factory grid >= BUILD_THRESHOLD (8).
 */

export const CELL_EMPTY = 0;
export const CELL_RESOURCE = 1;
export const CELL_MINING_UNIT = 2;
export const CELL_MINING_FACTORY = 3;  // Both built and unbuilt
export const CELL_WALL = 4;
// Type 5 is unused (was CELL_FACTORY_BLUEPRINT, now unified into CELL_MINING_FACTORY)
export const CELL_DEMOLISH = 6;

// Factory building constants
export const MAX_BUILD_PER_CELL = 1.0;
export const BUILD_THRESHOLD = 8.0;
