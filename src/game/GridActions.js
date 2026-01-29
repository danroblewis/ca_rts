// src/game/GridActions.js
// Grid manipulation functions for units, factories, and selections

import {
    CELL_EMPTY, CELL_RESOURCE, CELL_MINING_UNIT, CELL_MINING_FACTORY,
    CELL_WALL, CELL_MINING_UNIT_P2, CELL_DEMOLISH, CELL_MINING_FACTORY_P2,
    CELL_MISSILE, CELL_MISSILE_P2,
    PLAYER_1, PLAYER_2,
    COORD_PACK_BASE, MEMORY_PACK_BASE, COMMAND_FRESHNESS,
    MISSILE_ARMED,
    getUnitSelectedFromG, setUnitSelectionInG, packCoords,
    getMissileStateFromG, getMissileSelectedFromG, setMissileSelectionInG
} from '../utils/GameUtils.js';

/**
 * Grid manipulation utilities for the CA RTS game.
 * These functions operate on raw grid data (Float32Array) with 4 channels per cell.
 */
export class GridActions {
    constructor(gridSize) {
        this.gridSize = gridSize;
    }

    /**
     * Get the unit type for a given player
     */
    getUnitType(player) {
        return player === PLAYER_2 ? CELL_MINING_UNIT_P2 : CELL_MINING_UNIT;
    }

    /**
     * Get the missile type for a given player
     */
    getMissileType(player) {
        return player === PLAYER_2 ? CELL_MISSILE_P2 : CELL_MISSILE;
    }

    /**
     * Get the factory type for a given player
     */
    getFactoryType(player) {
        return player === PLAYER_2 ? CELL_MINING_FACTORY_P2 : CELL_MINING_FACTORY;
    }

    /**
     * Mark units and ARMED missiles in a region as selected
     * @param {Float32Array} data - Grid data
     * @param {Object} region - {x1, y1, x2, y2}
     * @param {number} player - Player number (1 or 2)
     * @returns {number} Number of units/missiles marked
     */
    markUnitsInRegion(data, region, player) {
        const unitType = this.getUnitType(player);
        const missileType = this.getMissileType(player);
        let unitsMarked = 0;
        let missilesMarked = 0;

        for (let y = Math.max(0, region.y1); y <= Math.min(this.gridSize - 1, region.y2); y++) {
            for (let x = Math.max(0, region.x1); x <= Math.min(this.gridSize - 1, region.x2); x++) {
                const idx = (y * this.gridSize + x) * 4;
                const cellType = Math.floor(data[idx] + 0.5);

                if (cellType === unitType) {
                    data[idx + 1] = setUnitSelectionInG(data[idx + 1], true);
                    unitsMarked++;
                }
                
                // Also select ARMED missiles
                if (cellType === missileType) {
                    const missileState = getMissileStateFromG(data[idx + 1]);
                    if (missileState === MISSILE_ARMED) {
                        data[idx + 1] = setMissileSelectionInG(data[idx + 1], true);
                        missilesMarked++;
                    }
                }
            }
        }

        if (missilesMarked > 0) {
            console.log(`[GridActions] Selected ${unitsMarked} units and ${missilesMarked} missiles`);
        }

        return unitsMarked + missilesMarked;
    }

    /**
     * Clear all selections for a player's units and missiles
     * @param {Float32Array} data - Grid data
     * @param {number} player - Player number (1 or 2)
     * @returns {number} Number of units/missiles cleared
     */
    clearAllSelections(data, player) {
        const unitType = this.getUnitType(player);
        const missileType = this.getMissileType(player);
        let unitsCleared = 0;
        let missilesCleared = 0;

        for (let y = 0; y < this.gridSize; y++) {
            for (let x = 0; x < this.gridSize; x++) {
                const idx = (y * this.gridSize + x) * 4;
                const cellType = Math.floor(data[idx] + 0.5);

                if (cellType === unitType && getUnitSelectedFromG(data[idx + 1])) {
                    data[idx + 1] = setUnitSelectionInG(data[idx + 1], false);
                    unitsCleared++;
                }
                
                // Also clear missile selections
                if (cellType === missileType && getMissileSelectedFromG(data[idx + 1])) {
                    data[idx + 1] = setMissileSelectionInG(data[idx + 1], false);
                    missilesCleared++;
                }
            }
        }

        return unitsCleared + missilesCleared;
    }

