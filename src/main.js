import { GPU } from './gpu/GPU.js';
import { ComputeShader } from './gpu/ComputeShader.js';
import { loadShader } from './shaders/load.js';
import { CAGrid } from './ca/CAGrid.js';

// Cell type constants (must match GLSL)
const CELL_EMPTY = 0;
const CELL_RESOURCE = 1;
const CELL_MINING_UNIT = 2;
const CELL_MINING_FACTORY = 3;
const CELL_WALL = 4;

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
// Load Shaders (v2 architecture)
// ============================================================================

const [simShaderSource, renderShaderSource] = await Promise.all([
    loadShader('./src/shaders/ca/v2/mining_game.frag.glsl'),
    loadShader('./src/shaders/ca/render_metaballs.frag.glsl')  // Pretty metaball renderer
    // loadShader('./src/shaders/ca/v2/render.frag.glsl')
]);

const simShader = new ComputeShader(simShaderSource);
const renderShader = new ComputeShader(renderShaderSource);

// ============================================================================
// Initialize World
// ============================================================================

const GRID_SIZE = 256;
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

// Place resources in blobs/clusters (more realistic RTS style)
const NUM_BLOBS = 150;
const BLOB_MIN_RADIUS = 3;
const BLOB_MAX_RADIUS = 8;
const BLOB_DENSITY = 0.6; // % of cells in blob that have resources

let totalResources = 0;

for (let b = 0; b < NUM_BLOBS; b++) {
    // Pick blob center randomly
    const centerX = Math.floor(Math.random() * (GRID_SIZE - 20)) + 10;
    const centerY = Math.floor(Math.random() * (GRID_SIZE - 20)) + 10;
    
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
            
            setCell(x, y, CELL_RESOURCE, 1.0);
            totalResources++;
        }
    }
}

const NUM_RESOURCES = totalResources;

// ============================================================================
// Generate Walls - random barriers and obstacles
// ============================================================================

const NUM_WALL_LINES = 44;      // Number of wall lines
const WALL_MIN_LENGTH = 5;
const WALL_MAX_LENGTH = 20;
const NUM_WALL_BLOBS = 5;      // Small wall clusters
const WALL_BLOB_RADIUS = 3;

let totalWalls = 0;

// Helper to check if a cell is empty (don't overwrite resources)
function isEmpty(x, y) {
    const idx = (y * GRID_SIZE + x) * 4;
    return data[idx] === CELL_EMPTY;
}

// Generate wall lines (horizontal or vertical)
for (let i = 0; i < NUM_WALL_LINES; i++) {
    const horizontal = Math.random() > 0.5;
    const length = Math.floor(WALL_MIN_LENGTH + Math.random() * (WALL_MAX_LENGTH - WALL_MIN_LENGTH));
    
    // Pick starting position (leave margin from edges)
    const startX = Math.floor(Math.random() * (GRID_SIZE - length - 10)) + 5;
    const startY = Math.floor(Math.random() * (GRID_SIZE - length - 10)) + 5;
    
    for (let j = 0; j < length; j++) {
        const x = horizontal ? startX + j : startX;
        const y = horizontal ? startY : startY + j;
        
        // Only place if cell is empty (don't overwrite resources)
        if (x >= 1 && x < GRID_SIZE - 1 && y >= 1 && y < GRID_SIZE - 1 && isEmpty(x, y)) {
            setCell(x, y, CELL_WALL);
            totalWalls++;
        }
    }
}

// Generate small wall clusters
for (let b = 0; b < NUM_WALL_BLOBS; b++) {
    const centerX = Math.floor(Math.random() * (GRID_SIZE - 20)) + 10;
    const centerY = Math.floor(Math.random() * (GRID_SIZE - 20)) + 10;
    
    for (let dy = -WALL_BLOB_RADIUS; dy <= WALL_BLOB_RADIUS; dy++) {
        for (let dx = -WALL_BLOB_RADIUS; dx <= WALL_BLOB_RADIUS; dx++) {
            const x = centerX + dx;
            const y = centerY + dy;
            
            if (x < 1 || x >= GRID_SIZE - 1 || y < 1 || y >= GRID_SIZE - 1) continue;
            
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > WALL_BLOB_RADIUS * 0.8) continue;
            
            // 70% density
            if (Math.random() > 0.7) continue;
            
            if (isEmpty(x, y)) {
                setCell(x, y, CELL_WALL);
                totalWalls++;
            }
        }
    }
}

grid.upload(data);

console.log(`Mining Game initialized:`);
console.log(`  Grid: ${GRID_SIZE}x${GRID_SIZE}`);
console.log(`  ${NUM_RESOURCES} resources scattered`);
console.log(`  ${totalWalls} walls placed`);
console.log(`  Click to place a mining factory!`);

// ============================================================================
// Click to Place Factory / Shift+Click to Delete
// ============================================================================

let factoriesPlaced = 0;
const FIRST_FACTORY_RESOURCES = 50;  // Only first factory gets resources
const DELETE_RADIUS = 5;  // Radius in grid cells for delete operation

// Cursor overlay for delete mode
const cursorOverlay = document.getElementById('cursor-overlay');
let mouseX = 0;
let mouseY = 0;
let shiftHeld = false;

// Convert screen coords to grid coords
function screenToGrid(screenX, screenY) {
    const rect = canvas.getBoundingClientRect();
    const normalizedX = (screenX - rect.left) / rect.width;
    const normalizedY = (screenY - rect.top) / rect.height;
    const gridX = Math.floor(normalizedX * GRID_SIZE);
    const gridY = Math.floor((1 - normalizedY) * GRID_SIZE);
    return {
        x: Math.max(0, Math.min(GRID_SIZE - 1, gridX)),
        y: Math.max(0, Math.min(GRID_SIZE - 1, gridY))
    };
}

