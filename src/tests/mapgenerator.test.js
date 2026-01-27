/**
 * MapGenerator Unit Tests
 * Tests for game/MapGenerator.js
 */

import { runTest, assert, assertApprox, logSection } from './framework.js';
import { MapGenerator } from '../game/MapGenerator.js';
import { CELL_EMPTY, CELL_RESOURCE, CELL_WALL } from '../utils/GameUtils.js';

// Helper to count cell types in grid
function countCellTypes(data, gridSize) {
    const counts = {};
    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            const idx = (y * gridSize + x) * 4;
            const cellType = data[idx];
            counts[cellType] = (counts[cellType] || 0) + 1;
        }
    }
    return counts;
}

export async function runMapGeneratorTests() {
    const GRID_SIZE = 128; // Smaller grid for faster tests
    
    logSection('MapGenerator - Initialization');
    
    await runTest('MapGenerator initializes with default options', async () => {
        const generator = new MapGenerator(GRID_SIZE);
        assert(generator.gridSize === GRID_SIZE, 'Grid size should be set');
    });
    
    await runTest('MapGenerator accepts custom options', async () => {
        const generator = new MapGenerator(GRID_SIZE, {
            numBlobs: 100,
            blobMinRadius: 2,
            blobMaxRadius: 5
        });
        
        assert(generator.options.numBlobs === 100, 'Custom numBlobs should be set');
    });
    
    logSection('MapGenerator - Determinism');
    
    await runTest('generate produces deterministic output for same seed', async () => {
        const generator = new MapGenerator(GRID_SIZE, {
            numBlobs: 50,
            numWallLines: 20
        });
        
        const data1 = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        const data2 = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        
        generator.generate(data1, 12345);
        generator.generate(data2, 12345);
        
        let identical = true;
        for (let i = 0; i < data1.length; i++) {
            if (data1[i] !== data2[i]) {
                identical = false;
                break;
            }
        }
        
        assert(identical, 'Same seed should produce identical maps');
    });
    
    await runTest('generate produces different output for different seeds', async () => {
        const generator = new MapGenerator(GRID_SIZE, {
            numBlobs: 50,
            numWallLines: 20
        });
        
        const data1 = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        const data2 = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        
        generator.generate(data1, 11111);
        generator.generate(data2, 22222);
        
        let differences = 0;
        for (let i = 0; i < data1.length; i++) {
            if (data1[i] !== data2[i]) {
                differences++;
            }
        }
        
        assert(differences > 100, `Different seeds should produce different maps (${differences} differences)`);
    });
    
    logSection('MapGenerator - Content');
    
    await runTest('generate creates resources', async () => {
        const generator = new MapGenerator(GRID_SIZE, {
            numBlobs: 100,
            blobDensity: 0.8
        });
        
        const data = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        generator.generate(data, 42);
        
        const counts = countCellTypes(data, GRID_SIZE);
        
        assert(counts[CELL_RESOURCE] > 0, 'Should generate resources');
        assert(counts[CELL_RESOURCE] > 100, `Should generate many resources, got ${counts[CELL_RESOURCE]}`);
    });
    
    await runTest('generate creates walls', async () => {
        const generator = new MapGenerator(GRID_SIZE, {
            numWallLines: 50,
            numWallBlobs: 10
        });
        
        const data = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        generator.generate(data, 42);
        
        const counts = countCellTypes(data, GRID_SIZE);
        
        assert(counts[CELL_WALL] > 0, 'Should generate walls');
        assert(counts[CELL_WALL] > 50, `Should generate many walls, got ${counts[CELL_WALL]}`);
    });
    
    await runTest('generate leaves most cells empty', async () => {
        const generator = new MapGenerator(GRID_SIZE, {
            numBlobs: 50,
            numWallLines: 20
        });
        
        const data = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        generator.generate(data, 42);
        
        const counts = countCellTypes(data, GRID_SIZE);
        const totalCells = GRID_SIZE * GRID_SIZE;
        const emptyCount = counts[CELL_EMPTY] || 0;
        
        const emptyPercent = (emptyCount / totalCells) * 100;
        assert(emptyPercent > 50, `Most cells should be empty, got ${emptyPercent.toFixed(1)}%`);
    });
    
    await runTest('generate returns result with resource and wall counts', async () => {
        const generator = new MapGenerator(GRID_SIZE, {
            numBlobs: 50,
            numWallLines: 20
        });
        
        const data = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        const result = generator.generate(data, 42);
        
        assert(typeof result === 'object', 'Should return result object');
        assert(typeof result.resourceCount === 'number', 'Should have resourceCount');
        assert(typeof result.wallCount === 'number', 'Should have wallCount');
        assert(result.resourceCount > 0, 'Should have some resources');
        assert(result.wallCount > 0, 'Should have some walls');
    });
    
    logSection('MapGenerator - Edge Cases');
    
    await runTest('generate handles seed 0', async () => {
        const generator = new MapGenerator(GRID_SIZE);
        const data = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        
        // Should not throw
        const result = generator.generate(data, 0);
        assert(result !== undefined, 'Should return result even with seed 0');
    });
    
    await runTest('generate handles very large seed', async () => {
        const generator = new MapGenerator(GRID_SIZE);
        const data = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        
        // Should not throw
        const result = generator.generate(data, 999999999);
        assert(result !== undefined, 'Should handle large seed');
    });
    
    await runTest('generate with zero blobs/walls produces mostly empty map', async () => {
        const generator = new MapGenerator(GRID_SIZE, {
            numBlobs: 0,
            numWallLines: 0,
            numWallBlobs: 0
        });
        
        const data = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        generator.generate(data, 42);
        
        const counts = countCellTypes(data, GRID_SIZE);
        const totalCells = GRID_SIZE * GRID_SIZE;
        const emptyCount = counts[CELL_EMPTY] || 0;
        
        assert(emptyCount === totalCells, 'With zero features, all cells should be empty');
    });
    
    logSection('MapGenerator - Resource Amount');
    
    await runTest('resources have positive amounts', async () => {
        const generator = new MapGenerator(GRID_SIZE, {
            numBlobs: 50
        });
        
        const data = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
        generator.generate(data, 42);
        
        let foundResource = false;
        for (let y = 0; y < GRID_SIZE; y++) {
            for (let x = 0; x < GRID_SIZE; x++) {
                const idx = (y * GRID_SIZE + x) * 4;
                if (data[idx] === CELL_RESOURCE) {
                    const amount = data[idx + 1];
                    assert(amount > 0, `Resource at (${x},${y}) should have positive amount, got ${amount}`);
                    foundResource = true;
                    break;
                }
            }
            if (foundResource) break;
        }
        
        assert(foundResource, 'Should have found at least one resource');
    });
}

