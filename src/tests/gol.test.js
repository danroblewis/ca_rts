/**
 * Game of Life Cellular Automata Tests - WebGPU version
 */

import { GPU } from '../gpu/GPU.js';
import { PingPongBuffer } from '../gpu/PingPongBuffer.js';
import { ComputePipeline } from '../gpu/ComputePipeline.js';
import { runTest, assert, logSection } from './framework.js';

// Game of Life shader (WGSL compute)
const GOL_SHADER_SOURCE = `
struct Params {
    resolution: vec2f,
}

@group(0) @binding(0) var u_state: texture_2d<f32>;
@group(0) @binding(1) var u_output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let pos = vec2i(gid.xy);
    if (pos.x >= i32(params.resolution.x) || pos.y >= i32(params.resolution.y)) { return; }

    let self_val = textureLoad(u_state, pos, 0).r;

    var neighbors: f32 = 0.0;
    for (var dy: i32 = -1; dy <= 1; dy++) {
        for (var dx: i32 = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) { continue; }
            let np = pos + vec2i(dx, dy);
            if (np.x >= 0 && np.x < i32(params.resolution.x) &&
                np.y >= 0 && np.y < i32(params.resolution.y)) {
                neighbors += textureLoad(u_state, np, 0).r;
            }
        }
    }

    var alive: f32 = 0.0;
    if (self_val > 0.5) {
        if (neighbors >= 2.0 && neighbors <= 3.0) {
            alive = 1.0;
        }
    } else {
        if (neighbors >= 2.5 && neighbors <= 3.5) {
            alive = 1.0;
        }
    }

    textureStore(u_output, pos, vec4f(alive, 0.0, 0.0, 1.0));
}
`;

// Shared shader instance (compiled once, reused across all tests)
let sharedPipeline = null;
let sharedUniformBuffer = null;

function initSharedPipeline() {
    if (!sharedPipeline) {
        sharedPipeline = new ComputePipeline(GOL_SHADER_SOURCE, { label: 'GOL' });
        sharedUniformBuffer = GPU.get().createUniformBuffer(16);
    }
    return sharedPipeline;
}

// Helper: create a GOL simulation (uses shared pipeline)
function createGOLSimulation(width, height) {
    const gpu = GPU.get();
    const buffer = new PingPongBuffer(width, height, { format: 'float' });

    return {
        buffer,
        setCell(data, x, y, alive) {
            const idx = (y * width + x) * 4;
            data[idx] = alive ? 1.0 : 0.0;
        },
        getCell(data, x, y) {
            const idx = (y * width + x) * 4;
            return data[idx] > 0.5 ? 1 : 0;
        },
        step() {
            gpu.writeBuffer(sharedUniformBuffer, new Float32Array([width, height, 0, 0]));
            const bindGroup = sharedPipeline.createBindGroup([
                { binding: 0, resource: buffer.getReadTexture().view },
                { binding: 1, resource: buffer.getWriteTexture().view },
                { binding: 2, resource: { buffer: sharedUniformBuffer } }
            ]);
            const workgroupsX = Math.ceil(width / 8);
            const workgroupsY = Math.ceil(height / 8);
            sharedPipeline.dispatch(bindGroup, workgroupsX, workgroupsY);
            buffer.swap();
        },
        upload(data) {
            buffer.upload(data);
        },
        async download() {
            return buffer.download();
        },
        destroy() {
            buffer.destroy();
        }
    };
}

export async function runGOLTests() {
    // Initialize shared pipeline once for all GOL tests
    initSharedPipeline();

    logSection('Game of Life');

    await runTest('GOL: isolated cell dies (underpopulation)', async () => {
        const sim = createGOLSimulation(5, 5);
        const data = new Float32Array(5 * 5 * 4);

        sim.setCell(data, 2, 2, 1);
        sim.upload(data);

        sim.step();
        const result = await sim.download();

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
        const result = await sim.download();

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
        const result = await sim.download();

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
        const result = await sim.download();

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
        const result = await sim.download();

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
        const result = await sim.download();

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
        const result = await sim.download();

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
        let result = await sim.download();

        assert(sim.getCell(result, 2, 1) === 1, 'Blinker step 1: (2,1) should be alive');
        assert(sim.getCell(result, 2, 2) === 1, 'Blinker step 1: (2,2) should be alive');
        assert(sim.getCell(result, 2, 3) === 1, 'Blinker step 1: (2,3) should be alive');
        assert(sim.getCell(result, 1, 2) === 0, 'Blinker step 1: (1,2) should be dead');
        assert(sim.getCell(result, 3, 2) === 0, 'Blinker step 1: (3,2) should be dead');

        sim.step();
        result = await sim.download();

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
        const result = await sim.download();

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
        const result = await sim.download();

        assert(sim.getCell(result, 2, 2) === 1, 'Beehive: (2,2) should be alive');
        assert(sim.getCell(result, 3, 2) === 1, 'Beehive: (3,2) should be alive');
        assert(sim.getCell(result, 1, 3) === 1, 'Beehive: (1,3) should be alive');
        assert(sim.getCell(result, 4, 3) === 1, 'Beehive: (4,3) should be alive');
        assert(sim.getCell(result, 2, 4) === 1, 'Beehive: (2,4) should be alive');
        assert(sim.getCell(result, 3, 4) === 1, 'Beehive: (3,4) should be alive');

        sim.destroy();
    });
}
