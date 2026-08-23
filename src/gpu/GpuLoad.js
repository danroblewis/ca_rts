import { GPU } from './GPU.js';
import { ComputePipeline } from './ComputePipeline.js';
import { loadShader } from '../shaders/load.js';

const THREADS = 64 * 1024;

/**
 * GpuLoad - synthetic per-frame GPU work to simulate a slow GPU.
 *
 * `iterations` is the per-thread loop count of a 65k-thread dispatch; 0
 * disables it. Exposed as ?gpuload=N and window.setGpuLoad(N) for tests.
 */
export class GpuLoad {
    static async create() {
        const src = await loadShader('./src/shaders/gpu_load.wgsl');
        return new GpuLoad(new ComputePipeline(src, { label: 'GPU load' }));
    }

    constructor(pipeline) {
        const gpu = GPU.get();
        this.pipeline = pipeline;
        this.iterations = 0;
        this.frame = 0;
        this.uniform = gpu.createUniformBuffer(16, 'GPU load params');
        this.sink = gpu.device.createBuffer({ size: 1024 * 4, usage: GPUBufferUsage.STORAGE, label: 'GPU load sink' });
        this.bindGroup = this.pipeline.createBindGroup([
            { binding: 0, resource: { buffer: this.uniform } },
            { binding: 1, resource: { buffer: this.sink } }
        ]);
        this.data = new Uint32Array(4);
    }

    setIterations(n) {
        this.iterations = Math.max(0, Math.floor(n) || 0);
    }

    /** Record this frame's load (no-op when iterations is 0). */
    encode(encoder) {
        if (this.iterations <= 0) return false;
        this.data[0] = this.iterations;
        this.data[1] = this.frame++;
        GPU.get().writeBuffer(this.uniform, this.data);
        this.pipeline.dispatch(this.bindGroup, THREADS / 64, 1, 1, encoder);
        return true;
    }

    run() {
        if (this.iterations <= 0) return;
        const gpu = GPU.get();
        const encoder = gpu.createCommandEncoder('GPU load');
        this.encode(encoder);
        gpu.submit([encoder.finish()]);
    }
}
