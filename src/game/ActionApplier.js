// src/game/ActionApplier.js
// Applies game actions to grid state (place_factory, demolish, unit_command, etc.)

import {
    CELL_EMPTY, CELL_DEMOLISH,
    CELL_MINING_UNIT, CELL_MINING_UNIT_P2,
    CELL_MINING_FACTORY, CELL_MINING_FACTORY_P2,
    CELL_MISSILE, CELL_MISSILE_P2,
    MISSILE_ARMED,
    PLAYER_1, PLAYER_2,
    MEMORY_PACK_BASE, COMMAND_FRESHNESS,
    packCoords, getUnitSelectedFromG, setUnitSelectionInG,
    isMissile, getMissileTypeForPlayer, getMissileStateFromG,
    getMissileSelectedFromG, setMissileSelectionInG
} from '../utils/GameUtils.js';

/**
 * ActionApplier - Applies game actions to grid data.
 * 
 * This class is pure: it operates on Float32Array data directly,
 * without accessing DOM or global state. State changes are reported
 * via the onStateChange callback.
 */
export class ActionApplier {
    /**
     * @param {Object} options
     * @param {number} options.gridSize - Size of the grid (e.g., 512)
     * @param {number} options.deleteRadius - Radius for demolish action (default: 2)
     * @param {number} options.firstFactoryResources - Resources for first factory (default: 80)
     * @param {Function} options.onStateChange - Callback for state changes: (changes) => void
     *        changes: { factoryPlaced?: { player, isFirst }, factoriesFreed?: { [player]: count } }
     */
    constructor(options) {
        this.gridSize = options.gridSize;
        this.deleteRadius = options.deleteRadius ?? 2;
        this.firstFactoryResources = options.firstFactoryResources ?? 80;
        this.onStateChange = options.onStateChange || (() => {});
    }
    
    /**
     * Get the unit cell type for a player.
     */
    getUnitType(playerId) {
        return playerId === PLAYER_2 ? CELL_MINING_UNIT_P2 : CELL_MINING_UNIT;
    }
    
    /**
     * Get the factory cell type for a player.
     */
    getFactoryType(playerId) {
        return playerId === PLAYER_2 ? CELL_MINING_FACTORY_P2 : CELL_MINING_FACTORY;
    }
    
    /**
     * Get the missile cell type for a player.
     */
    getMissileType(playerId) {
        return playerId === PLAYER_2 ? CELL_MISSILE_P2 : CELL_MISSILE;
    }
    
    /**
     * Apply an action to grid data.
     * 
     * @param {Float32Array} data - The grid data (modified in place)
     * @param {Object} action - The action to apply
     * @param {number} playerId - The player who performed the action
     * @returns {boolean} True if data was modified
     */
    applyAction(data, action, playerId) {
        switch (action.type) {
            case 'place_factory':
                return this.applyPlaceFactory(data, action, playerId);
            case 'demolish':
                return this.applyDemolish(data, action, playerId);
            case 'unit_command':
                return this.applyUnitCommand(data, action, playerId);
            case 'unit_selection':
                return this.applyUnitSelection(data, action, playerId);
            case 'clear_selection':
                return this.applyClearSelection(data, action, playerId);
            default:
                console.warn(`[ActionApplier] Unknown action type: ${action.type}`);
                return false;
        }
    }
    