    /**
     * Apply a command to selected units and missiles (set destination)
     * @param {Float32Array} data - Grid data
     * @param {number} destX - Destination X
     * @param {number} destY - Destination Y
     * @param {number} player - Player number
     * @returns {number} Number of units/missiles commanded
     */
    applyUnitCommand(data, destX, destY, player) {
        const unitType = this.getUnitType(player);
        const missileType = this.getMissileType(player);
        let unitsCommanded = 0;
        let missilesLaunched = 0;

        for (let y = 0; y < this.gridSize; y++) {
            for (let x = 0; x < this.gridSize; x++) {
                const idx = (y * this.gridSize + x) * 4;
                const cellType = Math.floor(data[idx] + 0.5);

                if (cellType === unitType && getUnitSelectedFromG(data[idx + 1])) {
                    // Update B channel with new factory position (allows units to go beyond original limit)
                    const newFactoryPos = packCoords(destX, destY);
                    data[idx + 2] = newFactoryPos;

                    // Update A channel with new memory (destination + high freshness)
                    const newMemory = packCoords(destX, destY) + COMMAND_FRESHNESS * MEMORY_PACK_BASE;
                    data[idx + 3] = newMemory;

                    unitsCommanded++;
                }
                
                // Also launch selected ARMED missiles
                if (cellType === missileType && getMissileSelectedFromG(data[idx + 1])) {
                    const missileState = getMissileStateFromG(data[idx + 1]);
                    
                    // Only ARMED missiles can receive destinations (one-time only)
                    if (missileState === MISSILE_ARMED) {
                        const oldG = data[idx + 1];
                        
                        // Set destination in B channel
                        const destPacked = packCoords(destX, destY);
                        data[idx + 2] = destPacked;
                        
                        // Update G channel: change state from ARMED (1) to MOVING (2)
                        // G = buildProgress + state*16 + explosionTimer*64 + selected*1024
                        // We need to: clear selection and change state from 1 to 2 (+16)
                        let newG = setMissileSelectionInG(oldG, false);  // Clear selection
                        newG = newG + 16;  // Increment state from ARMED(1) to MOVING(2)
                        data[idx + 1] = newG;
                        
                        console.log(`[GridActions] Launching missile cell at (${x}, ${y}), dest=${destPacked}, oldG=${oldG}, newG=${newG}`);
                        
                        missilesLaunched++;
                    }
                }
            }
        }

        if (missilesLaunched > 0) {
            console.log(`[GridActions] Commanded ${unitsCommanded} units, launched ${missilesLaunched} missiles to (${destX}, ${destY})`);
        }

        return unitsCommanded + missilesLaunched;
    }

