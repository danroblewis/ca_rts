import { GPU } from './gpu/GPU.js';
import { ComputeShader } from './gpu/ComputeShader.js';
import { loadShader } from './shaders/load.js';
import { CAGrid } from './ca/CAGrid.js';
import { CELL_EMPTY, CELL_RESOURCE, CELL_UNIT, CELL_OBSTACLE } from './ca/CellTypes.js';

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
    loadShader('./src/shaders/ca/unit_walk.frag.glsl'),
    loadShader('./src/shaders/ca/render.frag.glsl')
]);

const simShader = new ComputeShader(simShaderSource);
const renderShader = new ComputeShader(renderShaderSource);

// ============================================================================
// Initialize World
// ============================================================================

const GRID_SIZE = 256;
const grid = new CAGrid(GRID_SIZE, GRID_SIZE);

// Initialize the world
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

// Create border of obstacles
for (let x = 0; x < GRID_SIZE; x++) {
    setCell(x, 0, CELL_OBSTACLE);
    setCell(x, GRID_SIZE - 1, CELL_OBSTACLE);
}
for (let y = 0; y < GRID_SIZE; y++) {
    setCell(0, y, CELL_OBSTACLE);
    setCell(GRID_SIZE - 1, y, CELL_OBSTACLE);
}

// Scatter some resources
for (let i = 0; i < 500; i++) {
    const x = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;
    const y = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;
    setCell(x, y, CELL_RESOURCE, 1.0); // amount = 1.0
}

// Scatter some units
for (let i = 0; i < 200; i++) {
    const x = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;
    const y = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;
    setCell(x, y, CELL_UNIT, 0, 0, 0); // dirX=0, dirY=0, team=0
}

grid.upload(data);

// ============================================================================
// Simulation Loop
// ============================================================================

let simStepCount = 0;
let renderFrameCount = 0;
let lastLogTime = performance.now();
let simTime = 0; // Time seed for randomness
const LOG_INTERVAL = 1000;
const SIM_BATCH_SIZE = 1;

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
        console.log(`Sim: ${simFps.toFixed(0)} steps/sec | Render: ${renderFps.toFixed(0)} fps`);
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
    renderShader.dispatch();

    renderFrameCount++;
    requestAnimationFrame(renderLoop);
}

requestAnimationFrame(renderLoop);

console.log('CA simulation started');
console.log(`Grid: ${GRID_SIZE}x${GRID_SIZE}, Units: 200, Resources: 500`);
