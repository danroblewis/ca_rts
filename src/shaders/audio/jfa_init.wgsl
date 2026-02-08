/**
 * JFA Initialization - Label each resource cell with its own coordinates
 *
 * Output:
 *   RG: Label coordinates (x, y) - or (-1, -1) if not a resource
 *   B: 1.0 if resource, 0.0 otherwise
 *   A: Resource amount (for potential weighting)
 */

struct Params {
    resolution: vec2f,
}

// Cell type constants (must match game)
const JFA_CELL_RESOURCE: f32 = 1.0;

@group(0) @binding(0) var u_state: texture_2d<f32>;
@group(0) @binding(1) var u_output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var u_sampler: sampler;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let pos: vec2i = vec2i(gid.xy);
    if (pos.x >= i32(params.resolution.x) || pos.y >= i32(params.resolution.y)) { return; }

    let posF: vec2f = vec2f(f32(pos.x), f32(pos.y));
    let cell: vec4f = textureSampleLevel(u_state, u_sampler, (posF + 0.5) / params.resolution, 0.0);
    let cellType: f32 = floor(cell.r + 0.5);

    var result: vec4f;
    if (cellType == JFA_CELL_RESOURCE) {
        // Resource cell: label = own position
        result = vec4f(posF.x, posF.y, 1.0, cell.g);
    } else {
        // Non-resource: invalid label
        result = vec4f(-1.0, -1.0, 0.0, 0.0);
    }
    textureStore(u_output, pos, result);
}
