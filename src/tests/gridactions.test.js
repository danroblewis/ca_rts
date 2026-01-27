/**
 * GridActions Unit Tests
 * Tests for game/GridActions.js
 */

import { runTest, assert, assertApprox, logSection } from './framework.js';
import { GridActions } from '../game/GridActions.js';
import {
    CELL_EMPTY, CELL_RESOURCE, CELL_MINING_UNIT, CELL_MINING_FACTORY,
    CELL_WALL, CELL_MINING_UNIT_P2, CELL_DEMOLISH, CELL_MINING_FACTORY_P2,
    PLAYER_1, PLAYER_2,
    setUnitSelectionInG, getUnitSelectedFromG
} from '../utils/GameUtils.js';

// Helper to create a mock grid
function createMockGrid(size) {
    return new Float32Array(size * size * 4);
}

// Helper to set a cell in the grid
function setCell(data, x, y, gridSize, r, g, b, a) {
    const idx = (y * gridSize + x) * 4;
    data[idx] = r;
    data[idx + 1] = g;
    data[idx + 2] = b;
    data[idx + 3] = a;
}

// Helper to get a cell from the grid
function getCell(data, x, y, gridSize) {
    const idx = (y * gridSize + x) * 4;
    return {
        r: data[idx],
        g: data[idx + 1],
        b: data[idx + 2],
        a: data[idx + 3]
    };
}

