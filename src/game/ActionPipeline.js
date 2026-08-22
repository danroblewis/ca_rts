import { GPU } from '../gpu/GPU.js';
import { ComputePipeline } from '../gpu/ComputePipeline.js';
import { loadShader } from '../shaders/load.js';

export const MAX_ACTIONS_PER_TICK = 64;
const ACTION_STRIDE = 8;          // 8 x 4-byte fields
const RING = 32;                  // ticks that can be encoded between submits

const KIND = {
    place_factory: 1,
    demolish: 2,
    unit_command: 3,
    unit_selection: 4,
    clear_selection: 5
};

/**
 * ActionPipeline - applies game actions to the grid on the GPU.
 *
 * See apply_actions.wgsl. Encoding a tick's actions records one compute pass
 * that reads `readTex` and writes `writeTex`; the caller then swaps the grid.
 */
export class ActionPipeline {
    static _pipelineCache = new Map();

    static async loadPipeline(path = './src/shaders/ca/v2/apply_actions.wgsl') {
        let p = ActionPipeline._pipelineCache.get(path);
        if (!p) {
            const src = await loadShader(path);
            p = new ComputePipeline(src, { label: 'Apply actions' });
            ActionPipeline._pipelineCache.set(path, p);
        }
        return p;
    }

    static async create(width, height, options = {}) {
        const pipeline = options.pipeline || await ActionPipeline.loadPipeline(options.path);
        return new ActionPipeline(width, height, pipeline, options);
    }

    constructor(width, height, pipeline, options = {}) {
        const gpu = GPU.get();
        this.width = width;
        this.height = height;
        this.pipeline = pipeline;
        this.deleteRadius = options.deleteRadius ?? 5;
        this.firstFactoryResources = options.firstFactoryResources ?? 50;

        this.slots = [];
        for (let i = 0; i < RING; i++) {
            this.slots.push({
                uniform: gpu.createUniformBuffer(16, `ActionParams ${i}`),
                actions: gpu.device.createBuffer({
                    size: MAX_ACTIONS_PER_TICK * ACTION_STRIDE * 4,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                    label: `Actions ${i}`
                })
            });
        }
        this.slotIndex = 0;
        this.scratch = new ArrayBuffer(MAX_ACTIONS_PER_TICK * ACTION_STRIDE * 4);
        this.scratchU32 = new Uint32Array(this.scratch);
        this.scratchI32 = new Int32Array(this.scratch);
        this.scratchF32 = new Float32Array(this.scratch);
        this.uniformData = new ArrayBuffer(16);
        this.uniformF32 = new Float32Array(this.uniformData);
        this.uniformU32 = new Uint32Array(this.uniformData);
        this._bindGroupCache = new Map();
    }

    /**
     * Encode one action into the scratch buffer at index i.
     * Returns false if the action type is unknown.
     */
    _encodeAction(i, action, playerId) {
        const base = i * ACTION_STRIDE;
        const u = this.scratchU32, s = this.scratchI32, f = this.scratchF32;
        const kind = KIND[action.type];
        if (!kind) return false;
        u[base + 0] = kind;
        u[base + 1] = playerId;
        s[base + 2] = 0; s[base + 3] = 0;
        f[base + 4] = 0; f[base + 5] = 0; f[base + 6] = 0; f[base + 7] = 0;
        switch (action.type) {
            case 'place_factory': {
                s[base + 2] = action.x; s[base + 3] = action.y;
                const total = action.isUnbuilt ? 0 : this.firstFactoryResources;
                f[base + 4] = total / 8.0;
                break;
            }
            case 'demolish':
                s[base + 2] = action.x; s[base + 3] = action.y;
                f[base + 4] = this.deleteRadius;
                break;
            case 'unit_command':
                f[base + 4] = action.destX; f[base + 5] = action.destY;
                break;
            case 'unit_selection': {
                const r = action.region;
                s[base + 2] = r.x1; s[base + 3] = r.y1;
                f[base + 4] = r.x2; f[base + 5] = r.y2;
                break;
            }
            case 'clear_selection':
                break;
        }
        return true;
    }

    _getBindGroup(readTex, writeTex, slot) {
        let byWrite = this._bindGroupCache.get(readTex);
        if (!byWrite) { byWrite = new Map(); this._bindGroupCache.set(readTex, byWrite); }
        let bySlot = byWrite.get(writeTex);
        if (!bySlot) { bySlot = new Array(RING).fill(null); byWrite.set(writeTex, bySlot); }
        if (!bySlot[slot]) {
            const s = this.slots[slot];
            bySlot[slot] = this.pipeline.createBindGroup([
                { binding: 0, resource: readTex.view },
                { binding: 1, resource: writeTex.view },
                { binding: 2, resource: { buffer: s.uniform } },
                { binding: 3, resource: { buffer: s.actions } }
            ]);
        }
        return bySlot[slot];
    }

    /**
     * Record an "apply actions" pass. `actions` is an array of
     * { action, playerId } in application order. Returns the number applied.
     */
    encodeApply(encoder, readTex, writeTex, actions) {
        const gpu = GPU.get();
        let n = 0;
        for (const { action, playerId } of actions) {
            if (n >= MAX_ACTIONS_PER_TICK) {
                console.warn(`[ActionPipeline] more than ${MAX_ACTIONS_PER_TICK} actions in one tick; extra actions dropped`);
                break;
            }
            if (this._encodeAction(n, action, playerId)) n++;
        }
        if (n === 0) return 0;

        const slotIdx = this.slotIndex;
        this.slotIndex = (this.slotIndex + 1) % RING;
        const slot = this.slots[slotIdx];

        gpu.writeBuffer(slot.actions, this.scratchU32.subarray(0, n * ACTION_STRIDE));
        this.uniformF32[0] = this.width;
        this.uniformF32[1] = this.height;
        this.uniformU32[2] = n;
        this.uniformU32[3] = 0;
        gpu.writeBuffer(slot.uniform, this.uniformU32);

        const bindGroup = this._getBindGroup(readTex, writeTex, slotIdx);
        this.pipeline.dispatch(bindGroup, Math.ceil(this.width / 8), Math.ceil(this.height / 8), 1, encoder);
        return n;
    }

    /** Apply immediately (own encoder + submit). */
    apply(readTex, writeTex, actions) {
        const gpu = GPU.get();
        const encoder = gpu.createCommandEncoder('Apply actions');
        const n = this.encodeApply(encoder, readTex, writeTex, actions);
        gpu.submit([encoder.finish()]);
        return n;
    }

    destroy() {
        for (const s of this.slots) { s.uniform.destroy(); s.actions.destroy(); }
        this._bindGroupCache.clear();
    }
}
