/**
 * JFA Step - Propagate labels to neighbors at step distance
 *
 * Each cell looks at 8 neighbors at distance 'stepSize' and adopts
 * a neighbor's label if:
 *   1. The neighbor has a valid label (is/was a resource)
 *   2. Tie-breaker: prefer smaller coordinates (consistent ordering)
 *
 * Run this shader log2(resolution) times with stepSize = resolution/2, resolution/4, ... 1
 */

struct Params {
    resolution: vec2f,
    stepSize: f32,
}

@group(0) @binding(0) var u_labels: texture_2d<f32>;
@group(0) @binding(1) var u_output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var u_sampler: sampler;

// Compare two labels - returns true if a is "better" (smaller coords, or b is invalid)
fn isBetterLabel(a: vec2f, b: vec2f) -> bool {
    // Invalid labels have negative coords
    let aValid: bool = a.x >= 0.0;
    let bValid: bool = b.x >= 0.0;

    if (!aValid && !bValid) { return false; }
    if (aValid && !bValid) { return true; }
    if (!aValid && bValid) { return false; }

    // Both valid: prefer smaller y, then smaller x
    if (a.y < b.y) { return true; }
    if (a.y > b.y) { return false; }
    return a.x < b.x;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let pos: vec2i = vec2i(gid.xy);
    if (pos.x >= i32(params.resolution.x) || pos.y >= i32(params.resolution.y)) { return; }

    let posF: vec2f = vec2f(f32(pos.x), f32(pos.y));
    let current: vec4f = textureSampleLevel(u_labels, u_sampler, (posF + 0.5) / params.resolution, 0.0);

    // If this cell is not a resource (B channel = 0), keep it empty
    if (current.b < 0.5) {
        textureStore(u_output, pos, current);
        return;
    }

    var bestLabel: vec2f = current.rg;
    let isResource: f32 = current.b;
    let resourceAmount: f32 = current.a;

    // Check 8 neighbors at stepSize distance
    for (var dy: f32 = -1.0; dy <= 1.0; dy += 1.0) {
        for (var dx: f32 = -1.0; dx <= 1.0; dx += 1.0) {
            if (dx == 0.0 && dy == 0.0) { continue; }

            let neighborPos: vec2f = posF + vec2f(dx, dy) * params.stepSize;

            // Bounds check
            if (neighborPos.x < 0.0 || neighborPos.x >= params.resolution.x ||
                neighborPos.y < 0.0 || neighborPos.y >= params.resolution.y) {
                continue;
            }

            let neighbor: vec4f = textureSampleLevel(u_labels, u_sampler, (neighborPos + 0.5) / params.resolution, 0.0);

            // Only consider neighbors that are resources
            if (neighbor.b < 0.5) { continue; }

            let neighborLabel: vec2f = neighbor.rg;

            if (isBetterLabel(neighborLabel, bestLabel)) {
                bestLabel = neighborLabel;
            }
        }
    }

    let result: vec4f = vec4f(bestLabel.x, bestLabel.y, isResource, resourceAmount);
    textureStore(u_output, pos, result);
}