// Update cursor overlay position and visibility
function updateCursorOverlay() {
    if (shiftHeld) {
        const rect = canvas.getBoundingClientRect();
        // Calculate the size of the delete area in screen pixels
        const cellSizeX = rect.width / GRID_SIZE;
        const cellSizeY = rect.height / GRID_SIZE;
        const sizeX = DELETE_RADIUS * 2 * cellSizeX;
        const sizeY = DELETE_RADIUS * 2 * cellSizeY;
        
        cursorOverlay.style.display = 'block';
        cursorOverlay.style.left = `${mouseX - sizeX / 2}px`;
        cursorOverlay.style.top = `${mouseY - sizeY / 2}px`;
        cursorOverlay.style.width = `${sizeX}px`;
        cursorOverlay.style.height = `${sizeY}px`;
    } else {
        cursorOverlay.style.display = 'none';
    }
}

// Track mouse movement
canvas.addEventListener('mousemove', (event) => {
    mouseX = event.clientX;
    mouseY = event.clientY;
    updateCursorOverlay();
});

// Track shift key
window.addEventListener('keydown', (event) => {
    if (event.key === 'Shift') {
        shiftHeld = true;
        updateCursorOverlay();
    }
});

window.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') {
        shiftHeld = false;
        updateCursorOverlay();
    }
});

canvas.addEventListener('click', (event) => {
    const gridPos = screenToGrid(event.clientX, event.clientY);
    const currentData = grid.download();
    
    if (event.shiftKey) {
        // SHIFT+CLICK: Delete factories in rectangle
        let deletedCount = 0;
        
        for (let dy = -DELETE_RADIUS; dy <= DELETE_RADIUS; dy++) {
            for (let dx = -DELETE_RADIUS; dx <= DELETE_RADIUS; dx++) {
                const x = gridPos.x + dx;
                const y = gridPos.y + dy;
                
                if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
                
                const idx = (y * GRID_SIZE + x) * 4;
                if (currentData[idx] === CELL_MINING_FACTORY) {
                    // Clear the cell (set to empty)
                    currentData[idx + 0] = CELL_EMPTY;
                    currentData[idx + 1] = 0;
                    currentData[idx + 2] = 0;
                    currentData[idx + 3] = 0;
                    deletedCount++;
                }
            }
        }
        
        grid.upload(currentData);
        if (deletedCount > 0) {
            console.log(`Deleted ${deletedCount} factory(ies) around (${gridPos.x}, ${gridPos.y})`);
        }
    } else {
        // NORMAL CLICK: Place factory
        const idx = (gridPos.y * GRID_SIZE + gridPos.x) * 4;
        
        // Only the first factory gets starting resources
        const resourceCount = (factoriesPlaced === 0) ? FIRST_FACTORY_RESOURCES : 0;
        
        // Place factory: type=3, resourceCount, selfX, selfY
        currentData[idx + 0] = CELL_MINING_FACTORY;
        currentData[idx + 1] = resourceCount;
        currentData[idx + 2] = gridPos.x;  // selfX
        currentData[idx + 3] = gridPos.y;  // selfY
        
        grid.upload(currentData);
        factoriesPlaced++;
        
        console.log(`Placed factory #${factoriesPlaced} at (${gridPos.x}, ${gridPos.y}) with ${resourceCount} resources`);
    }
});

// ============================================================================
// Simulation Loop
// ============================================================================

let simStepCount = 0;
let renderFrameCount = 0;
let lastLogTime = performance.now();
let simTime = 0;
const LOG_INTERVAL = 1000;
const SIM_BATCH_SIZE = 10; // Steps per batch in fast mode

// Toggle: true = sync with render (debug), false = fast as possible
let SYNC_SIM_WITH_RENDER = true;

// Expose toggle to console for easy switching
window.toggleSimSync = () => {
    SYNC_SIM_WITH_RENDER = !SYNC_SIM_WITH_RENDER;
    console.log(`Simulation sync: ${SYNC_SIM_WITH_RENDER ? 'ON (synced with render)' : 'OFF (fast as possible)'}`);
    if (!SYNC_SIM_WITH_RENDER) {
        // Start the fast loop when switching to fast mode
        fastSimulationLoop();
    }
};
console.log('Call toggleSimSync() in console to switch between synced/fast simulation');

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

function logStats() {
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
}

// Fast simulation loop (runs as fast as possible via setTimeout)
function fastSimulationLoop() {
    if (SYNC_SIM_WITH_RENDER) return; // Stop if switched to sync mode
    
    for (let i = 0; i < SIM_BATCH_SIZE; i++) {
        simulationStep();
    }
    
    logStats();
    
    setTimeout(fastSimulationLoop, 0);
}

// ============================================================================
// Render Loop (also runs synced simulation if enabled)
// ============================================================================

function renderLoop() {
    // Run simulation step if synced mode
    if (SYNC_SIM_WITH_RENDER) {
        simulationStep();
        logStats();
    }
    
    // Render
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);

    renderShader.use();
    renderShader.setTexture('u_state', grid.getReadTexture(), 0);
    renderShader.setVec2('u_resolution', GRID_SIZE, GRID_SIZE);
    renderShader.dispatch();

    renderFrameCount++;
    requestAnimationFrame(renderLoop);
}

// Start render loop (simulation runs here if synced, or separately if fast)
requestAnimationFrame(renderLoop);

// If starting in fast mode, kick off the fast loop
if (!SYNC_SIM_WITH_RENDER) {
    fastSimulationLoop();
}
