/**
 * ActionApplier Unit Tests
 * Tests for game/ActionApplier.js
 */

import { runTest, assert, logSection } from './framework.js';
import { ActionApplier } from '../game/ActionApplier.js';
import {
    CELL_EMPTY, CELL_MINING_UNIT, CELL_MINING_UNIT_P2,
    CELL_MINING_FACTORY, CELL_MINING_FACTORY_P2, CELL_DEMOLISH,
    PLAYER_1, PLAYER_2,
    SELECTED_PACK_BASE, MEMORY_PACK_BASE, COMMAND_FRESHNESS,
    packCoords, getUnitSelectedFromG, setUnitSelectionInG
} from '../utils/GameUtils.js';

// Helper to create empty grid data
function createEmptyGrid(gridSize) {
    return new Float32Array(gridSize * gridSize * 4);
}

// Helper to get cell at position
function getCell(data, x, y, gridSize) {
    const idx = (y * gridSize + x) * 4;
    return {
        type: data[idx],
        g: data[idx + 1],
        b: data[idx + 2],
        a: data[idx + 3]
    };
}

// Helper to set cell at position
function setCell(data, x, y, gridSize, type, g = 0, b = 0, a = 0) {
    const idx = (y * gridSize + x) * 4;
    data[idx] = type;
    data[idx + 1] = g;
    data[idx + 2] = b;
    data[idx + 3] = a;
}

