// src/game/MapGenerator.js
// Map generation for the game

import { createSeededRandom } from '../utils/GameUtils.js';

// Cell type constants (must match GLSL)
const CELL_EMPTY = 0;
const CELL_RESOURCE = 1;
const CELL_WALL = 4;

export class MapGenerator {
    constructor(gridSize, config = {}) {
        this.gridSize = gridSize;
        
        // Configuration with defaults
        this.config = {
            numBlobs: config.numBlobs ?? 600,
            blobMinRadius: config.blobMinRadius ?? 3,
            blobMaxRadius: config.blobMaxRadius ?? 8,
            blobDensity: config.blobDensity ?? 0.6,
            numWallLines: config.numWallLines ?? 176,
            wallMinLength: config.wallMinLength ?? 5,
            wallMaxLength: config.wallMaxLength ?? 20,
            numWallBlobs: config.numWallBlobs ?? 20,
            wallBlobRadius: config.wallBlobRadius ?? 3,
        };
    }

    /**
     * Generate a map into the provided data array
     * @param {Float32Array} data - The data array to fill (gridSize * gridSize * 4 elements)
     * @param {number} seed - The random seed
     * @returns {Object} Statistics about the generated map
     */
    generate(data, seed) {
        console.log(`Generating map with seed: ${seed}`);
        
        const random = createSeededRandom(seed);
        const { gridSize, config } = this;
        
        // Helper functions
        const setCell = (x, y, type, dataA = 0, dataB = 0, dataC = 0) => {
            const idx = (y * gridSize + x) * 4;
            data[idx + 0] = type;
            data[idx + 1] = dataA;
            data[idx + 2] = dataB;
            data[idx + 3] = dataC;
        };
        
        const isEmpty = (x, y) => {
            const idx = (y * gridSize + x) * 4;
            return data[idx] === CELL_EMPTY;
        };
        
        // Fill with empty
        data.fill(0);
        
        // Place resources in blobs/clusters (more realistic RTS style)
        let totalResources = 0;
        
        for (let b = 0; b < config.numBlobs; b++) {
            // Pick blob center randomly
            const centerX = Math.floor(random() * (gridSize - 20)) + 10;
            const centerY = Math.floor(random() * (gridSize - 20)) + 10;
            
            // Random radius for this blob
            const radius = config.blobMinRadius + random() * (config.blobMaxRadius - config.blobMinRadius);
            
            // Fill the blob with resources
            for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
                for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
                    const x = centerX + dx;
                    const y = centerY + dy;
                    
                    // Check bounds
                    if (x < 1 || x >= gridSize - 1 || y < 1 || y >= gridSize - 1) continue;
                    
                    // Check if within blob radius (with some noise for organic shape)
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const noiseRadius = radius * (0.7 + random() * 0.6); // Irregular edges
                    if (dist > noiseRadius) continue;
                    
                    // Density check
                    if (random() > config.blobDensity) continue;
                    
                    // Give each resource a random phase (0-255) for staggered movement
                    const phase = Math.floor(random() * 256);
                    setCell(x, y, CELL_RESOURCE, 1.0, phase);
                    totalResources++;
                }
            }
        }
        
        // Generate Walls - random barriers and obstacles
        let totalWalls = 0;
        
        // Generate wall lines (horizontal or vertical)
        for (let i = 0; i < config.numWallLines; i++) {
            const horizontal = random() > 0.5;
            const length = Math.floor(config.wallMinLength + random() * (config.wallMaxLength - config.wallMinLength));
            
            // Pick starting position (leave margin from edges)
            const startX = Math.floor(random() * (gridSize - length - 10)) + 5;
            const startY = Math.floor(random() * (gridSize - length - 10)) + 5;
            
            for (let j = 0; j < length; j++) {
                const x = horizontal ? startX + j : startX;
                const y = horizontal ? startY : startY + j;
                
                // Only place if cell is empty (don't overwrite resources)
                if (x >= 1 && x < gridSize - 1 && y >= 1 && y < gridSize - 1 && isEmpty(x, y)) {
                    setCell(x, y, CELL_WALL);
                    totalWalls++;
                }
            }
        }
        
        // Generate small wall clusters
        for (let b = 0; b < config.numWallBlobs; b++) {
            const centerX = Math.floor(random() * (gridSize - 20)) + 10;
            const centerY = Math.floor(random() * (gridSize - 20)) + 10;
            
            for (let dy = -config.wallBlobRadius; dy <= config.wallBlobRadius; dy++) {
                for (let dx = -config.wallBlobRadius; dx <= config.wallBlobRadius; dx++) {
                    const x = centerX + dx;
                    const y = centerY + dy;
                    
                    if (x < 1 || x >= gridSize - 1 || y < 1 || y >= gridSize - 1) continue;
                    
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist > config.wallBlobRadius * 0.8) continue;
                    
                    // 70% density
                    if (random() > 0.7) continue;
                    
                    if (isEmpty(x, y)) {
                        setCell(x, y, CELL_WALL);
                        totalWalls++;
                    }
                }
            }
        }
        
        console.log(`Map generated:`);
        console.log(`  Grid: ${gridSize}x${gridSize}`);
        console.log(`  ${totalResources} resources scattered`);
        console.log(`  ${totalWalls} walls placed`);
        
        return { totalResources, totalWalls };
    }
}

