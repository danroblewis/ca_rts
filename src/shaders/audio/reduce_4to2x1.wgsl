/**
 * Audio Reduction Stage 3: 4x4 -> 2x1
 *
 * Final reduction that outputs sound parameters directly.
 *
 * Input (4x4 with deltas):
 *   R: delta World Resources    G: delta Units    B: Combat+Depletion*100    A: Factory Activity
 *
 * Output (2x1 = 2 pixels):
 *   Pixel 0 (Continuous loop volumes, 0.0-1.0):
 *     R: mining_volume     - Driven by resource depletion rate
 *     G: combat_volume     - Driven by combat score
 *     B: factory_hum       - Driven by factory activity (deposits + spawning)
 *     A: swarm_volume      - Driven by unit count changes
 *
 *   Pixel 1 (Triggers and meta):
 *     R: spawn_rate        - Number of spawns (0-5+)
 *     G: explosion_rate    - Number of factory cells destroyed (0-3+)
 *     B: ambient_intensity - Overall activity level
 *     A: depletion_rate    - Resource blobs fully depleted (0-5+)
 */

struct Params {
    inputResolution: vec2f,
    outputResolution: vec2f,
    facResolution: vec2f,
}

@group(0) @binding(0) var u_deltas: texture_2d<f32>;
@group(0) @binding(1) var u_currentFac: texture_2d<f32>;
@group(0) @binding(2) var u_output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var u_sampler: sampler;

// Normalization constants (tuned for 256x256 grid)
const MINING_DIVISOR: f32 = 20.0;      // Resources mined to reach full volume
const COMBAT_DIVISOR: f32 = 10.0;      // Combat score for full volume
const FACTORY_DIVISOR: f32 = 100.0;    // Factory resources for full hum
const SWARM_DIVISOR: f32 = 50.0;       // Unit count for full swarm sound
const ACTIVITY_DIVISOR: f32 = 100.0;   // Overall activity normalization

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let pos: vec2i = vec2i(gid.xy);
    if (pos.x >= i32(params.outputResolution.x) || pos.y >= i32(params.outputResolution.y)) { return; }

    // Output pixel position (0 or 1, always y=0)
    let outX: f32 = f32(pos.x);

    // Sum all 16 pixels of the 4x4 delta texture
    var totalDeltaResources: f32 = 0.0;
    var totalDeltaUnits: f32 = 0.0;
    var totalCombat: f32 = 0.0;
    var totalFactoryActivity: f32 = 0.0;
    var totalDepletionEvents: f32 = 0.0;

    for (var y: f32 = 0.0; y < 4.0; y += 1.0) {
        for (var x: f32 = 0.0; x < 4.0; x += 1.0) {
            let delta: vec4f = textureSampleLevel(u_deltas, u_sampler, (vec2f(x, y) + 0.5) / params.inputResolution, 0.0);
            totalDeltaResources += delta.r;
            totalDeltaUnits += delta.g;

            // Unpack combat and depletion from B channel (combat + depletion*100)
            let packedValue: f32 = delta.b;
            let depletion: f32 = floor(packedValue / 100.0);
            let combat: f32 = packedValue - depletion * 100.0;
            totalCombat += combat;
            totalDepletionEvents += depletion;

            totalFactoryActivity += delta.a;  // Factory activity (deposits + spawning)
        }
    }

    // Count total factories for explosion detection (factory cells destroyed)
    var totalFactoryCells: f32 = 0.0;
    for (var y: f32 = 0.0; y < 16.0; y += 1.0) {
        for (var x: f32 = 0.0; x < 16.0; x += 1.0) {
            let fac: vec4f = textureSampleLevel(u_currentFac, u_sampler, (vec2f(x, y) + 0.5) / params.facResolution, 0.0);
            totalFactoryCells += fac.r + fac.g;  // P1 + P2 factory cell counts
        }
    }

    // Compute sound parameters
    let miningVolume: f32 = clamp(-totalDeltaResources / MINING_DIVISOR, 0.0, 1.0);
    let combatVolume: f32 = clamp(totalCombat / COMBAT_DIVISOR, 0.0, 1.0);
    // Factory hum based on ACTIVITY (deposits + spawning), not static resources
    let factoryHum: f32 = clamp(totalFactoryActivity / 10.0, 0.0, 1.0);
    let swarmVolume: f32 = clamp(abs(totalDeltaUnits) / SWARM_DIVISOR, 0.0, 1.0);

    let spawnRate: f32 = clamp(max(0.0, totalDeltaUnits), 0.0, 5.0);
    // For explosions, we'd need factory cell delta - approximate from combat
    let explosionRate: f32 = clamp(totalCombat / 5.0, 0.0, 3.0);
    let ambientIntensity: f32 = clamp(
        (abs(totalDeltaResources) + abs(totalDeltaUnits) + totalCombat + totalFactoryActivity) / ACTIVITY_DIVISOR,
        0.0, 1.0
    );

    // Depletion rate (resource blob fully mined)
    let depletionRate: f32 = clamp(totalDepletionEvents, 0.0, 5.0);

    var result: vec4f;
    if (outX < 0.5) {
        // Pixel 0: Continuous loop volumes
        result = vec4f(miningVolume, combatVolume, factoryHum, swarmVolume);
    } else {
        // Pixel 1: Triggers and meta
        result = vec4f(spawnRate, explosionRate, ambientIntensity, depletionRate);
    }
    textureStore(u_output, pos, result);
}