export async function runGridActionsTests() {
    const GRID_SIZE = 64; // Small grid for testing
    
    logSection('GridActions - Unit Type Helpers');
    
    await runTest('getUnitType returns correct type for each player', async () => {
        const actions = new GridActions(GRID_SIZE);
        
        assert(actions.getUnitType(PLAYER_1) === CELL_MINING_UNIT, 'P1 should get CELL_MINING_UNIT');
        assert(actions.getUnitType(PLAYER_2) === CELL_MINING_UNIT_P2, 'P2 should get CELL_MINING_UNIT_P2');
    });
    
    await runTest('getFactoryType returns correct type for each player', async () => {
        const actions = new GridActions(GRID_SIZE);
        
        assert(actions.getFactoryType(PLAYER_1) === CELL_MINING_FACTORY, 'P1 should get CELL_MINING_FACTORY');
        assert(actions.getFactoryType(PLAYER_2) === CELL_MINING_FACTORY_P2, 'P2 should get CELL_MINING_FACTORY_P2');
    });
    
    logSection('GridActions - Mark Units In Region');
    
    await runTest('markUnitsInRegion marks units within region', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        // Place some P1 units
        setCell(data, 10, 10, GRID_SIZE, CELL_MINING_UNIT, 0, 0, 0);
        setCell(data, 11, 10, GRID_SIZE, CELL_MINING_UNIT, 0, 0, 0);
        setCell(data, 10, 11, GRID_SIZE, CELL_MINING_UNIT, 0, 0, 0);
        // Place a P2 unit (should not be marked)
        setCell(data, 12, 12, GRID_SIZE, CELL_MINING_UNIT_P2, 0, 0, 0);
        
        const region = { x1: 9, y1: 9, x2: 12, y2: 12 };
        const marked = actions.markUnitsInRegion(data, region, PLAYER_1);
        
        assert(marked === 3, `Should mark 3 P1 units, got ${marked}`);
        
        // Verify units are marked
        const cell1 = getCell(data, 10, 10, GRID_SIZE);
        assert(getUnitSelectedFromG(cell1.g) === true, 'Unit at (10,10) should be selected');
        
        // Verify P2 unit is not marked
        const cell2 = getCell(data, 12, 12, GRID_SIZE);
        assert(getUnitSelectedFromG(cell2.g) === false, 'P2 unit should not be selected');
    });
    
    await runTest('markUnitsInRegion handles empty region', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        const region = { x1: 0, y1: 0, x2: 10, y2: 10 };
        const marked = actions.markUnitsInRegion(data, region, PLAYER_1);
        
        assert(marked === 0, 'Should mark 0 units in empty region');
    });
    
    await runTest('markUnitsInRegion clamps to grid bounds', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        // Place unit near edge
        setCell(data, 0, 0, GRID_SIZE, CELL_MINING_UNIT, 0, 0, 0);
        
        // Region extends past grid bounds
        const region = { x1: -10, y1: -10, x2: 5, y2: 5 };
        const marked = actions.markUnitsInRegion(data, region, PLAYER_1);
        
        assert(marked === 1, 'Should mark unit even with out-of-bounds region');
    });
    
    logSection('GridActions - Clear All Selections');
    
    await runTest('clearAllSelections clears selected units', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        // Place and select some units
        setCell(data, 5, 5, GRID_SIZE, CELL_MINING_UNIT, setUnitSelectionInG(0, true), 0, 0);
        setCell(data, 6, 6, GRID_SIZE, CELL_MINING_UNIT, setUnitSelectionInG(0, true), 0, 0);
        
        const cleared = actions.clearAllSelections(data, PLAYER_1);
        
        assert(cleared === 2, `Should clear 2 units, got ${cleared}`);
        
        const cell1 = getCell(data, 5, 5, GRID_SIZE);
        assert(getUnitSelectedFromG(cell1.g) === false, 'Unit should be unselected');
    });
    
    await runTest('clearAllSelections only affects correct player', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        // P1 and P2 selected units
        setCell(data, 5, 5, GRID_SIZE, CELL_MINING_UNIT, setUnitSelectionInG(0, true), 0, 0);
        setCell(data, 6, 6, GRID_SIZE, CELL_MINING_UNIT_P2, setUnitSelectionInG(0, true), 0, 0);
        
        const cleared = actions.clearAllSelections(data, PLAYER_1);
        
        assert(cleared === 1, 'Should only clear P1 unit');
        
        const cell2 = getCell(data, 6, 6, GRID_SIZE);
        assert(getUnitSelectedFromG(cell2.g) === true, 'P2 unit should still be selected');
    });
    
    logSection('GridActions - Place Factory');
    
    await runTest('placeFactory creates 3x3 pattern', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        actions.placeFactory(data, 10, 10, PLAYER_1, 50);
        
        // Check that 8 cells are factory (center is empty)
        let factoryCount = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const cell = getCell(data, 10 + dx, 10 + dy, GRID_SIZE);
                if (dx === 0 && dy === 0) {
                    assert(cell.r === CELL_EMPTY, 'Center should be empty');
                } else {
                    assert(cell.r === CELL_MINING_FACTORY, `Cell (${dx},${dy}) should be factory`);
                    factoryCount++;
                }
            }
        }
        
        assert(factoryCount === 8, 'Should have 8 factory cells');
    });
    
    await runTest('placeFactory stores center coordinates', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        actions.placeFactory(data, 20, 25, PLAYER_1, 0);
        
        // Check a non-center cell for center coordinates
        const cell = getCell(data, 19, 24, GRID_SIZE);
        assert(cell.b === 20, 'B channel should store center X');
        assert(cell.a === 25, 'A channel should store center Y');
    });
    
    await runTest('placeFactory distributes resources evenly', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        const totalResources = 80;
        actions.placeFactory(data, 15, 15, PLAYER_1, totalResources);
        
        const expectedPerCell = totalResources / 8;
        
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                
                const cell = getCell(data, 15 + dx, 15 + dy, GRID_SIZE);
                assertApprox(cell.g, expectedPerCell, 0.01, `Resource at (${dx},${dy})`);
            }
        }
    });
    
    await runTest('placeFactory uses correct type for P2', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        actions.placeFactory(data, 30, 30, PLAYER_2, 0);
        
        const cell = getCell(data, 29, 29, GRID_SIZE);
        assert(cell.r === CELL_MINING_FACTORY_P2, 'P2 factory should use CELL_MINING_FACTORY_P2');
    });
    
    logSection('GridActions - Demolish Factories');
    
    await runTest('demolishFactories marks factories for demolition', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        // Place a factory
        actions.placeFactory(data, 20, 20, PLAYER_1, 50);
        
        // Demolish it
        const result = actions.demolishFactories(data, 20, 20, 5, PLAYER_1);
        
        assert(result.factoriesAffected.size > 0, 'Should affect at least one factory');
        assert(result.markedCount > 0 || result.deletedCount > 0, 'Should mark or delete cells');
    });
    
    await runTest('demolishFactories only affects own factories', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        // Place P1 and P2 factories
        actions.placeFactory(data, 10, 10, PLAYER_1, 50);
        actions.placeFactory(data, 30, 30, PLAYER_2, 50);
        
        // P1 tries to demolish P2's factory
        const result = actions.demolishFactories(data, 30, 30, 5, PLAYER_1);
        
        assert(result.factoriesAffected.size === 0, 'P1 should not affect P2 factory');
        assert(result.markedCount === 0 && result.deletedCount === 0, 'Should not demolish anything');
        
        // Verify P2 factory is intact
        const cell = getCell(data, 29, 29, GRID_SIZE);
        assert(cell.r === CELL_MINING_FACTORY_P2, 'P2 factory should still exist');
    });
    
    logSection('GridActions - Count Factories');
    
    await runTest('countFactories counts factories per player', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        // Place factories
        actions.placeFactory(data, 10, 10, PLAYER_1, 0);
        actions.placeFactory(data, 20, 10, PLAYER_1, 0);
        actions.placeFactory(data, 30, 30, PLAYER_2, 0);
        
        const counts = actions.countFactories(data);
        
        assert(counts[PLAYER_1] === 2, `P1 should have 2 factories, got ${counts[PLAYER_1]}`);
        assert(counts[PLAYER_2] === 1, `P2 should have 1 factory, got ${counts[PLAYER_2]}`);
    });
    
    await runTest('countFactories returns 0 for empty grid', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        const counts = actions.countFactories(data);
        
        assert(counts[PLAYER_1] === 0, 'P1 should have 0 factories');
        assert(counts[PLAYER_2] === 0, 'P2 should have 0 factories');
    });
    
    logSection('GridActions - Can Place Factory');
    
    await runTest('canPlaceFactory returns true for empty area', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        assert(actions.canPlaceFactory(data, 10, 10) === true, 'Should be able to place in empty area');
    });
    
    await runTest('canPlaceFactory returns false near edge', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        assert(actions.canPlaceFactory(data, 0, 0) === false, 'Cannot place at corner');
        assert(actions.canPlaceFactory(data, 1, 1) === true, 'Can place one cell from edge');
        assert(actions.canPlaceFactory(data, GRID_SIZE - 1, GRID_SIZE - 1) === false, 'Cannot place at far corner');
    });
    
    await runTest('canPlaceFactory returns false if area blocked', async () => {
        const actions = new GridActions(GRID_SIZE);
        const data = createMockGrid(GRID_SIZE);
        
        // Place a wall
        setCell(data, 10, 10, GRID_SIZE, CELL_WALL, 0, 0, 0);
        
        assert(actions.canPlaceFactory(data, 10, 10) === false, 'Cannot place on wall');
        assert(actions.canPlaceFactory(data, 11, 11) === false, 'Cannot place adjacent to wall (overlaps)');
        assert(actions.canPlaceFactory(data, 12, 12) === true, 'Can place far from wall');
    });
}

