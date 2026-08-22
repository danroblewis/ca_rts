// Simulation prepass - per-cell intent + per-block activity mask
//
// Runs before mining_game.wgsl each tick. See core/intent.wgsl for the
// encoding. Everything computed here is a pure function of the current state,
// so the main pass produces results identical to evaluating it inline.

#include "./core/types.wgsl"
#include "./core/traits.wgsl"
#include "./core/intent.wgsl"
#include "./traits/memory.wgsl"
#include "./traits/movement.wgsl"
#include "./traits/resource_movement.wgsl"

@group(0) @binding(0) var u_state: texture_2d<f32>;
@group(0) @binding(1) var u_intent: texture_storage_2d<r32uint, write>;
@group(0) @binding(2) var<uniform> params: SimParams;
@group(0) @binding(3) var<storage, read_write> u_mask: array<u32>;
@group(0) @binding(4) var<storage, read_write> u_hash: array<u32>;

struct SimParams {
    resolution: vec2f,
    time: f32,
    flags: f32,
}

var<workgroup> wg_mask: atomic<u32>;
var<workgroup> wg_hash: atomic<u32>;

// Order-independent per-cell hash (summed per block with wrapping adds), used
// by peers to detect simulation divergence. Includes the position so that
// swapped cells change the hash.
fn cellHash(pos: vec2u, raw: vec4f) -> u32 {
    var h: u32 = (pos.x * 0x9E3779B1u) ^ (pos.y * 0x85EBCA77u) ^ 0x27D4EB2Fu;
    h = (h ^ bitcast<u32>(raw.r)) * 0xC2B2AE3Du; h ^= h >> 15u;
    h = (h ^ bitcast<u32>(raw.g)) * 0x165667B1u; h ^= h >> 13u;
    h = (h ^ bitcast<u32>(raw.b)) * 0xD3A2646Cu; h ^= h >> 16u;
    h = (h ^ bitcast<u32>(raw.a)) * 0x9E3779B1u; h ^= h >> 15u;
    return h;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u,
        @builtin(local_invocation_index) lid: u32,
        @builtin(workgroup_id) wid: vec3u) {
    if (lid == 0u) {
        atomicStore(&wg_mask, 0u);
        atomicStore(&wg_hash, 0u);
    }
    workgroupBarrier();

    let pos: vec2i = vec2i(gid.xy);
    let inBounds: bool = pos.x < i32(params.resolution.x) && pos.y < i32(params.resolution.y);

    if (inBounds) {
        let myPos: vec2f = vec2f(f32(pos.x), f32(pos.y));
        let raw: vec4f = textureLoad(u_state, pos, 0);
        let cellType: i32 = getType(raw);

        atomicOr(&wg_mask, 1u << u32(clamp(cellType, 0, 15)));
        atomicAdd(&wg_hash, cellHash(gid.xy, raw));

        var intent: u32 = (u32(clamp(cellType, 0, 15)) << INTENT_TYPE_SHIFT);

        if (isMobile(cellType)) {
            let dir: i32 = getMobileDirection(myPos, raw, params.time, u_state, params.resolution);
            intent |= u32(dir) | INTENT_MOBILE;
            if (isUnit(cellType) && getUnitHolding(raw)) {
                intent |= INTENT_HOLDING;
            }
        } else if (cellType == TYPE_RESOURCE) {
            if (shouldResourceMove(raw, params.time)) {
                let dir: i32 = getResourceDirection(myPos, raw, params.time, u_state, params.resolution);
                if (dir != DIR_NONE) {
                    intent |= u32(dir) | INTENT_RES_MOVES;
                }
            }
        } else if (isFactory(cellType)) {
            if (isFactoryBuilt(getFactoryPos(raw), u_state, params.resolution)) {
                intent |= INTENT_BUILT;
            }
        }

        textureStore(u_intent, pos, vec4u(intent, 0u, 0u, 0u));
    }

    workgroupBarrier();
    if (lid == 0u) {
        let blocksX: u32 = u32(ceil(params.resolution.x / f32(BLOCK_SIZE)));
        u_mask[wid.y * blocksX + wid.x] = atomicLoad(&wg_mask);
        u_hash[wid.y * blocksX + wid.x] = atomicLoad(&wg_hash);
    }
}
