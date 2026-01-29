/**
 * Resource Movement Tests
 * 
 * Tests for resource movement behavior:
 * - No directional bias (resources should stay roughly symmetrical)
 * - Clumping behavior (resources should stay together)
 * - Movement rate (resources move slowly)
 */

import { PingPongBuffer } from '../gpu/PingPongBuffer.js';
import { ComputeShader } from '../gpu/ComputeShader.js';
import { loadShader } from '../shaders/load.js';
import { runTest, assert, logSection } from './framework.js';

// Cell type constants (must match GLSL)
const CELL_EMPTY = 0;
const CELL_RESOURCE = 1;

// Grid size for bias tests - smaller = faster, but need enough room for movement
const BIAS_TEST_GRID_SIZE = 32;

// Number of simulation steps to run for bias detection
// Resources move every 8 ticks, so 500 steps = ~62 movement opportunities
const BIAS_TEST_STEPS = 500;

// Maximum allowed eigenvalue ratio (stretch factor)
// This measures how "linear" vs "circular" the distribution is
// A ratio of 1 means perfectly circular, higher means more stretched
// This is rotation-invariant - catches diagonal stretching too
const MAX_STRETCH_RATIO = 3.0;

// Extended simulation allows more variance since shape fluctuates over time
const MAX_STRETCH_RATIO_EXTENDED = 5.0;

// ============================================================================
// Cell Creation Helpers
// ============================================================================

function createEmpty() {
    return [CELL_EMPTY, 0, 0, 0];
}

function createResource(amount = 1, phase = 0) {
    // R: type, G: amount, B: phase (for movement timing), A: unused
    return [CELL_RESOURCE, amount, phase, 0];
}

// ============================================================================
// Cell Reading Helpers
// ============================================================================

function getCellType(cell) {
    return Math.round(cell[0]);
}

// ============================================================================
// Resource Movement Simulation Helper
// ============================================================================

// Shared shader instance (compiled once, reused across all tests)
let sharedShader = null;

/**
 * Initialize the shared shader. Call once before running tests.
 */
async function initSharedShader() {
    if (!sharedShader) {
        const source = await loadShader('./src/shaders/ca/v2/mining_game.frag.glsl');
        sharedShader = new ComputeShader(source);
    }
    return sharedShader;
}

function createResourceSimulation(width, height) {
    const buffer = new PingPongBuffer(width, height, { format: 'float' });
    let time = 0;
    
    return {
        buffer,
        width,
        height,
        
        // No-op for backwards compatibility - shader is already initialized
        async init() {
            // Shader is shared, no initialization needed per-test
        },
        
        setCell(data, x, y, cellData) {
            const idx = (y * width + x) * 4;
            data[idx + 0] = cellData[0];
            data[idx + 1] = cellData[1];
            data[idx + 2] = cellData[2];
            data[idx + 3] = cellData[3];
        },
        
        getCell(data, x, y) {
            const idx = (y * width + x) * 4;
            return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
        },
        
        step(timeIncrement = 1) {
            buffer.getWriteFramebuffer().bind();
            sharedShader.use();
            sharedShader.setTexture('u_state', buffer.getReadTexture(), 0);
            sharedShader.setVec2('u_resolution', width, height);
            sharedShader.setFloat('u_time', time);
            sharedShader.dispatch();
            buffer.getWriteFramebuffer().unbind();
            buffer.swap();
            time += timeIncrement;
        },
        
        stepN(n, timeIncrement = 1) {
            for (let i = 0; i < n; i++) {
                this.step(timeIncrement);
            }
        },
        
        setTime(t) {
            time = t;
        },
        
        upload(data) {
            buffer.upload(data);
        },
        
        download() {
            return buffer.download();
        },
        
        createEmptyGrid() {
            return new Float32Array(width * height * 4);
        },
        
        destroy() {
            // Only destroy the buffer, not the shared shader
            buffer.destroy();
        }
    };
}

// ============================================================================
// Analysis Helpers
// ============================================================================

/**
 * Calculate the "stretch ratio" of resource positions using eigenvalue analysis.
 * This is rotation-invariant - it detects stretching in ANY direction.
 * 
 * Returns the ratio of the larger eigenvalue to the smaller eigenvalue.
 * - Ratio = 1: perfectly circular distribution
 * - Ratio > 1: stretched/linear distribution
 * 
 * Uses the covariance matrix of positions and calculates eigenvalues.
 */