    /**
     * Apply place_factory action.
     */
    applyPlaceFactory(data, action, playerId) {
        const { x, y, isUnbuilt } = action;
        const factoryType = this.getFactoryType(playerId);
        const gridSize = this.gridSize;
        
        // First factory gets resources (to spawn initial unit), subsequent are unbuilt
        const totalResources = isUnbuilt ? 0 : this.firstFactoryResources;
        const resourcesPerCell = totalResources / 8.0;  // 8 cells (center is empty)
        
        // Write the 3x3 factory pattern
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const fx = x + dx;
                const fy = y + dy;
                if (fx < 0 || fx >= gridSize || fy < 0 || fy >= gridSize) continue;
                
                const idx = (fy * gridSize + fx) * 4;
                const isCenter = dx === 0 && dy === 0;
                
                if (isCenter) {
                    // Center is empty
                    data[idx] = 0;
                    data[idx + 1] = 0;
                    data[idx + 2] = 0;
                    data[idx + 3] = 0;
                } else {
                    // Factory cell: type, resources, centerX, centerY
                    data[idx] = factoryType;
                    data[idx + 1] = resourcesPerCell;
                    data[idx + 2] = x;  // Center X (B channel)
                    data[idx + 3] = y;  // Center Y (A channel)
                }
            }
        }
        
        // Notify about state change
        this.onStateChange({
            factoryPlaced: {
                player: playerId,
                isFirst: !isUnbuilt,
                x,
                y
            }
        });
        
        console.log(`[ActionApplier] place_factory at (${x}, ${y}) for P${playerId}, isUnbuilt: ${isUnbuilt}`);
        return true;
    }
    
    /**
     * Apply demolish action.
     */
    applyDemolish(data, action, playerId) {
        const { x: centerX, y: centerY, factoriesFreed } = action;
        const factoryType = this.getFactoryType(playerId);
        const gridSize = this.gridSize;
        const deleteRadius = this.deleteRadius;
        
        let markedCount = 0;
        let deletedCount = 0;
        const factoriesAffected = new Set();
        
        for (let dy = -deleteRadius; dy <= deleteRadius; dy++) {
            for (let dx = -deleteRadius; dx <= deleteRadius; dx++) {
                const x = centerX + dx;
                const y = centerY + dy;
                
                if (x < 0 || x >= gridSize || y < 0 || y >= gridSize) continue;
                
                const idx = (y * gridSize + x) * 4;
                const cellType = Math.floor(data[idx] + 0.5);
                const buildCount = data[idx + 1];
                
                // Only demolish factories owned by the player who sent the action
                if (cellType === factoryType) {
                    const factoryCenterX = data[idx + 2];
                    const factoryCenterY = data[idx + 3];
                    
                    // Track this factory
                    factoriesAffected.add(`${playerId},${factoryCenterX},${factoryCenterY}`);
                    
                    if (buildCount > 0) {
                        // Has resources or build progress: mark for demolition
                        data[idx + 0] = CELL_DEMOLISH;
                        data[idx + 1] = 0;
                        data[idx + 2] = factoryCenterX;
                        data[idx + 3] = factoryCenterY;
                        markedCount++;
                    } else {
                        // Unbuilt factory cell with 0 progress: delete immediately
                        data[idx + 0] = CELL_EMPTY;
                        data[idx + 1] = 0;
                        data[idx + 2] = 0;
                        data[idx + 3] = 0;
                        deletedCount++;
                    }
                }
            }
        }
        
        if (markedCount > 0 || deletedCount > 0) {
            // Notify about state change if factories were freed
            if (factoriesFreed) {
                this.onStateChange({ factoriesFreed });
            }
            
            console.log(`[ActionApplier] demolish at (${centerX}, ${centerY}): marked ${markedCount}, deleted ${deletedCount}`);
            return true;
        }
        
        return false;
    }
    
    /**
     * Apply unit_command action.
     * This also handles missile targeting for ARMED missiles.
     */
    applyUnitCommand(data, action, playerId) {
        const { destX, destY } = action;
        const unitType = this.getUnitType(playerId);
        const missileType = this.getMissileType(playerId);
        const gridSize = this.gridSize;
        
        let unitsCommanded = 0;
        let missilesLaunched = 0;
        
        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                const idx = (y * gridSize + x) * 4;
                const cellType = Math.floor(data[idx] + 0.5);
                
                // Check if this is our unit and selected
                if (cellType === unitType && getUnitSelectedFromG(data[idx + 1])) {
                    // Update B channel with new factory position
                    const newFactoryPos = packCoords(destX, destY);
                    data[idx + 2] = newFactoryPos;
                    
                    // Update A channel with new memory (destination + high freshness)
                    const newMemory = packCoords(destX, destY) + COMMAND_FRESHNESS * MEMORY_PACK_BASE;
                    data[idx + 3] = newMemory;
                    
                    unitsCommanded++;
                }
                
                // Check if this is our ARMED missile and selected
                if (cellType === missileType && getMissileSelectedFromG(data[idx + 1])) {
                    const missileState = getMissileStateFromG(data[idx + 1]);
                    
                    // Only ARMED missiles can receive destinations (one-time only)
                    if (missileState === MISSILE_ARMED) {
                        // Set destination in B channel
                        const destPacked = packCoords(destX, destY);
                        data[idx + 2] = destPacked;
                        
                        // Update G channel: change state from ARMED to MOVING (add 16 for state increment)
                        // Also clear selection
                        // Current G: buildProgress + state*16 + explosionTimer*64 + selected*1024
                        // New G: buildProgress + (state+1)*16 + 0 (moving state, no selection)
                        const buildProgress = data[idx + 1] % 16;
                        const newState = 2;  // MISSILE_MOVING
                        data[idx + 1] = buildProgress + newState * 16;  // No selection bit
                        
                        missilesLaunched++;
                    }
                }
            }
        }
        
        if (unitsCommanded > 0 || missilesLaunched > 0) {
            console.log(`[ActionApplier] unit_command to ${unitsCommanded} units, ${missilesLaunched} missiles launched, target (${destX}, ${destY})`);
            return true;
        }
        
        return false;
    }
    
    /**
     * Apply unit_selection action.
     * This also selects ARMED missiles in the region.
     */
    applyUnitSelection(data, action, playerId) {
        const { region } = action;
        const unitType = this.getUnitType(playerId);
        const missileType = this.getMissileType(playerId);
        const gridSize = this.gridSize;
        
        let unitsSelected = 0;
        let missilesSelected = 0;
        
        for (let y = Math.max(0, region.y1); y <= Math.min(gridSize - 1, region.y2); y++) {
            for (let x = Math.max(0, region.x1); x <= Math.min(gridSize - 1, region.x2); x++) {
                const idx = (y * gridSize + x) * 4;
                const cellType = Math.floor(data[idx] + 0.5);
                
                if (cellType === unitType) {
                    data[idx + 1] = setUnitSelectionInG(data[idx + 1], true);
                    unitsSelected++;
                }
                
                // Also select ARMED missiles
                if (cellType === missileType) {
                    const missileState = getMissileStateFromG(data[idx + 1]);
                    if (missileState === MISSILE_ARMED) {
                        data[idx + 1] = setMissileSelectionInG(data[idx + 1], true);
                        missilesSelected++;
                    }
                }
            }
        }
        
        if (unitsSelected > 0 || missilesSelected > 0) {
            console.log(`[ActionApplier] unit_selection, ${unitsSelected} units and ${missilesSelected} missiles selected`);
            return true;
        }
        
        return false;
    }
    
    /**
     * Apply clear_selection action.
     * This also clears selection from missiles.
     */
    applyClearSelection(data, action, playerId) {
        const unitType = this.getUnitType(playerId);
        const missileType = this.getMissileType(playerId);
        const gridSize = this.gridSize;
        
        let unitsCleared = 0;
        let missilesCleared = 0;
        
        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                const idx = (y * gridSize + x) * 4;
                const cellType = Math.floor(data[idx] + 0.5);
                
                if (cellType === unitType && getUnitSelectedFromG(data[idx + 1])) {
                    data[idx + 1] = setUnitSelectionInG(data[idx + 1], false);
                    unitsCleared++;
                }
                
                // Also clear missile selection
                if (cellType === missileType && getMissileSelectedFromG(data[idx + 1])) {
                    data[idx + 1] = setMissileSelectionInG(data[idx + 1], false);
                    missilesCleared++;
                }
            }
        }
        
        if (unitsCleared > 0 || missilesCleared > 0) {
            console.log(`[ActionApplier] clear_selection, ${unitsCleared} units and ${missilesCleared} missiles deselected`);
            return true;
        }
        
        return false;
    }
}

