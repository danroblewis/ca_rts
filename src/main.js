import { GPU } from './gpu/GPU.js';
import { ComputeShader } from './gpu/ComputeShader.js';
import { loadShader } from './shaders/load.js';
import { CAGrid } from './ca/CAGrid.js';

// Cell type constants (must match GLSL)
const CELL_EMPTY = 0;
const CELL_RESOURCE = 1;
const CELL_MINING_UNIT = 2;
const CELL_MINING_FACTORY = 3;

// ============================================================================
// Initialize GPU
// ============================================================================

const canvas = document.getElementById('canvas');
const gpu = GPU.init(canvas);
const gl = gpu.gl;

function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
}
window.addEventListener('resize', resize);
resize();

console.log('GPU compute framework initialized');

// ============================================================================
// Load Shaders
// ============================================================================

const [simShaderSource, renderShaderSource] = await Promise.all([
    loadShader('./src/shaders/ca/mining_game.frag.glsl'),
    loadShader('./src/shaders/ca/render.frag.glsl')
]);

const simShader = new ComputeShader(simShaderSource);
const renderShader = new ComputeShader(renderShaderSource);

// ============================================================================
// Initialize World
// ============================================================================

const GRID_SIZE = 128;
const grid = new CAGrid(GRID_SIZE, GRID_SIZE);

const data = new Float32Array(GRID_SIZE * GRID_SIZE * 4);

// Helper to set a cell
function setCell(x, y, type, dataA = 0, dataB = 0, dataC = 0) {
    const idx = (y * GRID_SIZE + x) * 4;
    data[idx + 0] = type;
    data[idx + 1] = dataA;
    data[idx + 2] = dataB;
    data[idx + 3] = dataC;
}

// Fill with empty
data.fill(0);

// Place the mining factory in the center
const factoryX = Math.floor(GRID_SIZE / 2);
const factoryY = Math.floor(GRID_SIZE / 2);
// Factory: type=3, resourceCount=10, selfX, selfY
setCell(factoryX, factoryY, CELL_MINING_FACTORY, 10, factoryX, factoryY);

// Place resources in blobs/clusters (more realistic RTS style)
const NUM_BLOBS = 10;
const BLOB_MIN_RADIUS = 3;
const BLOB_MAX_RADIUS = 8;
const BLOB_DENSITY = 0.6; // % of cells in blob that have resources

let totalResources = 0;

for (let b = 0; b < NUM_BLOBS; b++) {
    // Pick blob center (not too close to factory)
    let centerX, centerY;
    do {
        centerX = Math.floor(Math.random() * (GRID_SIZE - 20)) + 10;
        centerY = Math.floor(Math.random() * (GRID_SIZE - 20)) + 10;
    } while (Math.abs(centerX - factoryX) < 15 && Math.abs(centerY - factoryY) < 15);
    
    // Random radius for this blob
    const radius = BLOB_MIN_RADIUS + Math.random() * (BLOB_MAX_RADIUS - BLOB_MIN_RADIUS);
    
    // Fill the blob with resources
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
        for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
            const x = centerX + dx;
            const y = centerY + dy;
            
            // Check bounds
            if (x < 1 || x >= GRID_SIZE - 1 || y < 1 || y >= GRID_SIZE - 1) continue;
            
            // Check if within blob radius (with some noise for organic shape)
            const dist = Math.sqrt(dx * dx + dy * dy);
            const noiseRadius = radius * (0.7 + Math.random() * 0.6); // Irregular edges
            if (dist > noiseRadius) continue;
            
            // Density check
            if (Math.random() > BLOB_DENSITY) continue;
            
            // Don't overwrite factory
            if (x === factoryX && y === factoryY) continue;
            
            setCell(x, y, CELL_RESOURCE, 1.0);
            totalResources++;
        }
    }
}

const NUM_RESOURCES = totalResources;

grid.upload(data);

console.log(`Mining Game initialized:`);
console.log(`  Grid: ${GRID_SIZE}x${GRID_SIZE}`);
console.log(`  Factory at (${factoryX}, ${factoryY}) with 10 resources`);
console.log(`  ${NUM_RESOURCES} resources scattered`);
console.log(`  Factory will spawn 2 mining units, they will mine and return resources`);

// ============================================================================
// Simulation Loop
// ============================================================================

let simStepCount = 0;
let renderFrameCount = 0;
let lastLogTime = performance.now();
let simTime = 0;
const LOG_INTERVAL = 1000;
const SIM_BATCH_SIZE = 1; // Slower to watch the action

function simulationStep() {
    grid.getWriteFramebuffer().bind();
    
    simShader.use();
    simShader.setTexture('u_state', grid.getReadTexture(), 0);
    simShader.setVec2('u_resolution', GRID_SIZE, GRID_SIZE);
    simShader.setFloat('u_time', simTime);
    simShader.dispatch();
    
    grid.getWriteFramebuffer().unbind();
    grid.swap();
    
    simStepCount++;
    simTime += 1.0;
}

function simulationLoop() {
    for (let i = 0; i < SIM_BATCH_SIZE; i++) {
        simulationStep();
    }
    
    const now = performance.now();
    const elapsed = now - lastLogTime;
    if (elapsed >= LOG_INTERVAL) {
        const simFps = (simStepCount / elapsed) * 1000;
        const renderFps = (renderFrameCount / elapsed) * 1000;
        console.log(`Sim: ${simFps.toFixed(0)} steps/sec | Render: ${renderFps.toFixed(0)} fps | Step: ${Math.floor(simTime)}`);
        simStepCount = 0;
        renderFrameCount = 0;
        lastLogTime = now;
    }
    
    setTimeout(simulationLoop, 0);
}

simulationLoop();

// ============================================================================
// Render Loop
// ============================================================================

function renderLoop() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);

    renderShader.use();
    renderShader.setTexture('u_state', grid.getReadTexture(), 0);
    renderShader.setVec2('u_resolution', GRID_SIZE, GRID_SIZE);
    renderShader.dispatch();

    renderFrameCount++;
    requestAnimationFrame(renderLoop);
}

requestAnimationFrame(renderLoop);