function getStretchRatio(sim, data) {
    // First, collect all resource positions
    const positions = [];
    for (let y = 0; y < sim.height; y++) {
        for (let x = 0; x < sim.width; x++) {
            const cell = sim.getCell(data, x, y);
            if (getCellType(cell) === CELL_RESOURCE) {
                positions.push({ x, y });
            }
        }
    }
    
    if (positions.length < 2) {
        return { ratio: 1, count: positions.length, lambda1: 0, lambda2: 0 };
    }
    
    // Calculate mean (center of mass)
    let meanX = 0, meanY = 0;
    for (const p of positions) {
        meanX += p.x;
        meanY += p.y;
    }
    meanX /= positions.length;
    meanY /= positions.length;
    
    // Calculate covariance matrix elements
    // [cov_xx, cov_xy]
    // [cov_xy, cov_yy]
    let covXX = 0, covYY = 0, covXY = 0;
    for (const p of positions) {
        const dx = p.x - meanX;
        const dy = p.y - meanY;
        covXX += dx * dx;
        covYY += dy * dy;
        covXY += dx * dy;
    }
    covXX /= positions.length;
    covYY /= positions.length;
    covXY /= positions.length;
    
    // Calculate eigenvalues of 2x2 covariance matrix
    // For [[a, b], [b, c]], eigenvalues are:
    // λ = (a + c ± sqrt((a - c)^2 + 4b^2)) / 2
    const a = covXX, b = covXY, c = covYY;
    const trace = a + c;
    const discriminant = Math.sqrt((a - c) * (a - c) + 4 * b * b);
    
    const lambda1 = (trace + discriminant) / 2;  // Larger eigenvalue
    const lambda2 = (trace - discriminant) / 2;  // Smaller eigenvalue
    
    // Avoid division by zero
    const ratio = lambda2 > 0.001 ? lambda1 / lambda2 : (lambda1 > 0 ? Infinity : 1);
    
    return { 
        ratio, 
        count: positions.length, 
        lambda1, 
        lambda2,
        centerX: meanX,
        centerY: meanY
    };
}

/**
 * Find bounding box of all resources in the grid
 */
function getResourceBoundingBox(sim, data) {
    let minX = sim.width, maxX = -1;
    let minY = sim.height, maxY = -1;
    let count = 0;
    
    for (let y = 0; y < sim.height; y++) {
        for (let x = 0; x < sim.width; x++) {
            const cell = sim.getCell(data, x, y);
            if (getCellType(cell) === CELL_RESOURCE) {
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
                count++;
            }
        }
    }
    
    if (count === 0) {
        return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0, count: 0 };
    }
    
    return {
        minX, maxX, minY, maxY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        count
    };
}

/**
 * Calculate center of mass of resources
 */
function getResourceCenterOfMass(sim, data) {
    let sumX = 0, sumY = 0, count = 0;
    
    for (let y = 0; y < sim.height; y++) {
        for (let x = 0; x < sim.width; x++) {
            const cell = sim.getCell(data, x, y);
            if (getCellType(cell) === CELL_RESOURCE) {
                sumX += x;
                sumY += y;
                count++;
            }
        }
    }
    
    if (count === 0) {
        return { x: sim.width / 2, y: sim.height / 2, count: 0 };
    }
    
    return {
        x: sumX / count,
        y: sumY / count,
        count
    };
}

/**
 * Count resources in the grid
 */
function countResources(sim, data) {
    let count = 0;
    for (let y = 0; y < sim.height; y++) {
        for (let x = 0; x < sim.width; x++) {
            const cell = sim.getCell(data, x, y);
            if (getCellType(cell) === CELL_RESOURCE) {
                count++;
            }
        }
    }
    return count;
}

/**
 * Create a square blob of resources centered in the grid
 */
