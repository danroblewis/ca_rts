import { GPU } from './gpu/GPU.js';
import { PingPongBuffer } from './gpu/PingPongBuffer.js';
import { ComputeShader } from './gpu/ComputeShader.js';

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
// Test: Conway's Game of Life
// This tests the entire GPU compute pipeline
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

// Game of Life compute shader
const gameOfLifeShader = new ComputeShader(`#version 300 es
precision highp float;

uniform sampler2D u_state;
uniform vec2 u_resolution;

in vec2 v_uv;
out vec4 fragColor;

void main() {
    vec2 texelSize = 1.0 / u_resolution;
    
    // Sample current cell and 8 neighbors
    float self = texture(u_state, v_uv).r;
    
    float neighbors = 0.0;
    neighbors += texture(u_state, v_uv + vec2(-1, -1) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2( 0, -1) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2( 1, -1) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2(-1,  0) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2( 1,  0) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2(-1,  1) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2( 0,  1) * texelSize).r;
    neighbors += texture(u_state, v_uv + vec2( 1,  1) * texelSize).r;
    
    // Conway's rules:
    // - Alive cell with 2 or 3 neighbors survives
    // - Dead cell with exactly 3 neighbors becomes alive
    float alive = 0.0;
    if (self > 0.5) {
        // Currently alive
        if (neighbors >= 2.0 && neighbors <= 3.0) {
            alive = 1.0;
        }
    } else {
        // Currently dead
        if (neighbors >= 2.5 && neighbors <= 3.5) {
            alive = 1.0;
        }
    }
    
    fragColor = vec4(alive, 0.0, 0.0, 1.0);
}
`);

// Render shader (displays the CA state to screen)
const renderShader = new ComputeShader(`#version 300 es
precision highp float;

uniform sampler2D u_state;

in vec2 v_uv;
out vec4 fragColor;

void main() {
    float alive = texture(u_state, v_uv).r;
    
    // Dark blue background, bright cyan for alive cells
    vec3 deadColor = vec3(0.05, 0.08, 0.12);
    vec3 aliveColor = vec3(0.2, 0.8, 0.9);
    
    vec3 color = mix(deadColor, aliveColor, alive);
    fragColor = vec4(color, 1.0);
}
`);

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
