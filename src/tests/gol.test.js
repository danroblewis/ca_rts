/**
 * Game of Life Cellular Automata Tests
 */

import { PingPongBuffer } from '../gpu/PingPongBuffer.js';
import { ComputeShader } from '../gpu/ComputeShader.js';
import { runTest, assert, logSection } from './framework.js';

// Game of Life shader
const GOL_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_state;
uniform vec2 u_resolution;

in vec2 v_uv;
out vec4 fragColor;

void main() {
    vec2 texelSize = 1.0 / u_resolution;
    
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
    
    float alive = 0.0;
    if (self > 0.5) {
        if (neighbors >= 2.0 && neighbors <= 3.0) {
            alive = 1.0;
        }
    } else {
        if (neighbors >= 2.5 && neighbors <= 3.5) {
            alive = 1.0;
        }
    }
    
    fragColor = vec4(alive, 0.0, 0.0, 1.0);
}
`;

// Helper: create a GOL simulation
function createGOLSimulation(width, height) {
    const buffer = new PingPongBuffer(width, height, { format: 'float' });
    const shader = new ComputeShader(GOL_SHADER_SOURCE);
    
    return {
        buffer,
        shader,
        setCell(data, x, y, alive) {
            const idx = (y * width + x) * 4;
            data[idx] = alive ? 1.0 : 0.0;
        },
        getCell(data, x, y) {
            const idx = (y * width + x) * 4;
            return data[idx] > 0.5 ? 1 : 0;
        },
        step() {
            buffer.getWriteFramebuffer().bind();
            shader.use();
            shader.setTexture('u_state', buffer.getReadTexture(), 0);
            shader.setVec2('u_resolution', width, height);
            shader.dispatch();
            buffer.getWriteFramebuffer().unbind();
            buffer.swap();
        },
        upload(data) {
            buffer.upload(data);
        },
        download() {
            return buffer.download();
        },
        destroy() {
            buffer.destroy();
            shader.destroy();
        }
    };
}

export async function runGOLTests() {
    logSection('Game of Life');

    await runTest('GOL: isolated cell dies (underpopulation)', async () => {
        const sim = createGOLSimulation(5, 5);
        const data = new Float32Array(5 * 5 * 4);
        
        sim.setCell(data, 2, 2, 1);
        sim.upload(data);
        
        sim.step();
        const result = sim.download();
        
        assert(sim.getCell(result, 2, 2) === 0, 'Isolated cell should die');
        
        sim.destroy();
    });

    await runTest('GOL: cell with 1 neighbor dies (underpopulation)', async () => {
        const sim = createGOLSimulation(5, 5);
        const data = new Float32Array(5 * 5 * 4);
        
        sim.setCell(data, 2, 2, 1);
        sim.setCell(data, 3, 2, 1);
        sim.upload(data);
        
        sim.step();
        const result = sim.download();
        
        assert(sim.getCell(result, 2, 2) === 0, 'Cell with 1 neighbor should die');
        assert(sim.getCell(result, 3, 2) === 0, 'Cell with 1 neighbor should die');
        
        sim.destroy();
    });

    await runTest('GOL: cell with 4+ neighbors dies (overpopulation)', async () => {
        const sim = createGOLSimulation(5, 5);
        const data = new Float32Array(5 * 5 * 4);
        
        sim.setCell(data, 2, 2, 1);
        sim.setCell(data, 1, 2, 1);
        sim.setCell(data, 3, 2, 1);
        sim.setCell(data, 2, 1, 1);
        sim.setCell(data, 2, 3, 1);
        sim.upload(data);
        
        sim.step();
        const result = sim.download();
        
        assert(sim.getCell(result, 2, 2) === 0, 'Cell with 4 neighbors should die');
        
        sim.destroy();
    });

    await runTest('GOL: cell with 2 neighbors survives', async () => {
        const sim = createGOLSimulation(5, 5);
        const data = new Float32Array(5 * 5 * 4);
        
        sim.setCell(data, 1, 2, 1);
        sim.setCell(data, 2, 2, 1);
        sim.setCell(data, 3, 2, 1);
        sim.upload(data);
        
        sim.step();
        const result = sim.download();
        
        assert(sim.getCell(result, 2, 2) === 1, 'Cell with 2 neighbors should survive');
        
        sim.destroy();
    });

    await runTest('GOL: cell with 3 neighbors survives', async () => {
        const sim = createGOLSimulation(5, 5);
        const data = new Float32Array(5 * 5 * 4);
        
        sim.setCell(data, 2, 2, 1);
        sim.setCell(data, 1, 2, 1);
        sim.setCell(data, 3, 2, 1);
        sim.setCell(data, 2, 3, 1);
        sim.upload(data);
        
        sim.step();
        const result = sim.download();
        
        assert(sim.getCell(result, 2, 2) === 1, 'Cell with 3 neighbors should survive');
        
        sim.destroy();
    });

    await runTest('GOL: dead cell with 3 neighbors becomes alive (birth)', async () => {
        const sim = createGOLSimulation(5, 5);
        const data = new Float32Array(5 * 5 * 4);
        
        sim.setCell(data, 1, 2, 1);
        sim.setCell(data, 3, 2, 1);
        sim.setCell(data, 2, 3, 1);
        sim.upload(data);
        
        sim.step();
        const result = sim.download();
        
        assert(sim.getCell(result, 2, 2) === 1, 'Dead cell with 3 neighbors should be born');
        
        sim.destroy();
    });

    await runTest('GOL: dead cell with 2 neighbors stays dead', async () => {
        const sim = createGOLSimulation(5, 5);
        const data = new Float32Array(5 * 5 * 4);
        
        sim.setCell(data, 1, 1, 1);
        sim.setCell(data, 3, 3, 1);
        sim.upload(data);
        
        sim.step();
        const result = sim.download();
        
        assert(sim.getCell(result, 2, 2) === 0, 'Dead cell with 2 neighbors should stay dead');
        
        sim.destroy();
    });

    await runTest('GOL: blinker oscillates (period 2)', async () => {
        const sim = createGOLSimulation(5, 5);
        const data = new Float32Array(5 * 5 * 4);
        
        sim.setCell(data, 1, 2, 1);
        sim.setCell(data, 2, 2, 1);
        sim.setCell(data, 3, 2, 1);
        sim.upload(data);
        
        sim.step();
        let result = sim.download();
        
        assert(sim.getCell(result, 2, 1) === 1, 'Blinker step 1: (2,1) should be alive');
        assert(sim.getCell(result, 2, 2) === 1, 'Blinker step 1: (2,2) should be alive');
        assert(sim.getCell(result, 2, 3) === 1, 'Blinker step 1: (2,3) should be alive');
        assert(sim.getCell(result, 1, 2) === 0, 'Blinker step 1: (1,2) should be dead');
        assert(sim.getCell(result, 3, 2) === 0, 'Blinker step 1: (3,2) should be dead');
        
        sim.step();
        result = sim.download();
        
        assert(sim.getCell(result, 1, 2) === 1, 'Blinker step 2: (1,2) should be alive');
        assert(sim.getCell(result, 2, 2) === 1, 'Blinker step 2: (2,2) should be alive');
        assert(sim.getCell(result, 3, 2) === 1, 'Blinker step 2: (3,2) should be alive');
        assert(sim.getCell(result, 2, 1) === 0, 'Blinker step 2: (2,1) should be dead');
        assert(sim.getCell(result, 2, 3) === 0, 'Blinker step 2: (2,3) should be dead');
        
        sim.destroy();
    });

    await runTest('GOL: block is stable (still life)', async () => {
        const sim = createGOLSimulation(6, 6);
        const data = new Float32Array(6 * 6 * 4);
        
        sim.setCell(data, 2, 2, 1);
        sim.setCell(data, 3, 2, 1);
        sim.setCell(data, 2, 3, 1);
        sim.setCell(data, 3, 3, 1);
        sim.upload(data);
        
        for (let i = 0; i < 5; i++) {
            sim.step();
        }
        const result = sim.download();
        
        assert(sim.getCell(result, 2, 2) === 1, 'Block: (2,2) should be alive');
        assert(sim.getCell(result, 3, 2) === 1, 'Block: (3,2) should be alive');
        assert(sim.getCell(result, 2, 3) === 1, 'Block: (2,3) should be alive');
        assert(sim.getCell(result, 3, 3) === 1, 'Block: (3,3) should be alive');
        assert(sim.getCell(result, 1, 2) === 0, 'Block: (1,2) should be dead');
        assert(sim.getCell(result, 4, 2) === 0, 'Block: (4,2) should be dead');
        
        sim.destroy();
    });

    await runTest('GOL: beehive is stable (still life)', async () => {
        const sim = createGOLSimulation(7, 7);
        const data = new Float32Array(7 * 7 * 4);
        
        sim.setCell(data, 2, 2, 1);
        sim.setCell(data, 3, 2, 1);
        sim.setCell(data, 1, 3, 1);
        sim.setCell(data, 4, 3, 1);
        sim.setCell(data, 2, 4, 1);
        sim.setCell(data, 3, 4, 1);
        sim.upload(data);
        
        for (let i = 0; i < 5; i++) {
            sim.step();
        }
        const result = sim.download();
        
        assert(sim.getCell(result, 2, 2) === 1, 'Beehive: (2,2) should be alive');
        assert(sim.getCell(result, 3, 2) === 1, 'Beehive: (3,2) should be alive');
        assert(sim.getCell(result, 1, 3) === 1, 'Beehive: (1,3) should be alive');
        assert(sim.getCell(result, 4, 3) === 1, 'Beehive: (4,3) should be alive');
        assert(sim.getCell(result, 2, 4) === 1, 'Beehive: (2,4) should be alive');
        assert(sim.getCell(result, 3, 4) === 1, 'Beehive: (3,4) should be alive');
        
        sim.destroy();
    });
}
