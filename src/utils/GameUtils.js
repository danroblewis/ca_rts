/**
 * GameUtils.js - Pure utility functions for the game
 * 
 * These functions have no side effects and don't depend on global state.
 * They can be easily unit tested.
 */

// ============================================================================
// Encoding Constants (must match GLSL)
// ============================================================================

export const COORD_PACK_BASE = 512.0;
export const MEMORY_PACK_BASE = 262144.0;
export const SELECTED_PACK_BASE = 32.0;  // Selection bit at position 5 in G channel
export const AGE_PACK_BASE = 64.0;       // Age starts at bit 6 (after selection bit)
export const COMMAND_FRESHNESS = 100.0;  // High freshness so command is prioritized

// ============================================================================
// Cell Type Constants
// ============================================================================

export const CELL_EMPTY = 0;
export const CELL_RESOURCE = 1;
export const CELL_MINING_UNIT = 2;       // Player 1 unit
export const CELL_MINING_FACTORY = 3;    // Player 1 factory (built or unbuilt)
export const CELL_WALL = 4;
export const CELL_MINING_UNIT_P2 = 5;    // Player 2 unit
export const CELL_DEMOLISH = 6;
export const CELL_MINING_FACTORY_P2 = 7; // Player 2 factory (built or unbuilt)

// ============================================================================
// Player Constants
// ============================================================================

export const PLAYER_1 = 1;
export const PLAYER_2 = 2;

// ============================================================================
// Seeded Random Number Generator
// ============================================================================

/**
 * Creates a seeded random number generator using mulberry32 algorithm.
 * Deterministic - same seed always produces same sequence.
 * 
 * @param {number} seed - The seed value
 * @returns {function} A function that returns random numbers between 0 and 1
 */