export async function runActionApplierTests() {
    const GRID_SIZE = 64;  // Smaller grid for tests
    
    logSection('ActionApplier - Initialization');
    
    await runTest('ActionApplier initializes with options', async () => {
        const applier = new ActionApplier({
            gridSize: 512,
            deleteRadius: 3,
            firstFactoryResources: 100
        });
        
        assert(applier.gridSize === 512, 'Grid size should be set');
        assert(applier.deleteRadius === 3, 'Delete radius should be set');
        assert(applier.firstFactoryResources === 100, 'First factory resources should be set');
    });
    
    await runTest('ActionApplier has correct default values', async () => {
        const applier = new ActionApplier({ gridSize: 512 });
        
        assert(applier.deleteRadius === 2, 'Default delete radius should be 2');
        assert(applier.firstFactoryResources === 80, 'Default first factory resources should be 80');
    });
    
    logSection('ActionApplier - Place Factory');
    
    await runTest('applyPlaceFactory creates 3x3 factory pattern', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        const result = applier.applyAction(data, { type: 'place_factory', x: 10, y: 10, isUnbuilt: false }, PLAYER_1);
        
        assert(result === true, 'Should return true for successful action');
        
        // Check center is empty
        const center = getCell(data, 10, 10, GRID_SIZE);
        assert(center.type === CELL_EMPTY, 'Center should be empty');
        
        // Check surrounding cells are factory
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const cell = getCell(data, 10 + dx, 10 + dy, GRID_SIZE);
                assert(Math.floor(cell.type) === CELL_MINING_FACTORY, `Cell at (${dx},${dy}) should be factory`);
            }
        }
    });
    
    await runTest('applyPlaceFactory uses P2 factory type for player 2', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        applier.applyAction(data, { type: 'place_factory', x: 10, y: 10, isUnbuilt: false }, PLAYER_2);
        
        const cell = getCell(data, 9, 9, GRID_SIZE);
        assert(Math.floor(cell.type) === CELL_MINING_FACTORY_P2, 'P2 factory should use P2 type');
    });
    
    await runTest('applyPlaceFactory distributes resources for first factory', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE, firstFactoryResources: 80 });
        const data = createEmptyGrid(GRID_SIZE);
        
        applier.applyAction(data, { type: 'place_factory', x: 10, y: 10, isUnbuilt: false }, PLAYER_1);
        
        // Each of 8 cells gets 80/8 = 10 resources
        const cell = getCell(data, 9, 9, GRID_SIZE);
        assert(cell.g === 10, `Each cell should have 10 resources, got ${cell.g}`);
    });
    
    await runTest('applyPlaceFactory has zero resources for unbuilt factory', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        applier.applyAction(data, { type: 'place_factory', x: 10, y: 10, isUnbuilt: true }, PLAYER_1);
        
        const cell = getCell(data, 9, 9, GRID_SIZE);
        assert(cell.g === 0, `Unbuilt factory should have 0 resources, got ${cell.g}`);
    });
    
    await runTest('applyPlaceFactory calls onStateChange', async () => {
        let stateChange = null;
        const applier = new ActionApplier({
            gridSize: GRID_SIZE,
            onStateChange: (change) => { stateChange = change; }
        });
        const data = createEmptyGrid(GRID_SIZE);
        
        applier.applyAction(data, { type: 'place_factory', x: 10, y: 10, isUnbuilt: false }, PLAYER_1);
        
        assert(stateChange !== null, 'onStateChange should be called');
        assert(stateChange.factoryPlaced.player === PLAYER_1, 'Should report correct player');
        assert(stateChange.factoryPlaced.isFirst === true, 'Should report isFirst');
    });
    
    logSection('ActionApplier - Demolish');
    
    await runTest('applyDemolish marks built factory for demolition', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        // Place a factory first
        applier.applyAction(data, { type: 'place_factory', x: 10, y: 10, isUnbuilt: false }, PLAYER_1);
        
        // Demolish it
        const result = applier.applyAction(data, { 
            type: 'demolish', 
            x: 10, 
            y: 10,
            factoriesFreed: { [PLAYER_1]: 1 }
        }, PLAYER_1);
        
        assert(result === true, 'Should return true');
        
        // Check cells are marked as demolish
        const cell = getCell(data, 9, 9, GRID_SIZE);
        assert(Math.floor(cell.type) === CELL_DEMOLISH, `Cell should be demolish type, got ${cell.type}`);
    });
    
    await runTest('applyDemolish deletes unbuilt factory immediately', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        // Place an unbuilt factory
        applier.applyAction(data, { type: 'place_factory', x: 10, y: 10, isUnbuilt: true }, PLAYER_1);
        
        // Demolish it
        applier.applyAction(data, { type: 'demolish', x: 10, y: 10 }, PLAYER_1);
        
        // Check cells are empty
        const cell = getCell(data, 9, 9, GRID_SIZE);
        assert(Math.floor(cell.type) === CELL_EMPTY, 'Unbuilt factory cell should be empty after demolish');
    });
    
    await runTest('applyDemolish only affects own factories', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        // P1 places a factory
        applier.applyAction(data, { type: 'place_factory', x: 10, y: 10, isUnbuilt: false }, PLAYER_1);
        
        // P2 tries to demolish
        const result = applier.applyAction(data, { type: 'demolish', x: 10, y: 10 }, PLAYER_2);
        
        // Factory should still be there
        const cell = getCell(data, 9, 9, GRID_SIZE);
        assert(Math.floor(cell.type) === CELL_MINING_FACTORY, 'P1 factory should not be affected by P2 demolish');
        assert(result === false, 'Should return false when nothing demolished');
    });
    
    logSection('ActionApplier - Unit Command');
    
    await runTest('applyUnitCommand sets destination for selected units', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        // Create a selected unit
        setCell(data, 5, 5, GRID_SIZE, CELL_MINING_UNIT, setUnitSelectionInG(0, true), 0, 0);
        
        // Issue command
        const result = applier.applyAction(data, { type: 'unit_command', destX: 20, destY: 20 }, PLAYER_1);
        
        assert(result === true, 'Should return true');
        
        // Check unit has new destination
        const cell = getCell(data, 5, 5, GRID_SIZE);
        const expectedMemory = packCoords(20, 20) + COMMAND_FRESHNESS * MEMORY_PACK_BASE;
        assert(cell.a === expectedMemory, `Memory should be set to destination, got ${cell.a}`);
    });
    
    await runTest('applyUnitCommand only affects selected units', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        // Create one selected and one unselected unit
        setCell(data, 5, 5, GRID_SIZE, CELL_MINING_UNIT, setUnitSelectionInG(0, true), 0, 0);
        setCell(data, 6, 6, GRID_SIZE, CELL_MINING_UNIT, 0, 0, 0);  // Not selected
        
        applier.applyAction(data, { type: 'unit_command', destX: 20, destY: 20 }, PLAYER_1);
        
        // Selected unit should have destination
        const selected = getCell(data, 5, 5, GRID_SIZE);
        assert(selected.a !== 0, 'Selected unit should have new memory');
        
        // Unselected unit should not
        const unselected = getCell(data, 6, 6, GRID_SIZE);
        assert(unselected.a === 0, 'Unselected unit should not be affected');
    });
    
    await runTest('applyUnitCommand only affects own units', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        // P2 unit that is selected
        setCell(data, 5, 5, GRID_SIZE, CELL_MINING_UNIT_P2, setUnitSelectionInG(0, true), 0, 0);
        
        // P1 issues command
        const result = applier.applyAction(data, { type: 'unit_command', destX: 20, destY: 20 }, PLAYER_1);
        
        assert(result === false, 'P1 command should not affect P2 units');
    });
    
    logSection('ActionApplier - Unit Selection');
    
    await runTest('applyUnitSelection marks units in region', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        // Create units
        setCell(data, 5, 5, GRID_SIZE, CELL_MINING_UNIT, 0, 0, 0);
        setCell(data, 6, 5, GRID_SIZE, CELL_MINING_UNIT, 0, 0, 0);
        setCell(data, 20, 20, GRID_SIZE, CELL_MINING_UNIT, 0, 0, 0);  // Outside region
        
        applier.applyAction(data, { 
            type: 'unit_selection', 
            region: { x1: 4, y1: 4, x2: 7, y2: 7 } 
        }, PLAYER_1);
        
        // Units in region should be selected
        assert(getUnitSelectedFromG(getCell(data, 5, 5, GRID_SIZE).g), 'Unit at (5,5) should be selected');
        assert(getUnitSelectedFromG(getCell(data, 6, 5, GRID_SIZE).g), 'Unit at (6,5) should be selected');
        
        // Unit outside region should not be selected
        assert(!getUnitSelectedFromG(getCell(data, 20, 20, GRID_SIZE).g), 'Unit at (20,20) should not be selected');
    });
    
    await runTest('applyUnitSelection only selects own units', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        // P1 and P2 units in same region
        setCell(data, 5, 5, GRID_SIZE, CELL_MINING_UNIT, 0, 0, 0);
        setCell(data, 6, 5, GRID_SIZE, CELL_MINING_UNIT_P2, 0, 0, 0);
        
        applier.applyAction(data, { 
            type: 'unit_selection', 
            region: { x1: 4, y1: 4, x2: 7, y2: 7 } 
        }, PLAYER_1);
        
        assert(getUnitSelectedFromG(getCell(data, 5, 5, GRID_SIZE).g), 'P1 unit should be selected');
        assert(!getUnitSelectedFromG(getCell(data, 6, 5, GRID_SIZE).g), 'P2 unit should not be selected by P1');
    });
    
    logSection('ActionApplier - Clear Selection');
    
    await runTest('applyClearSelection clears all selected units', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        // Create selected units
        setCell(data, 5, 5, GRID_SIZE, CELL_MINING_UNIT, setUnitSelectionInG(0, true), 0, 0);
        setCell(data, 6, 5, GRID_SIZE, CELL_MINING_UNIT, setUnitSelectionInG(0, true), 0, 0);
        
        const result = applier.applyAction(data, { type: 'clear_selection' }, PLAYER_1);
        
        assert(result === true, 'Should return true');
        assert(!getUnitSelectedFromG(getCell(data, 5, 5, GRID_SIZE).g), 'Unit at (5,5) should be unselected');
        assert(!getUnitSelectedFromG(getCell(data, 6, 5, GRID_SIZE).g), 'Unit at (6,5) should be unselected');
    });
    
    await runTest('applyClearSelection only affects own units', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        // P1 and P2 selected units
        setCell(data, 5, 5, GRID_SIZE, CELL_MINING_UNIT, setUnitSelectionInG(0, true), 0, 0);
        setCell(data, 6, 5, GRID_SIZE, CELL_MINING_UNIT_P2, setUnitSelectionInG(0, true), 0, 0);
        
        applier.applyAction(data, { type: 'clear_selection' }, PLAYER_1);
        
        assert(!getUnitSelectedFromG(getCell(data, 5, 5, GRID_SIZE).g), 'P1 unit should be unselected');
        assert(getUnitSelectedFromG(getCell(data, 6, 5, GRID_SIZE).g), 'P2 unit should still be selected');
    });
    
    logSection('ActionApplier - Unknown Actions');
    
    await runTest('applyAction returns false for unknown action type', async () => {
        const applier = new ActionApplier({ gridSize: GRID_SIZE });
        const data = createEmptyGrid(GRID_SIZE);
        
        const result = applier.applyAction(data, { type: 'unknown_action' }, PLAYER_1);
        
        assert(result === false, 'Should return false for unknown action');
    });
}

