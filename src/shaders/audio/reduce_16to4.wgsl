/**
 * Audio Reduction Stage 2: 16x16 -> 4x4
 *
 * Sums 4x4 regions of the stage 1 output.
 * Also computes temporal deltas by comparing to previous frame.
 *
 * Input (current + previous 16x16 textures):
 *   R: P1 units    G: P2 units    B: Resources    A: Combat
 *
 * Output per pixel (includes deltas):
 *   R: delta Resources (negative = mining happened)
 *   G: delta Units (P1 + P2 combined, positive = spawns)
 *   B: Current combat score + depletion events (packed: combat + depletion*100)
 *   A: Factory activity
 */

struct Params {
    inputResolution: vec2f,
    outputResolution: vec2f,
}

@group(0) @binding(0) var u_current: texture_2d<f32>;
@group(0) @binding(1) var u_previous: texture_2d<f32>;
@group(0) @binding(2) var u_currentFac: texture_2d<f32>;
@group(0) @binding(3) var u_previousFac: texture_2d<f32>;
@group(0) @binding(4) var u_output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(5) var<uniform> params: Params;
@group(0) @binding(6) var u_sampler: sampler;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let pos: vec2i = vec2i(gid.xy);
    if (pos.x >= i32(params.outputResolution.x) || pos.y >= i32(params.outputResolution.y)) { return; }

    // Output pixel position (0-3, 0-3)
    let outPos: vec2f = vec2f(f32(pos.x), f32(pos.y));

    // Region of input to sample (4x4 pixels per output pixel)
    let regionSize: f32 = params.inputResolution.x / params.outputResolution.x;  // 4
    let regionStart: vec2f = outPos * regionSize;

    // Accumulators for current frame
    var currUnits: f32 = 0.0;
    var currResources: f32 = 0.0;
    var currCombat: f32 = 0.0;
    var currFactories: f32 = 0.0;
    var currFactoryResources: f32 = 0.0;

    // Accumulators for previous frame
    var prevUnits: f32 = 0.0;
    var prevResources: f32 = 0.0;
    var prevFactories: f32 = 0.0;
    var prevFactoryResources: f32 = 0.0;

    // Sum all pixels in this 4x4 region (each pixel = 16x16 game cells, so region = 64x64 cells)
    for (var dy: f32 = 0.0; dy < regionSize; dy += 1.0) {
        for (var dx: f32 = 0.0; dx < regionSize; dx += 1.0) {
            let samplePos: vec2f = (regionStart + vec2f(dx, dy) + 0.5) / params.inputResolution;

            // Current frame data
            let curr: vec4f = textureSampleLevel(u_current, u_sampler, samplePos, 0.0);
            let currF: vec4f = textureSampleLevel(u_currentFac, u_sampler, samplePos, 0.0);
            currUnits += curr.r + curr.g;  // P1 + P2 units
            currResources += curr.b;
            currCombat += curr.a;
            currFactories += currF.r + currF.g;  // P1 + P2 factories
            currFactoryResources += currF.b + currF.a;

            // Previous frame data
            let prev: vec4f = textureSampleLevel(u_previous, u_sampler, samplePos, 0.0);
            let prevF: vec4f = textureSampleLevel(u_previousFac, u_sampler, samplePos, 0.0);
            prevUnits += prev.r + prev.g;
            prevResources += prev.b;
            prevFactories += prevF.r + prevF.g;
            prevFactoryResources += prevF.b + prevF.a;
        }
    }

    // Multi-scale depletion detection:
    // Detect when a 64x64 region has been significantly depleted
    // (lots of mining happened AND very few resources remain)
    let deltaResources: f32 = currResources - prevResources;  // Negative = mining
    let significantMining: f32 = -deltaResources;  // Positive when mining happened

    // Depletion event: mined a decent amount AND remaining is low
    // This catches "a blob was just finished" rather than "any region went empty"
    // Thresholds: mined > 5 resources, remaining < 20 resources in 64x64 region
    var depletionEvents: f32 = 0.0;
    if (significantMining > 5.0 && currResources < 20.0) {
        // Scale by how much was mined (more satisfying for bigger clearings)
        depletionEvents = clamp(significantMining / 10.0, 0.5, 3.0);
    }

    // Compute remaining deltas
    let deltaUnits: f32 = currUnits - prevUnits;              // Positive = spawns
    // Factory activity = absolute change in factory resources (deposits + spawning)
    let factoryActivity: f32 = abs(currFactoryResources - prevFactoryResources);

    // Pack combat and depletion into B channel (combat + depletion * 100)
    let packedCombatDepletion: f32 = currCombat + depletionEvents * 100.0;

    // Pack: R=world resource delta, G=unit delta, B=combat+depletion, A=factory activity
    let result: vec4f = vec4f(deltaResources, deltaUnits, packedCombatDepletion, factoryActivity);
    textureStore(u_output, pos, result);
}
