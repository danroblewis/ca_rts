/**
 * JFA Island Count - Reduction shader to count unique islands
 *
 * After JFA completes, each island has exactly ONE "root" cell where label == position.
 * This shader counts those roots via hierarchical reduction.
 *
 * Stage 0 (256x256 -> 16x16): Count roots in each 16x16 region
 * Stage 1 (16x16 -> 1x1): Sum all regions
 */

struct Params {
    inputResolution: vec2f,
    outputResolution: vec2f,
    stage: i32,
}

@group(0) @binding(0) var u_labels: texture_2d<f32>;
@group(0) @binding(1) var u_output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var u_sampler: sampler;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let pos: vec2i = vec2i(gid.xy);
    if (pos.x >= i32(params.outputResolution.x) || pos.y >= i32(params.outputResolution.y)) { return; }

    let outPos: vec2f = vec2f(f32(pos.x), f32(pos.y));
    let regionSize: f32 = params.inputResolution.x / params.outputResolution.x;
    let regionStart: vec2f = outPos * regionSize;

    var count: f32 = 0.0;

    if (params.stage == 0) {
        // Stage 0: Count root cells (label == position) in each region
        for (var dy: f32 = 0.0; dy < regionSize; dy += 1.0) {
            for (var dx: f32 = 0.0; dx < regionSize; dx += 1.0) {
                let worldPos: vec2f = regionStart + vec2f(dx, dy);
                let cell: vec4f = textureSampleLevel(u_labels, u_sampler, (worldPos + 0.5) / params.inputResolution, 0.0);

                // Check if this is a root (label == position AND is resource)
                if (cell.b > 0.5) {  // Is resource
                    let label: vec2f = cell.rg;
                    if (abs(label.x - worldPos.x) < 0.5 && abs(label.y - worldPos.y) < 0.5) {
                        count += 1.0;
                    }
                }
            }
        }
    } else {
        // Stage 1+: Sum counts from previous stage
        for (var dy: f32 = 0.0; dy < regionSize; dy += 1.0) {
            for (var dx: f32 = 0.0; dx < regionSize; dx += 1.0) {
                let samplePos: vec2f = (regionStart + vec2f(dx, dy) + 0.5) / params.inputResolution;
                let prev: vec4f = textureSampleLevel(u_labels, u_sampler, samplePos, 0.0);
                count += prev.r;  // Previous stage stores count in R
            }
        }
    }

    // Store count in R, preserve other channels for debugging
    let result: vec4f = vec4f(count, 0.0, 0.0, 0.0);
    textureStore(u_output, pos, result);
}