    /**
     * Place a factory at the given position
     * @param {Float32Array} data - Grid data
     * @param {number} centerX - Center X
     * @param {number} centerY - Center Y
     * @param {number} player - Player number
     * @param {number} totalResources - Resources for first factory (0 for unbuilt)
     * @returns {boolean} Success
     */
    placeFactory(data, centerX, centerY, player, totalResources = 0) {
        const factoryType = this.getFactoryType(player);
        const resourcesPerCell = totalResources / 8.0;

        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const fx = centerX + dx;
                const fy = centerY + dy;
                
                if (fx < 0 || fx >= this.gridSize || fy < 0 || fy >= this.gridSize) continue;

                const idx = (fy * this.gridSize + fx) * 4;
                const isCenter = dx === 0 && dy === 0;

                if (isCenter) {
                    data[idx] = 0;
                    data[idx + 1] = 0;
                    data[idx + 2] = 0;
                    data[idx + 3] = 0;
                } else {
                    data[idx] = factoryType;
                    data[idx + 1] = resourcesPerCell;
                    data[idx + 2] = centerX;
                    data[idx + 3] = centerY;
                }
            }
        }

        return true;
    }

    /**
     * Demolish factories in a radius around a point
     * @param {Float32Array} data - Grid data
     * @param {number} centerX - Center X
     * @param {number} centerY - Center Y
     * @param {number} radius - Delete radius
     * @param {number} player - Player number (only demolish own factories)
     * @returns {Object} { markedCount, deletedCount, factoriesAffected: Set }
     */
    demolishFactories(data, centerX, centerY, radius, player) {
        const factoryType = this.getFactoryType(player);
        let markedCount = 0;
        let deletedCount = 0;
        const factoriesAffected = new Set();

        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = centerX + dx;
                const y = centerY + dy;

                if (x < 0 || x >= this.gridSize || y < 0 || y >= this.gridSize) continue;

                const idx = (y * this.gridSize + x) * 4;
                const cellType = Math.floor(data[idx] + 0.5);
                const buildCount = data[idx + 1];

                if (cellType === factoryType) {
                    const factoryCenterX = data[idx + 2];
                    const factoryCenterY = data[idx + 3];

                    factoriesAffected.add(`${player},${factoryCenterX},${factoryCenterY}`);

                    if (buildCount > 0) {
                        // Has resources/progress: mark for demolition
                        data[idx + 0] = CELL_DEMOLISH;
                        data[idx + 1] = 0;
                        data[idx + 2] = factoryCenterX;
                        data[idx + 3] = factoryCenterY;
                        markedCount++;
                    } else {
                        // Unbuilt with 0 progress: delete immediately
                        data[idx + 0] = CELL_EMPTY;
                        data[idx + 1] = 0;
                        data[idx + 2] = 0;
                        data[idx + 3] = 0;
                        deletedCount++;
                    }
                }
            }
        }

        return { markedCount, deletedCount, factoriesAffected };
    }

    /**
     * Count factories on the map per player
     * @param {Float32Array} data - Grid data
     * @returns {Object} { 1: count, 2: count }
     */
    countFactories(data) {
        const factoryCenters = { [PLAYER_1]: new Set(), [PLAYER_2]: new Set() };

        for (let y = 0; y < this.gridSize; y++) {
            for (let x = 0; x < this.gridSize; x++) {
                const idx = (y * this.gridSize + x) * 4;
                const cellType = Math.floor(data[idx] + 0.5);

                if (cellType === CELL_MINING_FACTORY) {
                    const centerX = data[idx + 2];
                    const centerY = data[idx + 3];
                    factoryCenters[PLAYER_1].add(`${centerX},${centerY}`);
                } else if (cellType === CELL_MINING_FACTORY_P2) {
                    const centerX = data[idx + 2];
                    const centerY = data[idx + 3];
                    factoryCenters[PLAYER_2].add(`${centerX},${centerY}`);
                }
            }
        }

        return {
            [PLAYER_1]: factoryCenters[PLAYER_1].size,
            [PLAYER_2]: factoryCenters[PLAYER_2].size
        };
    }

    /**
     * Check if a position is valid for factory placement
     * @param {Float32Array} data - Grid data
     * @param {number} centerX - Center X
     * @param {number} centerY - Center Y
     * @returns {boolean} True if valid
     */
    canPlaceFactory(data, centerX, centerY) {
        // Check bounds (need 3x3 space)
        if (centerX < 1 || centerX >= this.gridSize - 1 ||
            centerY < 1 || centerY >= this.gridSize - 1) {
            return false;
        }

        // Check all 9 cells
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const fx = centerX + dx;
                const fy = centerY + dy;
                const idx = (fy * this.gridSize + fx) * 4;
                const cellType = data[idx];

                // Can place on empty or resource cells
                if (cellType !== CELL_EMPTY && cellType !== CELL_RESOURCE) {
                    return false;
                }
            }
        }

        return true;
    }
}