function createResourceBlob(sim, data, blobSize) {
    const centerX = Math.floor(sim.width / 2);
    const centerY = Math.floor(sim.height / 2);
    const halfSize = Math.floor(blobSize / 2);
    
    for (let dy = -halfSize; dy <= halfSize; dy++) {
        for (let dx = -halfSize; dx <= halfSize; dx++) {
            const x = centerX + dx;
            const y = centerY + dy;
            if (x >= 0 && x < sim.width && y >= 0 && y < sim.height) {
                // Vary phase so resources don't all move at once
                const phase = Math.abs(dx + dy) % 8;
                sim.setCell(data, x, y, createResource(1, phase));
            }
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

export async function runResourceMovementTests() {
    // Initialize shared shader once for all resource movement tests
    await initSharedShader();
    
    logSection('Resource Movement - Bias Detection');
    
    await runTest('Resource movement: blob stays circular (no directional stretch)', async () => {
        const sim = createResourceSimulation(BIAS_TEST_GRID_SIZE, BIAS_TEST_GRID_SIZE);
        await sim.init();
        
        const data = sim.createEmptyGrid();
        
        // Create an 8x8 square blob of resources in the center
        createResourceBlob(sim, data, 8);
        
        // Record initial state using eigenvalue analysis
        const initialStretch = getStretchRatio(sim, data);
        
        console.log(`  Initial: ${initialStretch.count} resources, stretch ratio: ${initialStretch.ratio.toFixed(2)} (λ1=${initialStretch.lambda1.toFixed(2)}, λ2=${initialStretch.lambda2.toFixed(2)})`);
        
        sim.upload(data);
        
        // Run many simulation steps
        sim.stepN(BIAS_TEST_STEPS);
        
        // Analyze final state
        const finalData = sim.download();
        const finalStretch = getStretchRatio(sim, finalData);
        
        console.log(`  Final: ${finalStretch.count} resources, stretch ratio: ${finalStretch.ratio.toFixed(2)} (λ1=${finalStretch.lambda1.toFixed(2)}, λ2=${finalStretch.lambda2.toFixed(2)})`);
        
        // Resources should be conserved
        assert(finalStretch.count === initialStretch.count, 
            `Resource count changed: ${initialStretch.count} -> ${finalStretch.count}`);
        
        // Stretch ratio should stay low (blob stays circular, not linear)
        // This is rotation-invariant - catches diagonal stretching too
        assert(finalStretch.ratio < MAX_STRETCH_RATIO, 
            `Resources became too linear/stretched: ratio ${finalStretch.ratio.toFixed(2)} > ${MAX_STRETCH_RATIO}`);
        
        sim.destroy();
    });
    
    await runTest('Resource movement: center of mass stays near initial position', async () => {
        const sim = createResourceSimulation(BIAS_TEST_GRID_SIZE, BIAS_TEST_GRID_SIZE);
        await sim.init();
        
        const data = sim.createEmptyGrid();
        
        // Create a 6x6 square blob of resources
        createResourceBlob(sim, data, 6);
        
        // Record initial center
        const initialCOM = getResourceCenterOfMass(sim, data);
        console.log(`  Initial center: (${initialCOM.x.toFixed(2)}, ${initialCOM.y.toFixed(2)})`);
        
        sim.upload(data);
        
        // Run simulation
        sim.stepN(BIAS_TEST_STEPS);
        
        // Analyze final state
        const finalData = sim.download();
        const finalCOM = getResourceCenterOfMass(sim, finalData);
        
        // Calculate drift
        const driftX = finalCOM.x - initialCOM.x;
        const driftY = finalCOM.y - initialCOM.y;
        const driftMagnitude = Math.sqrt(driftX * driftX + driftY * driftY);
        
        console.log(`  Final center: (${finalCOM.x.toFixed(2)}, ${finalCOM.y.toFixed(2)})`);
        console.log(`  Drift: (${driftX.toFixed(2)}, ${driftY.toFixed(2)}), magnitude: ${driftMagnitude.toFixed(2)}`);
        
        // Center of mass shouldn't drift more than a few cells
        // Allow up to 3 cells of drift (resources should clump, not drift)
        const maxDrift = 3;
        assert(driftMagnitude < maxDrift, 
            `Resources drifted too far: ${driftMagnitude.toFixed(2)} cells (max: ${maxDrift}). ` +
            `Direction: (${driftX.toFixed(2)}, ${driftY.toFixed(2)})`);
        
        sim.destroy();
    });
    
    await runTest('Resource movement: extended simulation stays blobby (no linear drift)', async () => {
        // Run for more steps to catch slow accumulating bias in any direction
        const sim = createResourceSimulation(BIAS_TEST_GRID_SIZE, BIAS_TEST_GRID_SIZE);
        await sim.init();
        
        const data = sim.createEmptyGrid();
        
        // Create a 7x7 square blob of resources
        createResourceBlob(sim, data, 7);
        
        const initialStretch = getStretchRatio(sim, data);
        console.log(`  Initial: ${initialStretch.count} resources, stretch ratio: ${initialStretch.ratio.toFixed(2)}`);
        
        sim.upload(data);
        
        // Run extended simulation, checking periodically
        const checkpoints = [250, 500, 750, 1000];
        let worstStretchRatio = 1.0;
        
        for (const checkpoint of checkpoints) {
            // Run to this checkpoint
            const stepsToRun = checkpoint - (sim.buffer.time || 0);
            sim.stepN(stepsToRun);
            
            const checkData = sim.download();
            const stretch = getStretchRatio(sim, checkData);
            
            console.log(`  Step ${checkpoint}: stretch ratio ${stretch.ratio.toFixed(2)} (λ1=${stretch.lambda1.toFixed(2)}, λ2=${stretch.lambda2.toFixed(2)})`);
            
            worstStretchRatio = Math.max(worstStretchRatio, stretch.ratio);
            
            // Re-upload for next iteration
            sim.upload(checkData);
        }
        
        // Final check - use extended threshold for long simulations
        // Some shape fluctuation is expected over 1000 steps
        // This catches stretching in ANY direction (horizontal, vertical, diagonal)
        assert(worstStretchRatio < MAX_STRETCH_RATIO_EXTENDED, 
            `Resources became too linear during simulation: worst stretch ratio ${worstStretchRatio.toFixed(2)} > ${MAX_STRETCH_RATIO_EXTENDED}`);
        
        sim.destroy();
    });
    
    await runTest('Resource movement: resources are conserved', async () => {
        const sim = createResourceSimulation(BIAS_TEST_GRID_SIZE, BIAS_TEST_GRID_SIZE);
        await sim.init();
        
        const data = sim.createEmptyGrid();
        
        // Create a 5x5 square blob
        createResourceBlob(sim, data, 5);
        
        const initialCount = countResources(sim, data);
        console.log(`  Initial resources: ${initialCount}`);
        
        sim.upload(data);
        
        // Run simulation
        sim.stepN(BIAS_TEST_STEPS);
        
        const finalData = sim.download();
        const finalCount = countResources(sim, finalData);
        
        console.log(`  Final resources: ${finalCount}`);
        
        assert(finalCount === initialCount, 
            `Resources not conserved: ${initialCount} -> ${finalCount}`);
        
        sim.destroy();
    });
    
    await runTest('Resource movement: blob stays cohesive (no excessive spreading)', async () => {
        // Test that blobs don't dissolve/spread too much
        // Measures total variance (λ1 + λ2) which increases as blob spreads
        const extendedSteps = 1000;
        
        const sim = createResourceSimulation(BIAS_TEST_GRID_SIZE, BIAS_TEST_GRID_SIZE);
        await sim.init();
        
        const data = sim.createEmptyGrid();
        
        // Create a 7x7 square blob of resources
        createResourceBlob(sim, data, 7);
        
        // Calculate initial spread (total variance = λ1 + λ2)
        const initialAnalysis = getStretchRatio(sim, data);
        const initialSpread = initialAnalysis.lambda1 + initialAnalysis.lambda2;
        console.log(`  Initial spread (λ1+λ2): ${initialSpread.toFixed(2)}`);
        
        sim.upload(data);
        
        // Run extended simulation, checking periodically
        const checkpoints = [250, 500, 750, 1000];
        let worstSpreadRatio = 1.0;
        
        for (const checkpoint of checkpoints) {
            // Run to this checkpoint
            const stepsToRun = checkpoint - (checkpoint === 250 ? 0 : checkpoints[checkpoints.indexOf(checkpoint) - 1]);
            sim.stepN(stepsToRun);
            
            const checkData = sim.download();
            const analysis = getStretchRatio(sim, checkData);
            const currentSpread = analysis.lambda1 + analysis.lambda2;
            const spreadRatio = currentSpread / initialSpread;
            
            console.log(`  Step ${checkpoint}: spread ratio ${spreadRatio.toFixed(2)} (λ1+λ2=${currentSpread.toFixed(2)})`);
            
            if (spreadRatio > worstSpreadRatio) {
                worstSpreadRatio = spreadRatio;
            }
            
            // Re-upload for next checkpoint
            sim.upload(checkData);
        }
        
        // Spread should not increase more than 3x over 1000 steps
        // If blobs are cohesive, they stay compact
        const MAX_SPREAD_RATIO = 3.0;
        assert(worstSpreadRatio < MAX_SPREAD_RATIO, 
            `Blob spread too much: worst spread ratio ${worstSpreadRatio.toFixed(2)} > ${MAX_SPREAD_RATIO}`);
        
        sim.destroy();
    });
}

