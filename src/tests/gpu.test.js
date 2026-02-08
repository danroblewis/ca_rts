/**
 * GPU Framework Tests - WebGPU version
 */

import { GPU } from '../gpu/GPU.js';
import { DataTexture } from '../gpu/DataTexture.js';
import { PingPongBuffer } from '../gpu/PingPongBuffer.js';
import { ComputePipeline } from '../gpu/ComputePipeline.js';
import { runTest, assert, assertApprox, assertArrayApprox, logSection } from './framework.js';

export async function runGPUTests() {
    logSection('GPU Framework');

    const gpu = GPU.get();

    await runTest('GPU: get() returns the singleton', async () => {
        const g = GPU.get();
        assert(g === gpu, 'GPU.get() should return same instance');
    });

    await runTest('GPU: WebGPU device is valid', async () => {
        assert(gpu.device !== null, 'Should have WebGPU device');
        assert(gpu.context !== null, 'Should have WebGPU context');
    });

    await runTest('DataTexture: create float texture', async () => {
        const tex = new DataTexture(4, 4, { format: 'float' });
        assert(tex.width === 4, 'Width should be 4');
        assert(tex.height === 4, 'Height should be 4');
        assert(tex.format === 'float', 'Format should be float');
        tex.destroy();
    });

    await runTest('DataTexture: create byte texture', async () => {
        const tex = new DataTexture(4, 4, { format: 'byte' });
        assert(tex.format === 'byte', 'Format should be byte');
        tex.destroy();
    });

    await runTest('DataTexture: upload and download preserves float data', async () => {
        const tex = new DataTexture(2, 2, { format: 'float' });

        const input = new Float32Array([
            1.0, 2.0, 3.0, 4.0,   // pixel (0,0)
            5.0, 6.0, 7.0, 8.0,   // pixel (1,0)
            0.5, 0.25, 0.125, 1.0, // pixel (0,1)
            -1.0, -2.0, 0.0, 1.0  // pixel (1,1)
        ]);
        tex.upload(input);

        const output = await tex.download();
        assertArrayApprox(Array.from(output), Array.from(input), 0.001, 'Data mismatch');

        tex.destroy();
    });

    await runTest('PingPongBuffer: swap exchanges read/write', async () => {
        const ppb = new PingPongBuffer(4, 4, { format: 'float' });

        const readBefore = ppb.getReadTexture();
        const writeBefore = ppb.getWriteTexture();

        ppb.swap();

        const readAfter = ppb.getReadTexture();
        const writeAfter = ppb.getWriteTexture();

        assert(readAfter === writeBefore, 'Read should be previous write');
        assert(writeAfter === readBefore, 'Write should be previous read');

        ppb.destroy();
    });

    await runTest('PingPongBuffer: upload and download', async () => {
        const ppb = new PingPongBuffer(2, 2, { format: 'float' });

        const input = new Float32Array([
            1, 0, 0, 1,
            0, 1, 0, 1,
            0, 0, 1, 1,
            1, 1, 1, 1
        ]);
        ppb.upload(input);

        const output = await ppb.download();
        assertArrayApprox(Array.from(output), Array.from(input), 0.001, 'Data mismatch');

        ppb.destroy();
    });

    await runTest('ComputePipeline: compile WGSL shader', async () => {
        const pipeline = new ComputePipeline(`
            @group(0) @binding(0) var u_output: texture_storage_2d<rgba32float, write>;

            @compute @workgroup_size(8, 8, 1)
            fn main(@builtin(global_invocation_id) gid: vec3u) {
                textureStore(u_output, vec2i(gid.xy), vec4f(1.0, 0.0, 0.0, 1.0));
            }
        `, { label: 'Test compile' });
        assert(pipeline.pipeline !== null, 'Pipeline should exist');
        pipeline.destroy();
    });

    await runTest('ComputePipeline: execute fills texture with color', async () => {
        const tex = new DataTexture(2, 2, { format: 'float' });

        const pipeline = new ComputePipeline(`
            @group(0) @binding(0) var u_output: texture_storage_2d<rgba32float, write>;

            @compute @workgroup_size(8, 8, 1)
            fn main(@builtin(global_invocation_id) gid: vec3u) {
                textureStore(u_output, vec2i(gid.xy), vec4f(0.5, 0.25, 0.125, 1.0));
            }
        `, { label: 'Test fill' });

        const bindGroup = pipeline.createBindGroup([
            { binding: 0, resource: tex.view }
        ]);
        pipeline.dispatch(bindGroup, 1, 1);

        const output = await tex.download();

        for (let i = 0; i < 4; i++) {
            assertApprox(output[i * 4 + 0], 0.5, 0.001, `Pixel ${i} R`);
            assertApprox(output[i * 4 + 1], 0.25, 0.001, `Pixel ${i} G`);
            assertApprox(output[i * 4 + 2], 0.125, 0.001, `Pixel ${i} B`);
            assertApprox(output[i * 4 + 3], 1.0, 0.001, `Pixel ${i} A`);
        }

        pipeline.destroy();
        tex.destroy();
    });

    await runTest('ComputePipeline: uniform buffer', async () => {
        const tex = new DataTexture(1, 1, { format: 'float' });

        const pipeline = new ComputePipeline(`
            struct Params {
                value: f32,
            }

            @group(0) @binding(0) var u_output: texture_storage_2d<rgba32float, write>;
            @group(0) @binding(1) var<uniform> params: Params;

            @compute @workgroup_size(1, 1, 1)
            fn main(@builtin(global_invocation_id) gid: vec3u) {
                textureStore(u_output, vec2i(gid.xy), vec4f(params.value, 0.0, 0.0, 1.0));
            }
        `, { label: 'Test uniform' });

        const uniformBuffer = gpu.createUniformBuffer(16);
        gpu.writeBuffer(uniformBuffer, new Float32Array([0.75, 0, 0, 0]));

        const bindGroup = pipeline.createBindGroup([
            { binding: 0, resource: tex.view },
            { binding: 1, resource: { buffer: uniformBuffer } }
        ]);
        pipeline.dispatch(bindGroup, 1, 1);

        const output = await tex.download();
        assertApprox(output[0], 0.75, 0.001, 'Uniform float');

        pipeline.destroy();
        tex.destroy();
    });

    await runTest('ComputePipeline: uniform vec2', async () => {
        const tex = new DataTexture(1, 1, { format: 'float' });

        const pipeline = new ComputePipeline(`
            struct Params {
                vec: vec2f,
            }

            @group(0) @binding(0) var u_output: texture_storage_2d<rgba32float, write>;
            @group(0) @binding(1) var<uniform> params: Params;

            @compute @workgroup_size(1, 1, 1)
            fn main(@builtin(global_invocation_id) gid: vec3u) {
                textureStore(u_output, vec2i(gid.xy), vec4f(params.vec, 0.0, 1.0));
            }
        `, { label: 'Test uniform vec2' });

        const uniformBuffer = gpu.createUniformBuffer(16);
        gpu.writeBuffer(uniformBuffer, new Float32Array([0.3, 0.7, 0, 0]));

        const bindGroup = pipeline.createBindGroup([
            { binding: 0, resource: tex.view },
            { binding: 1, resource: { buffer: uniformBuffer } }
        ]);
        pipeline.dispatch(bindGroup, 1, 1);

        const output = await tex.download();
        assertApprox(output[0], 0.3, 0.001, 'Vec2 x');
        assertApprox(output[1], 0.7, 0.001, 'Vec2 y');

        pipeline.destroy();
        tex.destroy();
    });

    await runTest('ComputePipeline: texture reading', async () => {
        const srcTex = new DataTexture(2, 2, { format: 'float' });
        srcTex.upload(new Float32Array([
            1, 2, 3, 4,
            5, 6, 7, 8,
            9, 10, 11, 12,
            13, 14, 15, 16
        ]));

        const dstTex = new DataTexture(2, 2, { format: 'float' });

        const pipeline = new ComputePipeline(`
            @group(0) @binding(0) var u_src: texture_2d<f32>;
            @group(0) @binding(1) var u_output: texture_storage_2d<rgba32float, write>;

            @compute @workgroup_size(8, 8, 1)
            fn main(@builtin(global_invocation_id) gid: vec3u) {
                let pos = vec2i(gid.xy);
                let val = textureLoad(u_src, pos, 0);
                textureStore(u_output, pos, val);
            }
        `, { label: 'Test texture read' });

        const bindGroup = pipeline.createBindGroup([
            { binding: 0, resource: srcTex.view },
            { binding: 1, resource: dstTex.view }
        ]);
        pipeline.dispatch(bindGroup, 1, 1);

        const output = await dstTex.download();

        assertApprox(output[0], 1, 0.001, 'Pixel 0 R');
        assertApprox(output[4], 5, 0.001, 'Pixel 1 R');

        pipeline.destroy();
        srcTex.destroy();
        dstTex.destroy();
    });

    await runTest('ComputePipeline: CA-style neighbor sampling', async () => {
        const srcTex = new DataTexture(3, 3, { format: 'float' });
        srcTex.upload(new Float32Array([
            1, 0, 0, 1,  1, 0, 0, 1,  1, 0, 0, 1,
            1, 0, 0, 1,  0, 0, 0, 1,  1, 0, 0, 1,
            1, 0, 0, 1,  1, 0, 0, 1,  1, 0, 0, 1,
        ]));

        const dstTex = new DataTexture(3, 3, { format: 'float' });

        const pipeline = new ComputePipeline(`
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

                var sum: f32 = 0.0;
                for (var dy: i32 = -1; dy <= 1; dy++) {
                    for (var dx: i32 = -1; dx <= 1; dx++) {
                        if (dx == 0 && dy == 0) { continue; }
                        let neighbor = pos + vec2i(dx, dy);
                        if (neighbor.x >= 0 && neighbor.x < i32(params.resolution.x) &&
                            neighbor.y >= 0 && neighbor.y < i32(params.resolution.y)) {
                            sum += textureLoad(u_state, neighbor, 0).r;
                        }
                    }
                }
                textureStore(u_output, pos, vec4f(sum, 0.0, 0.0, 1.0));
            }
        `, { label: 'Test neighbor sampling' });

        const uniformBuffer = gpu.createUniformBuffer(16);
        gpu.writeBuffer(uniformBuffer, new Float32Array([3, 3, 0, 0]));

        const bindGroup = pipeline.createBindGroup([
            { binding: 0, resource: srcTex.view },
            { binding: 1, resource: dstTex.view },
            { binding: 2, resource: { buffer: uniformBuffer } }
        ]);
        pipeline.dispatch(bindGroup, 1, 1);

        const output = await dstTex.download();

        assertApprox(output[4 * 4], 8.0, 0.001, 'Center cell neighbor sum');

        pipeline.destroy();
        srcTex.destroy();
        dstTex.destroy();
    });
}
