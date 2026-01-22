import { GPU } from './gpu/GPU.js';
import { PingPongBuffer } from './gpu/PingPongBuffer.js';
import { ComputeShader } from './gpu/ComputeShader.js';
import { loadShader } from './shaders/load.js';

// ============================================================================
// Initialize GPU
// ============================================================================

const canvas = document.getElementById('canvas');
const gpu = GPU.init(canvas);
const gl = gpu.gl;

// Handle window resize
function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
}
window.addEventListener('resize', resize);
resize();

console.log('GPU compute framework initialized');

// ============================================================================
// Load Shaders and Initialize
// ============================================================================

const [golShaderSource, renderShaderSource] = await Promise.all([
    loadShader('./src/shaders/examples/gol/gol.frag.glsl'),
    loadShader('./src/shaders/examples/gol/render.frag.glsl')
]);

// ============================================================================
// Test: Conway's Game of Life
// ============================================================================

const GRID_SIZE = 256;

// Create ping-pong buffer for CA state
const caBuffer = new PingPongBuffer(GRID_SIZE, GRID_SIZE, { format: 'float' });

// Initialize with random data
const initialData = new Float32Array(GRID_SIZE * GRID_SIZE * 4);
for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
    // R channel = alive (0 or 1), GBA = unused
    initialData[i * 4 + 0] = Math.random() > 0.7 ? 1.0 : 0.0;
    initialData[i * 4 + 1] = 0.0;
    initialData[i * 4 + 2] = 0.0;
    initialData[i * 4 + 3] = 1.0;
}
caBuffer.upload(initialData);

// Create shaders from loaded source
const gameOfLifeShader = new ComputeShader(golShaderSource);
const renderShader = new ComputeShader(renderShaderSource);

// ============================================================================
// Main Loop
// ============================================================================

let lastTime = 0;
let tickAccumulator = 0;
const TICK_RATE = 1000 / 20; // 20 ticks per second

function loop(time) {
    const dt = time - lastTime;
    lastTime = time;
    tickAccumulator += dt;

    // Run CA simulation at fixed tick rate
    while (tickAccumulator >= TICK_RATE) {
        tickAccumulator -= TICK_RATE;

        // Bind write framebuffer
        caBuffer.getWriteFramebuffer().bind();

        // Run Game of Life shader
        gameOfLifeShader.use();
        gameOfLifeShader.setTexture('u_state', caBuffer.getReadTexture(), 0);
        gameOfLifeShader.setVec2('u_resolution', GRID_SIZE, GRID_SIZE);
        gameOfLifeShader.dispatch();

        // Swap buffers
        caBuffer.swap();
    }

    // Render to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);

    renderShader.use();
    renderShader.setTexture('u_state', caBuffer.getReadTexture(), 0);
    renderShader.dispatch();

    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
console.log('Game of Life simulation started');
