/**
 * GameUtils Unit Tests
 * Tests for pure utility functions in utils/GameUtils.js
 */

import { runTest, assert, assertApprox, logSection } from './framework.js';
import {
    CELL_EMPTY, CELL_RESOURCE, CELL_MINING_UNIT, CELL_MINING_FACTORY,
    CELL_WALL, CELL_MINING_UNIT_P2, CELL_DEMOLISH, CELL_MINING_FACTORY_P2,
    PLAYER_1, PLAYER_2,
    COORD_PACK_BASE, MEMORY_PACK_BASE, SELECTED_PACK_BASE, AGE_PACK_BASE, COMMAND_FRESHNESS,
    createSeededRandom, packCoords, unpackCoords,
    getUnitSelectedFromG, setUnitSelectionInG,
    getGridIndex, isInBounds, getUnitTypeForPlayer, getFactoryTypeForPlayer,
    formatDuration, clamp, distance
} from '../utils/GameUtils.js';

export async function runGameUtilsTests() {
    logSection('GameUtils - Constants');
    
    await runTest('Cell type constants are defined correctly', async () => {
        assert(CELL_EMPTY === 0.0, `CELL_EMPTY should be 0.0, got ${CELL_EMPTY}`);
        assert(CELL_RESOURCE === 1.0, `CELL_RESOURCE should be 1.0, got ${CELL_RESOURCE}`);
        assert(CELL_MINING_UNIT === 2.0, `CELL_MINING_UNIT should be 2.0, got ${CELL_MINING_UNIT}`);
        assert(CELL_MINING_FACTORY === 3.0, `CELL_MINING_FACTORY should be 3.0, got ${CELL_MINING_FACTORY}`);
        assert(CELL_WALL === 4.0, `CELL_WALL should be 4.0, got ${CELL_WALL}`);
        assert(CELL_MINING_UNIT_P2 === 5.0, `CELL_MINING_UNIT_P2 should be 5.0, got ${CELL_MINING_UNIT_P2}`);
        assert(CELL_DEMOLISH === 6.0, `CELL_DEMOLISH should be 6.0, got ${CELL_DEMOLISH}`);
        assert(CELL_MINING_FACTORY_P2 === 7.0, `CELL_MINING_FACTORY_P2 should be 7.0, got ${CELL_MINING_FACTORY_P2}`);
    });
    
    await runTest('Player constants are defined correctly', async () => {
        assert(PLAYER_1 === 1, `PLAYER_1 should be 1, got ${PLAYER_1}`);
        assert(PLAYER_2 === 2, `PLAYER_2 should be 2, got ${PLAYER_2}`);
    });
    
    await runTest('Encoding constants are defined', async () => {
        assert(COORD_PACK_BASE === 1024, `COORD_PACK_BASE should be 1024, got ${COORD_PACK_BASE}`);
        assert(MEMORY_PACK_BASE > 0, `MEMORY_PACK_BASE should be positive`);
        assert(SELECTED_PACK_BASE > 0, `SELECTED_PACK_BASE should be positive`);
        assert(AGE_PACK_BASE > 0, `AGE_PACK_BASE should be positive`);
        assert(COMMAND_FRESHNESS > 0, `COMMAND_FRESHNESS should be positive`);
    });
    
    logSection('GameUtils - Seeded Random');
    
    await runTest('createSeededRandom produces deterministic values', async () => {
        const random1 = createSeededRandom(12345);
        const random2 = createSeededRandom(12345);
        
        const values1 = [random1(), random1(), random1(), random1(), random1()];
        const values2 = [random2(), random2(), random2(), random2(), random2()];
        
        for (let i = 0; i < values1.length; i++) {
            assert(values1[i] === values2[i], `Value ${i} should be identical: ${values1[i]} vs ${values2[i]}`);
        }
    });
    
    await runTest('createSeededRandom produces values in [0, 1) range', async () => {
        const random = createSeededRandom(42);
        for (let i = 0; i < 1000; i++) {
            const val = random();
            assert(val >= 0 && val < 1, `Value should be in [0, 1), got ${val}`);
        }
    });
    
    await runTest('createSeededRandom with different seeds produces different values', async () => {
        const random1 = createSeededRandom(111);
        const random2 = createSeededRandom(222);
        
        let allSame = true;
        for (let i = 0; i < 10; i++) {
            if (random1() !== random2()) {
                allSame = false;
                break;
            }
        }
        assert(!allSame, 'Different seeds should produce different sequences');
    });
    
    logSection('GameUtils - Coordinate Packing');
    
    await runTest('packCoords packs x and y correctly', async () => {
        const packed = packCoords(100, 200);
        assert(packed === 100 + 200 * COORD_PACK_BASE, `Expected ${100 + 200 * 1024}, got ${packed}`);
    });
    
    await runTest('packCoords handles zero values', async () => {
        assert(packCoords(0, 0) === 0, 'packCoords(0, 0) should be 0');
    });
    
    await runTest('packCoords handles edge values', async () => {
        const packed = packCoords(511, 511);
        const expected = 511 + 511 * COORD_PACK_BASE;
        assert(packed === expected, `Expected ${expected}, got ${packed}`);
    });
    
    await runTest('unpackCoords correctly unpacks packed coordinates', async () => {
        const testCases = [
            [0, 0],
            [100, 200],
            [255, 128],
            [511, 511],
            [1, 1],
        ];
        
        for (const [x, y] of testCases) {
            const packed = packCoords(x, y);
            const unpacked = unpackCoords(packed);
            assert(unpacked.x === x, `x: expected ${x}, got ${unpacked.x} for packed ${packed}`);
            assert(unpacked.y === y, `y: expected ${y}, got ${unpacked.y} for packed ${packed}`);
        }
    });
    
    logSection('GameUtils - Unit Selection');
    
    await runTest('getUnitSelectedFromG returns false for unselected unit', async () => {
        const gValue = 10.0; // Some resource value, no selection bit
        assert(getUnitSelectedFromG(gValue) === false, 'Should return false for unselected');
    });
    
    await runTest('setUnitSelectionInG sets selection bit correctly', async () => {
        const gValue = 10.0;
        const selected = setUnitSelectionInG(gValue, true);
        assert(getUnitSelectedFromG(selected) === true, 'Should be selected after setting');
        
        const unselected = setUnitSelectionInG(selected, false);
        assert(getUnitSelectedFromG(unselected) === false, 'Should be unselected after clearing');
    });
    
    await runTest('setUnitSelectionInG preserves other data', async () => {
        const original = 15.5;
        const selected = setUnitSelectionInG(original, true);
        const unselected = setUnitSelectionInG(selected, false);
        
        // The base value should be approximately preserved
        const baseOriginal = original % SELECTED_PACK_BASE;
        const baseUnselected = unselected % SELECTED_PACK_BASE;
        assertApprox(baseUnselected, baseOriginal, 1.0, 'Base value should be preserved');
    });
    
    logSection('GameUtils - Grid Helpers');
    
    await runTest('getGridIndex calculates correct index', async () => {
        const gridSize = 512;
        
        assert(getGridIndex(0, 0, gridSize) === 0, 'Index at (0,0) should be 0');
        assert(getGridIndex(1, 0, gridSize) === 4, 'Index at (1,0) should be 4');
        assert(getGridIndex(0, 1, gridSize) === 512 * 4, 'Index at (0,1) should be 512*4');
        assert(getGridIndex(10, 20, gridSize) === (20 * 512 + 10) * 4, 'Index calculation should be correct');
    });
    
    await runTest('isInBounds returns correct values', async () => {
        const gridSize = 512;
        
        assert(isInBounds(0, 0, gridSize) === true, '(0,0) should be in bounds');
        assert(isInBounds(255, 255, gridSize) === true, '(255,255) should be in bounds');
        assert(isInBounds(511, 511, gridSize) === true, '(511,511) should be in bounds');
        assert(isInBounds(-1, 0, gridSize) === false, '(-1,0) should be out of bounds');
        assert(isInBounds(0, -1, gridSize) === false, '(0,-1) should be out of bounds');
        assert(isInBounds(512, 0, gridSize) === false, '(512,0) should be out of bounds');
        assert(isInBounds(0, 512, gridSize) === false, '(0,512) should be out of bounds');
    });
    
    logSection('GameUtils - Player Type Helpers');
    
    await runTest('getUnitTypeForPlayer returns correct unit type', async () => {
        assert(getUnitTypeForPlayer(PLAYER_1) === CELL_MINING_UNIT, 'P1 unit should be CELL_MINING_UNIT');
        assert(getUnitTypeForPlayer(PLAYER_2) === CELL_MINING_UNIT_P2, 'P2 unit should be CELL_MINING_UNIT_P2');
    });
    
    await runTest('getFactoryTypeForPlayer returns correct factory type', async () => {
        assert(getFactoryTypeForPlayer(PLAYER_1) === CELL_MINING_FACTORY, 'P1 factory should be CELL_MINING_FACTORY');
        assert(getFactoryTypeForPlayer(PLAYER_2) === CELL_MINING_FACTORY_P2, 'P2 factory should be CELL_MINING_FACTORY_P2');
    });
    
    logSection('GameUtils - Utility Functions');
    
    await runTest('formatDuration formats correctly', async () => {
        assert(formatDuration(0) === '00:00', 'Zero should format as 00:00');
        assert(formatDuration(1000) === '00:01', '1 second should format as 00:01');
        assert(formatDuration(60000) === '01:00', '1 minute should format as 01:00');
        assert(formatDuration(3661000) === '61:01', '61 minutes 1 second should format as 61:01');
    });
    
    await runTest('clamp constrains values correctly', async () => {
        assert(clamp(5, 0, 10) === 5, 'Value in range should stay same');
        assert(clamp(-5, 0, 10) === 0, 'Value below min should clamp to min');
        assert(clamp(15, 0, 10) === 10, 'Value above max should clamp to max');
        assert(clamp(0, 0, 10) === 0, 'Min value should stay same');
        assert(clamp(10, 0, 10) === 10, 'Max value should stay same');
    });
    
    await runTest('distance calculates Euclidean distance', async () => {
        assertApprox(distance(0, 0, 3, 4), 5, 0.001, '3-4-5 triangle');
        assertApprox(distance(0, 0, 0, 0), 0, 0.001, 'Same point');
        assertApprox(distance(1, 1, 4, 5), 5, 0.001, '3-4-5 triangle offset');
        assertApprox(distance(-1, -1, 2, 3), 5, 0.001, '3-4-5 triangle negative');
    });
}

