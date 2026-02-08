/**
 * Audio Reduction Stage 1: 256x256 -> 16x16
 *
 * Each output pixel covers a 16x16 region of the game state.
 * Counts cells by type and computes combat scores.
 *
 * Output per pixel:
 *   R: P1 units count
 *   G: P2 units count
 *   B: Total resources in region
 *   A: Combat score (units adjacent to enemy factories)
 *
 * A second pass outputs:
 *   R: P1 factories count (cells, not structures)
 *   G: P2 factories count
 *   B: P1 factory total resources
 *   A: P2 factory total resources
 */

#include "./constants.wgsl"

struct Params {
    inputResolution: vec2f,
    outputResolution: vec2f,
    pass_index: i32,
}

@group(0) @binding(0) var u_state: texture_2d<f32>;
@group(0) @binding(1) var u_output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var u_sampler: sampler;

// Check if a cell at worldPos has an adjacent enemy factory
fn computeCombatScore(worldPos: vec2f, cellType: f32) -> f32 {
    if (!isUnit(cellType)) { return 0.0; }

    let unitPlayer: i32 = getPlayer(cellType);
    var score: f32 = 0.0;

    // Check 4 neighbors
    let offsets = array<vec2f, 4>(
        vec2f(1.0, 0.0),
        vec2f(-1.0, 0.0),
        vec2f(0.0, 1.0),
        vec2f(0.0, -1.0),
    );

    for (var i: i32 = 0; i < 4; i++) {
        let neighborPos: vec2f = worldPos + offsets[i];
        let neighborCell: vec4f = textureSampleLevel(u_state, u_sampler, (neighborPos + 0.5) / params.inputResolution, 0.0);
        let neighborType: f32 = floor(neighborCell.r + 0.5);

        if (isFactory(neighborType)) {
            let factoryPlayer: i32 = getPlayer(neighborType);
            if (factoryPlayer != unitPlayer && factoryPlayer != 0) {
                score += 1.0;
            }
        }
    }

    return score;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let pos: vec2i = vec2i(gid.xy);
    if (pos.x >= i32(params.outputResolution.x) || pos.y >= i32(params.outputResolution.y)) { return; }

    // Output pixel position (0-15, 0-15)
    let outPos: vec2f = vec2f(f32(pos.x), f32(pos.y));

    // Region of input to sample (16x16 cells per output pixel)
    let regionSize: f32 = params.inputResolution.x / params.outputResolution.x;  // 16
    let regionStart: vec2f = outPos * regionSize;

    // Accumulators
    var p1Units: f32 = 0.0;
    var p2Units: f32 = 0.0;
    var resources: f32 = 0.0;
    var combatScore: f32 = 0.0;
    var p1Factories: f32 = 0.0;
    var p2Factories: f32 = 0.0;
    var p1FactoryResources: f32 = 0.0;
    var p2FactoryResources: f32 = 0.0;

    // Sample all cells in this region
    for (var dy: f32 = 0.0; dy < regionSize; dy += 1.0) {
        for (var dx: f32 = 0.0; dx < regionSize; dx += 1.0) {
            let worldPos: vec2f = regionStart + vec2f(dx, dy);
            let cell: vec4f = textureSampleLevel(u_state, u_sampler, (worldPos + 0.5) / params.inputResolution, 0.0);
            let cellType: f32 = floor(cell.r + 0.5);

            // Count by type
            if (isP1Unit(cellType)) {
                p1Units += 1.0;
            } else if (isP2Unit(cellType)) {
                p2Units += 1.0;
            } else if (cellType == CELL_RESOURCE) {
                resources += cell.g;  // Resource amount
            } else if (isP1Factory(cellType)) {
                p1Factories += 1.0;
                p1FactoryResources += getFactoryResources(cell);
            } else if (isP2Factory(cellType)) {
                p2Factories += 1.0;
                p2FactoryResources += getFactoryResources(cell);
            }

            // Combat score
            combatScore += computeCombatScore(worldPos, cellType);
        }
    }

    var result: vec4f;
    if (params.pass_index == 0) {
        // Pass 0: Units, resources, combat
        result = vec4f(p1Units, p2Units, resources, combatScore);
    } else {
        // Pass 1: Factories and their resources
        result = vec4f(p1Factories, p2Factories, p1FactoryResources, p2FactoryResources);
    }
    textureStore(u_output, pos, result);
}