export function createSeededRandom(seed) {
    return function() {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// ============================================================================
// Coordinate Packing/Unpacking
// ============================================================================

/**
 * Pack two coordinates into a single number (matches GLSL encoding).
 * 
 * @param {number} x - X coordinate (0-511)
 * @param {number} y - Y coordinate (0-511)
 * @returns {number} Packed coordinate, or -1 if invalid
 */
export function packCoords(x, y) {
    if (x < 0 || y < 0) return -1;
    return Math.floor(x) + Math.floor(y) * COORD_PACK_BASE;
}

/**
 * Unpack a packed coordinate back to x, y.
 * 
 * @param {number} packed - The packed coordinate
 * @returns {{x: number, y: number}} The unpacked coordinates
 */
export function unpackCoords(packed) {
    if (packed < 0) return { x: -1, y: -1 };
    const x = Math.floor(packed) % COORD_PACK_BASE;
    const y = Math.floor(packed / COORD_PACK_BASE);
    return { x, y };
}

// ============================================================================
// Unit G-Channel Encoding (selection, holding, counter, age)
// ============================================================================

/**
 * Get the selection bit from a unit's G channel.
 * 
 * @param {number} g - The G channel value
 * @returns {boolean} True if unit is selected
 */
export function getUnitSelectedFromG(g) {
    return Math.floor(g / SELECTED_PACK_BASE) % 2 >= 0.5;
}

/**
 * Set the selection bit in a unit's G channel.
 * Preserves holding, counter, and age values.
 * 
 * @param {number} g - The G channel value
 * @param {boolean} selected - Whether to set or clear the selection bit
 * @returns {number} The modified G channel value
 */
export function setUnitSelectionInG(g, selected) {
    const holding = Math.floor(g) % 2;
    const counter = Math.floor(g / 2) % 16;
    const age = Math.floor(g / AGE_PACK_BASE);
    return holding + counter * 2 + (selected ? SELECTED_PACK_BASE : 0) + age * AGE_PACK_BASE;
}

/**
 * Decode all fields from a unit's G channel.
 * 
 * @param {number} g - The G channel value
 * @returns {{holding: boolean, counter: number, selected: boolean, age: number}}
 */
export function decodeUnitG(g) {
    return {
        holding: Math.floor(g) % 2 === 1,
        counter: Math.floor(g / 2) % 16,
        selected: Math.floor(g / SELECTED_PACK_BASE) % 2 >= 0.5,
        age: Math.floor(g / AGE_PACK_BASE)
    };
}

/**
 * Encode all fields into a unit's G channel.
 * 
 * @param {boolean} holding - Whether unit is holding resources
 * @param {number} counter - Stationary counter (0-15)
 * @param {boolean} selected - Whether unit is selected
 * @param {number} age - Unit age
 * @returns {number} The encoded G channel value
 */
export function encodeUnitG(holding, counter, selected, age) {
    return (holding ? 1 : 0) + 
           counter * 2 + 
           (selected ? SELECTED_PACK_BASE : 0) + 
           age * AGE_PACK_BASE;
}

// ============================================================================
// Time/Duration Formatting
// ============================================================================

/**
 * Format seconds to human-readable duration.
 * 
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted string like "5s", "3m", "1h 30m"
 */
export function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Format milliseconds to human-readable duration.
 * 
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted string
 */
export function formatMs(ms) {
    if (ms < 1) return '<1ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

// ============================================================================
// Grid Cell Helpers
// ============================================================================

/**
 * Calculate the index into a flat grid array for a given coordinate.
 * 
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} gridSize - Grid width (assumes square grid)
 * @returns {number} Index into the RGBA array (multiply by 4 for Float32Array)
 */
export function getGridIndex(x, y, gridSize) {
    return (y * gridSize + x) * 4;
}

/**
 * Check if coordinates are within grid bounds.
 * 
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} gridSize - Grid size
 * @returns {boolean} True if coordinates are valid
 */
export function isInBounds(x, y, gridSize) {
    return x >= 0 && x < gridSize && y >= 0 && y < gridSize;
}

/**
 * Get the unit type for a given player.
 * 
 * @param {number} player - Player number (1 or 2)
 * @returns {number} Cell type constant for that player's units
 */
export function getUnitTypeForPlayer(player) {
    return player === PLAYER_2 ? CELL_MINING_UNIT_P2 : CELL_MINING_UNIT;
}

/**
 * Get the factory type for a given player.
 * 
 * @param {number} player - Player number (1 or 2)
 * @returns {number} Cell type constant for that player's factories
 */
export function getFactoryTypeForPlayer(player) {
    return player === PLAYER_2 ? CELL_MINING_FACTORY_P2 : CELL_MINING_FACTORY;
}

/**
 * Check if a cell type belongs to a specific player.
 * 
 * @param {number} cellType - The cell type
 * @param {number} player - Player number (1 or 2)
 * @returns {boolean} True if the cell belongs to that player
 */
export function isCellOwnedByPlayer(cellType, player) {
    if (player === PLAYER_1) {
        return cellType === CELL_MINING_UNIT || cellType === CELL_MINING_FACTORY;
    } else {
        return cellType === CELL_MINING_UNIT_P2 || cellType === CELL_MINING_FACTORY_P2;
    }
}

// ============================================================================
// Geometry Helpers
// ============================================================================

/**
 * Calculate distance between two points.
 * 
 * @param {number} x1 - First point X
 * @param {number} y1 - First point Y
 * @param {number} x2 - Second point X
 * @param {number} y2 - Second point Y
 * @returns {number} Euclidean distance
 */
export function distance(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Clamp a value between min and max.
 * 
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Clamped value
 */
export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Normalize a region to ensure x1 <= x2 and y1 <= y2.
 * 
 * @param {{x1: number, y1: number, x2: number, y2: number}} region - The region
 * @returns {{x1: number, y1: number, x2: number, y2: number}} Normalized region
 */
export function normalizeRegion(region) {
    return {
        x1: Math.min(region.x1, region.x2),
        y1: Math.min(region.y1, region.y2),
        x2: Math.max(region.x1, region.x2),
        y2: Math.max(region.y1, region.y2)
    };
}

