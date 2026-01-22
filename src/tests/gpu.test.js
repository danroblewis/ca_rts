/**
 * GPU Framework Tests
 */

import { GPU } from '../gpu/GPU.js';
import { DataTexture } from '../gpu/DataTexture.js';
import { Framebuffer } from '../gpu/Framebuffer.js';
import { PingPongBuffer } from '../gpu/PingPongBuffer.js';
import { ComputeShader } from '../gpu/ComputeShader.js';
import { runTest, assert, assertApprox, assertArrayApprox, logSection } from './framework.js';

export async function runGPUTests() {
    logSection('GPU Framework');

    const canvas = document.getElementById('canvas');
    const gpu = GPU.get();

    await runTest('GPU: singleton pattern prevents double init', async () => {
        let threw = false;
        try {
            GPU.init(canvas);
        } catch (e) {
            threw = true;
        }
        assert(threw, 'GPU.init() should throw on second call');
    });

    await runTest('GPU: get() returns the singleton', async () => {
        const g = GPU.get();
        assert(g === gpu, 'GPU.get() should return same instance');
    });

    await runTest('GPU: WebGL2 context is valid', async () => {
        assert(gpu.gl instanceof WebGL2RenderingContext, 'Should have WebGL2 context');
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
        const fb = new Framebuffer(tex);
        
        const input = new Float32Array([
            1.0, 2.0, 3.0, 4.0,   // pixel (0,0)
            5.0, 6.0, 7.0, 8.0,   // pixel (1,0)
            0.5, 0.25, 0.125, 1.0, // pixel (0,1)
            -1.0, -2.0, 0.0, 1.0  // pixel (1,1)
        ]);
        tex.upload(input);
        
        const output = tex.download(fb.framebuffer);
        assertArrayApprox(Array.from(output), Array.from(input), 0.001, 'Data mismatch');
        
        tex.destroy();
        fb.destroy();
    });

    await runTest('Framebuffer: attach texture and bind', async () => {
        const tex = new DataTexture(8, 8, { format: 'float' });
        const fb = new Framebuffer(tex);
        
        fb.bind();
        const gl = gpu.gl;
        const bound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        assert(bound === fb.framebuffer, 'Framebuffer should be bound');
        
        fb.unbind();
        const unbound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        assert(unbound === null, 'Framebuffer should be unbound');
        
        tex.destroy();
        fb.destroy();
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
        
        const output = ppb.download();
        assertArrayApprox(Array.from(output), Array.from(input), 0.001, 'Data mismatch');
        
        ppb.destroy();
    });

    await runTest('ComputeShader: compile and link', async () => {
        const shader = new ComputeShader(`#version 300 es
            precision highp float;
            out vec4 fragColor;
            void main() {
                fragColor = vec4(1.0, 0.0, 0.0, 1.0);
            }
        `);
        assert(shader.program !== null, 'Program should exist');
        shader.destroy();
    });

    await runTest('ComputeShader: execute fills texture with color', async () => {
        const tex = new DataTexture(2, 2, { format: 'float' });
        const fb = new Framebuffer(tex);
        
        const shader = new ComputeShader(`#version 300 es
            precision highp float;
            out vec4 fragColor;
            void main() {
                fragColor = vec4(0.5, 0.25, 0.125, 1.0);
            }
        `);
        
        fb.bind();
        shader.use();
        shader.dispatch();
        fb.unbind();
        
        const output = tex.download(fb.framebuffer);
        
        for (let i = 0; i < 4; i++) {
            assertApprox(output[i * 4 + 0], 0.5, 0.001, `Pixel ${i} R`);
            assertApprox(output[i * 4 + 1], 0.25, 0.001, `Pixel ${i} G`);
            assertApprox(output[i * 4 + 2], 0.125, 0.001, `Pixel ${i} B`);
            assertApprox(output[i * 4 + 3], 1.0, 0.001, `Pixel ${i} A`);
        }
        
        shader.destroy();
        tex.destroy();
        fb.destroy();
    });

    await runTest('ComputeShader: uniform float', async () => {
        const tex = new DataTexture(1, 1, { format: 'float' });
        const fb = new Framebuffer(tex);
        
        const shader = new ComputeShader(`#version 300 es
            precision highp float;
            uniform float u_value;
            out vec4 fragColor;
            void main() {
                fragColor = vec4(u_value, 0.0, 0.0, 1.0);
            }
        `);
        
        fb.bind();
        shader.use();
        shader.setFloat('u_value', 0.75);
        shader.dispatch();
        fb.unbind();
        
        const output = tex.download(fb.framebuffer);
        assertApprox(output[0], 0.75, 0.001, 'Uniform float');
        
        shader.destroy();
        tex.destroy();
        fb.destroy();
    });

    await runTest('ComputeShader: uniform vec2', async () => {
        const tex = new DataTexture(1, 1, { format: 'float' });
        const fb = new Framebuffer(tex);
        
        const shader = new ComputeShader(`#version 300 es
            precision highp float;
            uniform vec2 u_vec;
            out vec4 fragColor;
            void main() {
                fragColor = vec4(u_vec, 0.0, 1.0);
            }
        `);
        
        fb.bind();
        shader.use();
        shader.setVec2('u_vec', 0.3, 0.7);
        shader.dispatch();
        fb.unbind();
        
        const output = tex.download(fb.framebuffer);
        assertApprox(output[0], 0.3, 0.001, 'Vec2 x');
        assertApprox(output[1], 0.7, 0.001, 'Vec2 y');
        
        shader.destroy();
        tex.destroy();
        fb.destroy();
    });

    await runTest('ComputeShader: texture sampling', async () => {
        const srcTex = new DataTexture(2, 2, { format: 'float' });
        srcTex.upload(new Float32Array([
            1, 2, 3, 4,
            5, 6, 7, 8,
            9, 10, 11, 12,
            13, 14, 15, 16
        ]));
        
        const dstTex = new DataTexture(2, 2, { format: 'float' });
        const fb = new Framebuffer(dstTex);
        
        const shader = new ComputeShader(`#version 300 es
            precision highp float;
            uniform sampler2D u_src;
            in vec2 v_uv;
            out vec4 fragColor;
            void main() {
                fragColor = texture(u_src, v_uv);
            }
        `);
        
        fb.bind();
        shader.use();
        shader.setTexture('u_src', srcTex, 0);
        shader.dispatch();
        fb.unbind();
        
        const output = dstTex.download(fb.framebuffer);
        
        assertApprox(output[0], 1, 0.001, 'Pixel 0 R');
        assertApprox(output[4], 5, 0.001, 'Pixel 1 R');
        
        shader.destroy();
        srcTex.destroy();
        dstTex.destroy();
        fb.destroy();
    });

    await runTest('ComputeShader: CA-style neighbor sampling', async () => {
        const srcTex = new DataTexture(3, 3, { format: 'float' });
        srcTex.upload(new Float32Array([
            1, 0, 0, 1,  1, 0, 0, 1,  1, 0, 0, 1,
            1, 0, 0, 1,  0, 0, 0, 1,  1, 0, 0, 1,
            1, 0, 0, 1,  1, 0, 0, 1,  1, 0, 0, 1,
        ]));
        
        const dstTex = new DataTexture(3, 3, { format: 'float' });
        const fb = new Framebuffer(dstTex);
        
        const shader = new ComputeShader(`#version 300 es
            precision highp float;
            uniform sampler2D u_state;
            uniform vec2 u_resolution;
            in vec2 v_uv;
            out vec4 fragColor;
            
            void main() {
                vec2 texel = 1.0 / u_resolution;
                float sum = 0.0;
                for (int dy = -1; dy <= 1; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        if (dx == 0 && dy == 0) continue;
                        sum += texture(u_state, v_uv + vec2(float(dx), float(dy)) * texel).r;
                    }
                }
                fragColor = vec4(sum, 0.0, 0.0, 1.0);
            }
        `);
        
        fb.bind();
        shader.use();
        shader.setTexture('u_state', srcTex, 0);
        shader.setVec2('u_resolution', 3, 3);
        shader.dispatch();
        fb.unbind();
        
        const output = dstTex.download(fb.framebuffer);
        
        assertApprox(output[4 * 4], 8.0, 0.001, 'Center cell neighbor sum');
        
        shader.destroy();
        srcTex.destroy();
        dstTex.destroy();
        fb.destroy();
    });
}
