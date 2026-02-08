// Metaball Render Shader (WebGPU)
//
// Renders the CA simulation with metaball visual effects,
// temporal anti-aliasing, procedural rock textures, minimap, and UI overlays.

#include "../common/cell_types.wgsl"

// ============================================================================
// CONFIGURATION
// ============================================================================

const TEMPORAL_FRAME_COUNT: i32 = 2;      // current frame + trail frame
const TEMPORAL_FRAME_COUNT_PERF: i32 = 2;  // perf mode also gets trail
const TRAIL_FRAME_OFFSET: i32 = 3;         // trail frame is 3 steps behind current

const STATIC_KERNEL_RADIUS: i32 = 2;
const UNIT_KERNEL_RADIUS: i32 = 2;
const UNIT_TEMPORAL_KERNEL_RADIUS: i32 = 2;

const STATIC_KERNEL_RADIUS_PERF: i32 = 1;
const UNIT_KERNEL_RADIUS_PERF: i32 = 1;

const TEMPORAL_BLUR_SIGMA: f32 = 0.8;

// ============================================================================
// BINDINGS
// ============================================================================

@group(0) @binding(0) var u_state0: texture_2d<f32>;
@group(0) @binding(1) var u_state1: texture_2d<f32>;
@group(0) @binding(2) var u_state2: texture_2d<f32>;
@group(0) @binding(3) var u_state3: texture_2d<f32>;
@group(0) @binding(4) var u_state4: texture_2d<f32>;
@group(0) @binding(5) var u_state5: texture_2d<f32>;
@group(0) @binding(6) var u_state6: texture_2d<f32>;
@group(0) @binding(7) var u_state7: texture_2d<f32>;
@group(0) @binding(8) var u_sampler: sampler;
@group(0) @binding(9) var<uniform> params: RenderParams;

struct RenderParams {
    resolution: vec2f,
    canvasResolution: vec2f,
    time: f32,
    metaballScale: f32,
    frameCount: i32,
    temporalBlend: f32,
    currentPlayer: f32,
    isSelecting: f32,
    selectionStart: vec2f,
    selectionEnd: vec2f,
    hasActiveSelection: f32,
    mousePos: vec2f,
    shiftHeld: f32,
    deleteRadius: f32,
    cameraPos: vec2f,
    cameraZoom: f32,
    aspectRatio: f32,
    showMinimap: f32,
    performanceMode: f32,
    _pad: vec2f,
}

// ============================================================================
// VERTEX SHADER - Fullscreen triangle
// ============================================================================

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
    var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var uv = array<vec2f, 3>(vec2f(0.0, 0.0), vec2f(2.0, 0.0), vec2f(0.0, 2.0));
    var out: VertexOutput;
    out.position = vec4f(pos[vi], 0.0, 1.0);
    out.uv = uv[vi];
    return out;
}

// ============================================================================
// CAMERA HELPERS
// ============================================================================

fn screenToWorldUV(screenUV: vec2f) -> vec2f {
    let centered: vec2f = screenUV - 0.5;
    var aspectScale: vec2f;
    if (params.aspectRatio >= 1.0) {
        aspectScale = vec2f(params.aspectRatio, 1.0);
    } else {
        aspectScale = vec2f(1.0, 1.0 / params.aspectRatio);
    }
    let scaled: vec2f = centered * aspectScale / params.cameraZoom;
    let cameraUV: vec2f = params.cameraPos / params.resolution;
    return scaled + cameraUV;
}

fn isInBounds(worldUV: vec2f) -> bool {
    return worldUV.x >= 0.0 && worldUV.x <= 1.0 &&
           worldUV.y >= 0.0 && worldUV.y <= 1.0;
}

// Sample from a specific frame by index
fn sampleFrame(frame: i32, uv: vec2f) -> vec4f {
    if (frame == 0) { return textureSampleLevel(u_state0, u_sampler, uv, 0.0); }
    if (frame == 1) { return textureSampleLevel(u_state1, u_sampler, uv, 0.0); }
    if (frame == 2) { return textureSampleLevel(u_state2, u_sampler, uv, 0.0); }
    if (frame == 3) { return textureSampleLevel(u_state3, u_sampler, uv, 0.0); }
    if (frame == 4) { return textureSampleLevel(u_state4, u_sampler, uv, 0.0); }
    if (frame == 5) { return textureSampleLevel(u_state5, u_sampler, uv, 0.0); }
    if (frame == 6) { return textureSampleLevel(u_state6, u_sampler, uv, 0.0); }
    return textureSampleLevel(u_state7, u_sampler, uv, 0.0);
}

fn temporalWeight(frame: i32) -> f32 {
    return pow(0.7, f32(frame));
}

// ============================================================================
// UNIFIED DENSITY CALCULATION
// ============================================================================

struct AllDensities {
    resourceDens: f32,
    wallDens: f32,
    demolishDens: f32,
    p1FactoryBuilt: f32,
    p1FactoryUnbuilt: f32,
    p1BuildProgress: f32,
    p1UnbuiltWeight: f32,
    p2FactoryBuilt: f32,
    p2FactoryUnbuilt: f32,
    p2BuildProgress: f32,
    p2UnbuiltWeight: f32,
    p1MissileBuilding: f32,
    p1MissileArmed: f32,
    p1MissileMoving: f32,
    p1MissileExploding: f32,
    p1MissileSelected: f32,
    p2MissileBuilding: f32,
    p2MissileArmed: f32,
    p2MissileMoving: f32,
    p2MissileExploding: f32,
    p2MissileSelected: f32,
    explosionDensity: f32,
    explosionLifeAvg: f32,
}

fn calcAllStaticDensities(uv: vec2f) -> AllDensities {
    var d: AllDensities;
    d.resourceDens = 0.0;
    d.wallDens = 0.0;
    d.demolishDens = 0.0;
    d.p1FactoryBuilt = 0.0;
    d.p1FactoryUnbuilt = 0.0;
    d.p1BuildProgress = 0.0;
    d.p1UnbuiltWeight = 0.0;
    d.p2FactoryBuilt = 0.0;
    d.p2FactoryUnbuilt = 0.0;
    d.p2BuildProgress = 0.0;
    d.p2UnbuiltWeight = 0.0;
    d.p1MissileBuilding = 0.0;
    d.p1MissileArmed = 0.0;
    d.p1MissileMoving = 0.0;
    d.p1MissileExploding = 0.0;
    d.p1MissileSelected = 0.0;
    d.p2MissileBuilding = 0.0;
    d.p2MissileArmed = 0.0;
    d.p2MissileMoving = 0.0;
    d.p2MissileExploding = 0.0;
    d.p2MissileSelected = 0.0;
    d.explosionDensity = 0.0;
    d.explosionLifeAvg = 0.0;

    let texelSize: vec2f = 1.0 / params.resolution;
    let gridPos: vec2f = uv * params.resolution;
    let cellFrac: vec2f = fract(gridPos);

    let scale: f32 = max(0.1, params.metaballScale);
    let minDist: f32 = 0.3 / scale;

    let kernelRadius: i32 = select(STATIC_KERNEL_RADIUS, STATIC_KERNEL_RADIUS_PERF, params.performanceMode > 0.5);

    for (var dy: i32 = -STATIC_KERNEL_RADIUS; dy <= STATIC_KERNEL_RADIUS; dy++) {
        if (abs(dy) > kernelRadius) { continue; }
        for (var dx: i32 = -STATIC_KERNEL_RADIUS; dx <= STATIC_KERNEL_RADIUS; dx++) {
            if (abs(dx) > kernelRadius) { continue; }
            let offset: vec2f = vec2f(f32(dx), f32(dy));
            let sampleUV: vec2f = uv + offset * texelSize;
            let cellSample: vec4f = textureSampleLevel(u_state0, u_sampler, sampleUV, 0.0);

            let cellCenter: vec2f = offset + vec2f(0.5) - cellFrac;
            var dist: f32 = length(cellCenter) / scale;
            if (dist < minDist) { dist = minDist; }
            let weight: f32 = 1.0 / (dist * dist);

            let cellType: f32 = getCellType(cellSample);

            if (cellType == CELL_RESOURCE) {
                d.resourceDens += weight;
            }
            else if (cellType == CELL_WALL) {
                d.wallDens += weight;
            }
            else if (cellType == CELL_DEMOLISH) {
                d.demolishDens += weight;
            }
            else if (isMiningFactory(cellSample)) {
                let player: f32 = getPlayerFromCell(cellSample);
                let center: vec2f = getFactoryPosition(cellSample);
                let totalProgress: f32 = sumFactoryBuildProgressSampled(center, u_state0, u_sampler, params.resolution);
                let isBuilt: bool = totalProgress >= BUILD_THRESHOLD;

                if (player == PLAYER_1) {
                    if (isBuilt) {
                        d.p1FactoryBuilt += weight;
                    } else {
                        d.p1FactoryUnbuilt += weight;
                        d.p1BuildProgress += (totalProgress / BUILD_THRESHOLD) * weight;
                        d.p1UnbuiltWeight += weight;
                    }
                } else {
                    if (isBuilt) {
                        d.p2FactoryBuilt += weight;
                    } else {
                        d.p2FactoryUnbuilt += weight;
                        d.p2BuildProgress += (totalProgress / BUILD_THRESHOLD) * weight;
                        d.p2UnbuiltWeight += weight;
                    }
                }
            }
            else if (isMissileCell(cellSample)) {
                let player: f32 = getPlayerFromCell(cellSample);
                let mState: f32 = getMissileStateF(cellSample);
                let isSelected: bool = getMissileSelectedF(cellSample);

                if (player == PLAYER_1) {
                    if (mState == MISSILE_BUILDING) { d.p1MissileBuilding += weight; }
                    else if (mState == MISSILE_ARMED) {
                        d.p1MissileArmed += weight;
                        if (isSelected) { d.p1MissileSelected += weight; }
                    }
                    else if (mState == MISSILE_MOVING) { d.p1MissileMoving += weight; }
                    else if (mState == MISSILE_EXPLODING) { d.p1MissileExploding += weight; }
                } else {
                    if (mState == MISSILE_BUILDING) { d.p2MissileBuilding += weight; }
                    else if (mState == MISSILE_ARMED) {
                        d.p2MissileArmed += weight;
                        if (isSelected) { d.p2MissileSelected += weight; }
                    }
                    else if (mState == MISSILE_MOVING) { d.p2MissileMoving += weight; }
                    else if (mState == MISSILE_EXPLODING) { d.p2MissileExploding += weight; }
                }
            }
            else if (isExplosionCell(cellSample)) {
                d.explosionDensity += weight;
                let lifetime: f32 = getExplosionLifetimeFromCell(cellSample);
                d.explosionLifeAvg += lifetime * weight;
            }
        }
    }

    if (d.explosionDensity > 0.0) {
        d.explosionLifeAvg /= d.explosionDensity;
    }

    return d;
}

// ============================================================================
// UNIFIED UNIT DENSITY WITH TRAIL LINE + SELECTION
// ============================================================================
//
// Instead of sampling 4 consecutive frames (expensive), we sample only:
//   1. Frame 0 (current) - where units are now
//   2. Frame N-3 (trail) - where units were 3 steps ago
// Then draw a density trail line between the two positions.
// This gives smooth motion trails with half the texture reads.

struct AllUnitDensities {
    p1Empty: f32, p1Holding: f32, p1Age: f32, p1Weight: f32,
    p2Empty: f32, p2Holding: f32, p2Age: f32, p2Weight: f32,
    p1Selection: f32, p2Selection: f32,
}

fn calcAllUnitDensities(uv: vec2f) -> AllUnitDensities {
    var d: AllUnitDensities;
    d.p1Empty = 0.0; d.p1Holding = 0.0; d.p1Age = 0.0; d.p1Weight = 0.0;
    d.p2Empty = 0.0; d.p2Holding = 0.0; d.p2Age = 0.0; d.p2Weight = 0.0;
    d.p1Selection = 0.0; d.p2Selection = 0.0;

    let texelSize: vec2f = 1.0 / params.resolution;
    let gridPos: vec2f = uv * params.resolution;
    let cellFrac: vec2f = fract(gridPos);
    let scale: f32 = max(0.1, params.metaballScale);
    let minDist: f32 = 0.3 / scale;

    let maxFrames: i32 = select(TEMPORAL_FRAME_COUNT, TEMPORAL_FRAME_COUNT_PERF, params.performanceMode > 0.5);
    let numFrames: i32 = min(clamp(params.frameCount, 1, 8), maxFrames);
    let blendStrength: f32 = clamp(params.temporalBlend, 0.0, 1.0);
    let unitKernelRadius: i32 = select(UNIT_KERNEL_RADIUS, UNIT_KERNEL_RADIUS_PERF, params.performanceMode > 0.5);
    let checkSelection: bool = params.hasActiveSelection > 0.5;

    // Trail config
    let trailFrame: i32 = min(TRAIL_FRAME_OFFSET, clamp(params.frameCount, 1, 8) - 1);
    let hasTrail: bool = numFrames >= 2 && trailFrame > 0;
    let trailFW: f32 = temporalWeight(trailFrame) * blendStrength;
    let totalTemporalWeight: f32 = select(1.0, 1.0 + trailFW, hasTrail);

    // Center-of-mass tracking for trail line (per player)
    var p1Center0: vec2f = vec2f(0.0); var p1CW0: f32 = 0.0;
    var p1CenterT: vec2f = vec2f(0.0); var p1CWT: f32 = 0.0;
    var p1Hold0: f32 = 0.0; var p1Count0: f32 = 0.0;
    var p2Center0: vec2f = vec2f(0.0); var p2CW0: f32 = 0.0;
    var p2CenterT: vec2f = vec2f(0.0); var p2CWT: f32 = 0.0;
    var p2Hold0: f32 = 0.0; var p2Count0: f32 = 0.0;

    // ---- Pass 1: Current frame ----
    for (var dy: i32 = -UNIT_KERNEL_RADIUS; dy <= UNIT_KERNEL_RADIUS; dy++) {
        if (abs(dy) > unitKernelRadius) { continue; }
        for (var dx: i32 = -UNIT_KERNEL_RADIUS; dx <= UNIT_KERNEL_RADIUS; dx++) {
            if (abs(dx) > unitKernelRadius) { continue; }

            let offset: vec2f = vec2f(f32(dx), f32(dy));
            let cellSample: vec4f = sampleFrame(0, uv + offset * texelSize);

            if (isMiningUnit(cellSample)) {
                let cellCenter: vec2f = offset + vec2f(0.5) - cellFrac;
                var dist: f32 = length(cellCenter) / scale;
                if (dist < minDist) { dist = minDist; }
                let spatialW: f32 = 1.0 / (dist * dist);
                let weight: f32 = spatialW; // frame 0 temporal weight = 1.0

                let age: f32 = getUnitAgeF(cellSample);
                let holding: bool = isHoldingResource(cellSample);
                let player: f32 = getPlayerFromCell(cellSample);

                if (player == PLAYER_1) {
                    d.p1Age += age * weight;
                    d.p1Weight += weight;
                    if (holding) { d.p1Holding += weight; } else { d.p1Empty += weight; }
                    p1Center0 += cellCenter * spatialW;
                    p1CW0 += spatialW;
                    p1Count0 += 1.0;
                    if (holding) { p1Hold0 += 1.0; }
                    if (checkSelection && getUnitSelectedF(cellSample)) {
                        d.p1Selection += spatialW;
                    }
                } else {
                    d.p2Age += age * weight;
                    d.p2Weight += weight;
                    if (holding) { d.p2Holding += weight; } else { d.p2Empty += weight; }
                    p2Center0 += cellCenter * spatialW;
                    p2CW0 += spatialW;
                    p2Count0 += 1.0;
                    if (holding) { p2Hold0 += 1.0; }
                    if (checkSelection && getUnitSelectedF(cellSample)) {
                        d.p2Selection += spatialW;
                    }
                }
            }
        }
    }

    // ---- Pass 2: Trail frame (n-3) ----
    if (hasTrail) {
        let trailKernel: i32 = UNIT_TEMPORAL_KERNEL_RADIUS;
        for (var dy: i32 = -UNIT_KERNEL_RADIUS; dy <= UNIT_KERNEL_RADIUS; dy++) {
            if (abs(dy) > trailKernel) { continue; }
            for (var dx: i32 = -UNIT_KERNEL_RADIUS; dx <= UNIT_KERNEL_RADIUS; dx++) {
                if (abs(dx) > trailKernel) { continue; }

                let offset: vec2f = vec2f(f32(dx), f32(dy));
                let cellSample: vec4f = sampleFrame(trailFrame, uv + offset * texelSize);

                if (isMiningUnit(cellSample)) {
                    let cellCenter: vec2f = offset + vec2f(0.5) - cellFrac;
                    var dist: f32 = length(cellCenter) / scale;
                    if (dist < minDist) { dist = minDist; }
                    let spatialW: f32 = 1.0 / (dist * dist);
                    let weight: f32 = spatialW * trailFW;

                    let age: f32 = getUnitAgeF(cellSample);
                    let holding: bool = isHoldingResource(cellSample);
                    let player: f32 = getPlayerFromCell(cellSample);

                    if (player == PLAYER_1) {
                        d.p1Age += age * weight;
                        d.p1Weight += weight;
                        if (holding) { d.p1Holding += weight; } else { d.p1Empty += weight; }
                        p1CenterT += cellCenter * spatialW;
                        p1CWT += spatialW;
                    } else {
                        d.p2Age += age * weight;
                        d.p2Weight += weight;
                        if (holding) { d.p2Holding += weight; } else { d.p2Empty += weight; }
                        p2CenterT += cellCenter * spatialW;
                        p2CWT += spatialW;
                    }
                }
            }
        }
    }

    // ---- Trail line density ----
    // For each player, if units found in both current and trail frames,
    // compute a density trail along the line segment between the two centers.
    if (p1CW0 > 0.0 && p1CWT > 0.0) {
        let c0: vec2f = p1Center0 / p1CW0;
        let cT: vec2f = p1CenterT / p1CWT;
        let seg: vec2f = cT - c0;
        let segLenSq: f32 = dot(seg, seg);
        if (segLenSq > 0.09) { // only draw trail if unit moved > 0.3 cells
            // Distance from pixel (origin) to closest point on line segment c0→cT
            let t: f32 = clamp(dot(-c0, seg) / segLenSq, 0.0, 1.0);
            let closest: vec2f = c0 + seg * t;
            var dist: f32 = length(closest) / scale;
            if (dist < minDist) { dist = minDist; }
            let trailDensity: f32 = (1.0 / (dist * dist)) * 0.5 * trailFW;
            let holdR: f32 = select(p1Hold0 / p1Count0, 0.0, p1Count0 <= 0.0);
            d.p1Holding += trailDensity * holdR;
            d.p1Empty += trailDensity * (1.0 - holdR);
        }
    }
    if (p2CW0 > 0.0 && p2CWT > 0.0) {
        let c0: vec2f = p2Center0 / p2CW0;
        let cT: vec2f = p2CenterT / p2CWT;
        let seg: vec2f = cT - c0;
        let segLenSq: f32 = dot(seg, seg);
        if (segLenSq > 0.09) {
            let t: f32 = clamp(dot(-c0, seg) / segLenSq, 0.0, 1.0);
            let closest: vec2f = c0 + seg * t;
            var dist: f32 = length(closest) / scale;
            if (dist < minDist) { dist = minDist; }
            let trailDensity: f32 = (1.0 / (dist * dist)) * 0.5 * trailFW;
            let holdR: f32 = select(p2Hold0 / p2Count0, 0.0, p2Count0 <= 0.0);
            d.p2Holding += trailDensity * holdR;
            d.p2Empty += trailDensity * (1.0 - holdR);
        }
    }

    // Normalize
    let norm: f32 = max(totalTemporalWeight, 1.0);
    d.p1Empty /= norm;
    d.p1Holding /= norm;
    d.p1Age = select(d.p1Age / d.p1Weight, 0.0, d.p1Weight <= 0.0);
    d.p2Empty /= norm;
    d.p2Holding /= norm;
    d.p2Age = select(d.p2Age / d.p2Weight, 0.0, d.p2Weight <= 0.0);

    return d;
}

// ============================================
// PROCEDURAL NOISE FUNCTIONS FOR ROCK TEXTURE
// ============================================

fn hashN(p: vec2f) -> f32 {
    let p3: vec3f = fract(vec3f(p.x, p.y, p.x) * 0.1031);
    let p3d: vec3f = p3 + dot(p3, vec3f(p3.y, p3.z, p3.x) + 33.33);
    return fract((p3d.x + p3d.y) * p3d.z);
}

fn hash2N(p: vec2f) -> vec2f {
    let q: vec2f = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
    return fract(sin(q) * 43758.5453);
}

fn gradientNoise(p: vec2f) -> f32 {
    let i: vec2f = floor(p);
    let f: vec2f = fract(p);
    let u: vec2f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let a: f32 = hashN(i);
    let b: f32 = hashN(i + vec2f(1.0, 0.0));
    let c: f32 = hashN(i + vec2f(0.0, 1.0));
    let dd: f32 = hashN(i + vec2f(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, dd, u.x), u.y);
}

fn fbm(p: vec2f, octaves: i32) -> f32 {
    var value: f32 = 0.0;
    var amplitude: f32 = 0.5;
    var frequency: f32 = 1.0;
    var totalAmplitude: f32 = 0.0;

    for (var i: i32 = 0; i < 6; i++) {
        if (i >= octaves) { break; }
        value += amplitude * gradientNoise(p * frequency);
        totalAmplitude += amplitude;
        frequency *= 2.0;
        amplitude *= 0.5;
    }

    return value / totalAmplitude;
}

fn voronoi(p: vec2f) -> vec3f {
    let n: vec2f = floor(p);
    let f: vec2f = fract(p);

    var minDist: f32 = 1.0;
    var secondMinDist: f32 = 1.0;
    var minPoint: vec2f = vec2f(0.0);

    for (var j: i32 = -1; j <= 1; j++) {
        for (var i: i32 = -1; i <= 1; i++) {
            let neighbor: vec2f = vec2f(f32(i), f32(j));
            let point: vec2f = hash2N(n + neighbor);
            let diff: vec2f = neighbor + point - f;
            let dist: f32 = length(diff);

            if (dist < minDist) {
                secondMinDist = minDist;
                minDist = dist;
                minPoint = point;
            } else if (dist < secondMinDist) {
                secondMinDist = dist;
            }
        }
    }

    let edgeDist: f32 = secondMinDist - minDist;
    return vec3f(minDist, edgeDist, hashN(minPoint * 100.0));
}

fn warpDomain(p: vec2f, strength: f32) -> vec2f {
    let n1: f32 = fbm(p, 3);
    let n2: f32 = fbm(p + vec2f(5.2, 1.3), 3);
    return p + vec2f(n1, n2) * strength;
}

// ============================================
// ROCK TEXTURE GENERATOR
// ============================================

struct RockTexture {
    brightness: f32,
    roughness: f32,
    cracks: f32,
    grain: f32,
}

fn calcRockTexture(uv: vec2f, scale: f32) -> RockTexture {
    var rock: RockTexture;
    let warpedUV: vec2f = warpDomain(uv * scale, 0.3);
    let vor1: vec3f = voronoi(warpedUV * 2.0);
    let vor2: vec3f = voronoi(warpedUV * 6.0);
    let detail: f32 = fbm(warpedUV * 8.0, 4);
    rock.brightness = 0.5 + 0.3 * vor1.x + 0.15 * vor2.x + 0.1 * detail;
    rock.cracks = 1.0 - smoothstep(0.0, 0.15, vor1.y);
    rock.roughness = fbm(warpedUV * 4.0, 3);
    rock.grain = vor2.z;
    return rock;
}

fn calcRockEdge(uv: vec2f, baseDensity: f32, threshold: f32, scale: f32) -> f32 {
    let warpedUV: vec2f = warpDomain(uv * scale, 0.2);
    let edgeNoise: f32 = fbm(warpedUV * 3.0, 3);
    let adjustedThreshold: f32 = threshold * (0.85 + edgeNoise * 0.3);
    return smoothstep(adjustedThreshold, adjustedThreshold + 1.5, baseDensity);
}

// ============================================================================
// FRAGMENT SHADER
// ============================================================================

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let worldUV: vec2f = screenToWorldUV(in.uv);
    let pixelPos: vec2f = worldUV * params.resolution;

    let outOfBounds: bool = !isInBounds(worldUV);

    var bgColor: vec3f = mix(
        vec3f(0.02, 0.04, 0.08),
        vec3f(0.06, 0.08, 0.12),
        clamp(worldUV.y, 0.0, 1.0)
    );

    if (outOfBounds) {
        bgColor = vec3f(0.01, 0.02, 0.03);
    }

    var color: vec3f = bgColor;

    if (!outOfBounds) {

    // Calculate ALL static densities in a single pass
    let d: AllDensities = calcAllStaticDensities(worldUV);

    let resourceDensity: f32 = d.resourceDens;

    // Player 1 factories (purple)
    let p1BuiltFactoryDensity: f32 = d.p1FactoryBuilt;
    let p1UnbuiltFactoryDensity: f32 = d.p1FactoryUnbuilt;
    let p1BuildProgress: f32 = select(d.p1BuildProgress / d.p1UnbuiltWeight, 0.0, d.p1UnbuiltWeight <= 0.0);

    // Player 2 factories (green)
    let p2BuiltFactoryDensity: f32 = d.p2FactoryBuilt;
    let p2UnbuiltFactoryDensity: f32 = d.p2FactoryUnbuilt;
    let p2BuildProgress: f32 = select(d.p2BuildProgress / d.p2UnbuiltWeight, 0.0, d.p2UnbuiltWeight <= 0.0);

    // Missiles
    let p1MissileDensity: f32 = d.p1MissileBuilding + d.p1MissileArmed + d.p1MissileMoving + d.p1MissileExploding;
    let p2MissileDensity: f32 = d.p2MissileBuilding + d.p2MissileArmed + d.p2MissileMoving + d.p2MissileExploding;
    let p1MissileExplosion: f32 = d.p1MissileExploding;
    let p2MissileExplosion: f32 = d.p2MissileExploding;

    // All unit densities (P1 + P2 + selection) in a single pass
    let unitDens: AllUnitDensities = calcAllUnitDensities(worldUV);
    let p1EmptyUnitDensity: f32 = unitDens.p1Empty;
    let p1HoldingUnitDensity: f32 = unitDens.p1Holding;
    let p1AvgAge: f32 = unitDens.p1Age;
    let p2EmptyUnitDensity: f32 = unitDens.p2Empty;
    let p2HoldingUnitDensity: f32 = unitDens.p2Holding;
    let p2AvgAge: f32 = unitDens.p2Age;
    let p1SelectionDensity: f32 = select(unitDens.p1Selection, 0.0, params.currentPlayer != PLAYER_1);
    let p2SelectionDensity: f32 = select(unitDens.p2Selection, 0.0, params.currentPlayer != PLAYER_2);

    // Thresholds
    let resourceThreshold: f32 = 0.8;
    let unitThreshold: f32 = 0.3;
    let factoryThreshold: f32 = 1.0;

    // ========================================================================
    // Resources - ROCK TEXTURE
    // ========================================================================
    let rockEdge: f32 = calcRockEdge(worldUV, resourceDensity, resourceThreshold, 8.0);

    if (rockEdge > 0.01) {
        let rock: RockTexture = calcRockTexture(worldUV, 12.0);
        let stoneBase: vec3f = vec3f(0.35, 0.30, 0.22);
        let oreDark: vec3f = vec3f(0.55, 0.38, 0.12);
        let oreMid: vec3f = vec3f(0.75, 0.55, 0.18);
        let oreBright: vec3f = vec3f(0.95, 0.78, 0.28);

        var baseColor: vec3f = mix(stoneBase, oreDark, rock.grain);
        baseColor = mix(baseColor, oreMid, rock.brightness * 0.7);
        let highlight: f32 = smoothstep(0.7, 0.9, rock.brightness);
        baseColor = mix(baseColor, oreBright, highlight * 0.5);
        baseColor *= 1.0 - rock.cracks * 0.6;
        let crackColor: vec3f = vec3f(0.25, 0.15, 0.05);
        baseColor = mix(baseColor, crackColor, rock.cracks * 0.4);
        let depthShade: f32 = smoothstep(0.0, 0.5, rockEdge);
        baseColor *= 0.7 + depthShade * 0.3;
        let innerGlow: f32 = smoothstep(0.3, 0.8, rockEdge);
        baseColor += vec3f(0.08, 0.05, 0.0) * innerGlow;
        color = mix(color, baseColor, rockEdge);
    }

    // ========================================================================
    // Player 1 Units
    // ========================================================================
    let fadeStart: f32 = 0.3;
    let deathFlashStart: f32 = 0.9;

    let p1TotalUnitDensity: f32 = p1EmptyUnitDensity + p1HoldingUnitDensity;
    let p1IsSelected: bool = p1SelectionDensity > 0.1;
    if (p1TotalUnitDensity > unitThreshold * 0.3) {
        let p1AgeRatio: f32 = p1AvgAge / MAX_AGE;
        var ageBrightness: f32 = 1.0;
        var ageColorMod: vec3f = vec3f(1.0);
        var newbornScale: f32 = 1.0;

        if (p1AvgAge < 0.0) {
            let newbornProgress: f32 = -p1AvgAge / (-NEWBORN_AGE);
            ageBrightness = 1.0 + newbornProgress * 1.5;
            ageColorMod = vec3f(1.0 + newbornProgress * 0.5);
            newbornScale = 1.0 + newbornProgress * 0.5;
        } else if (p1AgeRatio >= fadeStart && p1AgeRatio < deathFlashStart) {
            let fadeFactor: f32 = (p1AgeRatio - fadeStart) / (deathFlashStart - fadeStart);
            ageBrightness = 1.0 - fadeFactor * 0.7;
        } else if (p1AgeRatio >= deathFlashStart) {
            let deathProgress: f32 = (p1AgeRatio - deathFlashStart) / (1.0 - deathFlashStart);
            if (deathProgress < 0.3) {
                let flashIntensity: f32 = deathProgress / 0.3;
                ageColorMod = mix(vec3f(0.3), vec3f(3.0), flashIntensity);
            } else {
                let fadeOut: f32 = (deathProgress - 0.3) / 0.7;
                ageBrightness = mix(1.5, 0.1, fadeOut);
            }
        }

        var selectionBrightness: f32 = 1.0;
        var selectionPulse: f32 = 0.0;
        if (p1IsSelected) {
            selectionBrightness = 1.5;
            selectionPulse = sin(params.time * 4.0) * 0.3 + 0.3;
        }

        let scaledDensity: f32 = p1TotalUnitDensity * newbornScale;
        let holdingRatio: f32 = p1HoldingUnitDensity / max(p1TotalUnitDensity, 0.001);
        let glowStrength: f32 = smoothstep(0.0, unitThreshold, scaledDensity);
        var glowColor: vec3f = mix(vec3f(0.25, 0.1, 0.35), vec3f(0.4, 0.15, 0.5), holdingRatio);
        glowColor *= ageBrightness * ageColorMod * selectionBrightness;
        color = color + glowColor * glowStrength * 0.6;

        if (scaledDensity > unitThreshold) {
            let blobStrength: f32 = smoothstep(unitThreshold, unitThreshold + 1.5, scaledDensity);
            let purpleColor: vec3f = vec3f(0.6, 0.4, 1.0) * ageBrightness * ageColorMod;
            let magentaColor: vec3f = vec3f(0.95, 0.4, 0.8) * ageBrightness * ageColorMod;
            var unitColor: vec3f = mix(purpleColor, magentaColor, holdingRatio);

            if (p1IsSelected) {
                unitColor *= selectionBrightness;
                unitColor += vec3f(1.0, 1.0, 1.0) * selectionPulse;
                let outerRing: f32 = smoothstep(unitThreshold * 0.5, unitThreshold, scaledDensity);
                color += vec3f(1.0, 0.9, 1.0) * outerRing * 0.4 * (1.0 + selectionPulse);
            }

            let coreGlow: f32 = smoothstep(unitThreshold + 1.0, unitThreshold + 4.0, scaledDensity);
            unitColor += vec3f(0.2) * coreGlow * ageBrightness;
            color = mix(color, unitColor, blobStrength);
        }
    }

    // ========================================================================
    // Player 2 Units
    // ========================================================================
    let p2TotalUnitDensity: f32 = p2EmptyUnitDensity + p2HoldingUnitDensity;
    let p2IsSelected: bool = p2SelectionDensity > 0.1;
    if (p2TotalUnitDensity > unitThreshold * 0.3) {
        let p2AgeRatio: f32 = p2AvgAge / MAX_AGE;
        var ageBrightness2: f32 = 1.0;
        var ageColorMod2: vec3f = vec3f(1.0);
        var newbornScale2: f32 = 1.0;

        if (p2AvgAge < 0.0) {
            let newbornProgress: f32 = -p2AvgAge / (-NEWBORN_AGE);
            ageBrightness2 = 1.0 + newbornProgress * 1.5;
            ageColorMod2 = vec3f(1.0 + newbornProgress * 0.5);
            newbornScale2 = 1.0 + newbornProgress * 0.5;
        } else if (p2AgeRatio >= fadeStart && p2AgeRatio < deathFlashStart) {
            let fadeFactor: f32 = (p2AgeRatio - fadeStart) / (deathFlashStart - fadeStart);
            ageBrightness2 = 1.0 - fadeFactor * 0.7;
        } else if (p2AgeRatio >= deathFlashStart) {
            let deathProgress: f32 = (p2AgeRatio - deathFlashStart) / (1.0 - deathFlashStart);
            if (deathProgress < 0.3) {
                let flashIntensity: f32 = deathProgress / 0.3;
                ageColorMod2 = mix(vec3f(0.3), vec3f(3.0), flashIntensity);
            } else {
                let fadeOut: f32 = (deathProgress - 0.3) / 0.7;
                ageBrightness2 = mix(1.5, 0.1, fadeOut);
            }
        }

        var selectionBrightness2: f32 = 1.0;
        var selectionPulse2: f32 = 0.0;
        if (p2IsSelected) {
            selectionBrightness2 = 1.5;
            selectionPulse2 = sin(params.time * 4.0) * 0.3 + 0.3;
        }

        let scaledDensity2: f32 = p2TotalUnitDensity * newbornScale2;
        let holdingRatio2: f32 = p2HoldingUnitDensity / max(p2TotalUnitDensity, 0.001);
        let glowStrength2: f32 = smoothstep(0.0, unitThreshold, scaledDensity2);
        var glowColor2: vec3f = mix(vec3f(0.1, 0.3, 0.15), vec3f(0.15, 0.4, 0.1), holdingRatio2);
        glowColor2 *= ageBrightness2 * ageColorMod2 * selectionBrightness2;
        color = color + glowColor2 * glowStrength2 * 0.6;

        if (scaledDensity2 > unitThreshold) {
            let blobStrength2: f32 = smoothstep(unitThreshold, unitThreshold + 1.5, scaledDensity2);
            let tealColor: vec3f = vec3f(0.3, 0.85, 0.7) * ageBrightness2 * ageColorMod2;
            let greenColor: vec3f = vec3f(0.4, 0.95, 0.35) * ageBrightness2 * ageColorMod2;
            var unitColor2: vec3f = mix(tealColor, greenColor, holdingRatio2);

            if (p2IsSelected) {
                unitColor2 *= selectionBrightness2;
                unitColor2 += vec3f(1.0, 1.0, 1.0) * selectionPulse2;
                let outerRing2: f32 = smoothstep(unitThreshold * 0.5, unitThreshold, scaledDensity2);
                color += vec3f(0.9, 1.0, 0.9) * outerRing2 * 0.4 * (1.0 + selectionPulse2);
            }

            let coreGlow2: f32 = smoothstep(unitThreshold + 1.0, unitThreshold + 4.0, scaledDensity2);
            unitColor2 += vec3f(0.2) * coreGlow2 * ageBrightness2;
            color = mix(color, unitColor2, blobStrength2);
        }
    }

    // ========================================================================
    // Walls - ROCK TEXTURE
    // ========================================================================
    let wallDensity: f32 = d.wallDens;
    let wallEdge: f32 = calcRockEdge(worldUV, wallDensity, 0.5, 6.0);

    if (wallEdge > 0.01) {
        let rock: RockTexture = calcRockTexture(worldUV, 8.0);
        let stoneDark: vec3f = vec3f(0.18, 0.18, 0.20);
        let stoneMid: vec3f = vec3f(0.32, 0.32, 0.35);
        let stoneLight: vec3f = vec3f(0.48, 0.48, 0.52);
        var wallColor: vec3f = mix(stoneDark, stoneMid, rock.grain);
        wallColor = mix(wallColor, stoneLight, rock.brightness * 0.5);
        wallColor *= 1.0 - rock.cracks * 0.5;
        let crackColor: vec3f = vec3f(0.08, 0.08, 0.10);
        wallColor = mix(wallColor, crackColor, rock.cracks * 0.3);
        let depthShade: f32 = smoothstep(0.0, 0.4, wallEdge);
        wallColor *= 0.75 + depthShade * 0.25;
        color = mix(color, wallColor, wallEdge * 0.95);
    }

    // ========================================================================
    // Player 1 Built Factory
    // ========================================================================
    if (p1BuiltFactoryDensity > factoryThreshold * 0.25) {
        var blobStrength: f32 = smoothstep(factoryThreshold * 0.25, factoryThreshold + 3.0, p1BuiltFactoryDensity);

        let centerCell: vec4f = textureSampleLevel(u_state0, u_sampler, worldUV, 0.0);
        var resources: f32 = 0.0;
        if (isMiningFactory(centerCell) && isPlayer1(centerCell)) {
            resources = getFactoryResourceCount(centerCell);
        }
        let energyLevel: f32 = min(resources / 10.0, 1.0);

        let throb: f32 = sin(params.time * 4.0) * 0.4 + 0.6;
        let fastThrob: f32 = sin(params.time * 10.0) * 0.25 + 0.75;
        let ultraThrob: f32 = sin(params.time * 2.0) * 0.5 + 0.5;

        let purpleDark: vec3f = vec3f(0.6, 0.2, 0.8);
        let purpleBright: vec3f = vec3f(1.2, 0.6, 1.3);
        var factoryColor: vec3f = mix(purpleDark, purpleBright, 0.5 + energyLevel * 0.5);
        factoryColor *= (0.7 + throb * 0.5 + ultraThrob * 0.3);

        let coreGlow: f32 = smoothstep(factoryThreshold * 0.5, factoryThreshold + 3.0, p1BuiltFactoryDensity);
        factoryColor += vec3f(0.6, 0.3, 0.8) * coreGlow * fastThrob * 1.5;

        for (var ring: i32 = 0; ring < 3; ring++) {
            let ringOffset: f32 = f32(ring) * 0.33;
            let beaconPhase: f32 = fract(params.time * 0.4 + ringOffset);
            let beaconRadius: f32 = beaconPhase * 6.0;
            let distFromCenter: f32 = factoryThreshold + 3.0 - p1BuiltFactoryDensity;
            let beaconRing: f32 = smoothstep(beaconRadius - 0.8, beaconRadius, distFromCenter) *
                                  smoothstep(beaconRadius + 0.8, beaconRadius, distFromCenter);
            factoryColor += vec3f(1.0, 0.6, 1.0) * beaconRing * (1.0 - beaconPhase) * 0.4;
        }

        let haloStrength: f32 = smoothstep(factoryThreshold * 0.2, factoryThreshold * 0.6, p1BuiltFactoryDensity);
        let haloColor: vec3f = vec3f(0.8, 0.4, 1.0) * haloStrength * (0.4 + ultraThrob * 0.4);
        color = color + haloColor * 0.5;

        if (energyLevel > 0.2) {
            factoryColor += vec3f(0.2, 0.1, 0.25) * energyLevel;
            let sparkle: f32 = fract(sin(dot(pixelPos + params.time * 12.0, vec2f(12.9898, 78.233))) * 43758.5453);
            if (sparkle > 0.88) {
                factoryColor += vec3f(0.8, 0.5, 0.9);
            }
        }

        color = mix(color, factoryColor, blobStrength);
    }

    // ========================================================================
    // Player 2 Built Factory
    // ========================================================================
    if (p2BuiltFactoryDensity > factoryThreshold * 0.25) {
        var blobStrength: f32 = smoothstep(factoryThreshold * 0.25, factoryThreshold + 3.0, p2BuiltFactoryDensity);

        let centerCell: vec4f = textureSampleLevel(u_state0, u_sampler, worldUV, 0.0);
        var resources: f32 = 0.0;
        if (isMiningFactory(centerCell) && isPlayer2(centerCell)) {
            resources = getFactoryResourceCount(centerCell);
        }
        let energyLevel: f32 = min(resources / 10.0, 1.0);

        let throb: f32 = sin(params.time * 4.0) * 0.4 + 0.6;
        let fastThrob: f32 = sin(params.time * 10.0) * 0.25 + 0.75;
        let ultraThrob: f32 = sin(params.time * 2.0) * 0.5 + 0.5;

        let greenDark: vec3f = vec3f(0.2, 0.6, 0.5);
        let greenBright: vec3f = vec3f(0.5, 1.3, 0.7);
        var factoryColor: vec3f = mix(greenDark, greenBright, 0.5 + energyLevel * 0.5);
        factoryColor *= (0.7 + throb * 0.5 + ultraThrob * 0.3);

        let coreGlow: f32 = smoothstep(factoryThreshold * 0.5, factoryThreshold + 3.0, p2BuiltFactoryDensity);
        factoryColor += vec3f(0.3, 0.8, 0.5) * coreGlow * fastThrob * 1.5;

        for (var ring: i32 = 0; ring < 3; ring++) {
            let ringOffset: f32 = f32(ring) * 0.33;
            let beaconPhase: f32 = fract(params.time * 0.4 + ringOffset);
            let beaconRadius: f32 = beaconPhase * 6.0;
            let distFromCenter: f32 = factoryThreshold + 3.0 - p2BuiltFactoryDensity;
            let beaconRing: f32 = smoothstep(beaconRadius - 0.8, beaconRadius, distFromCenter) *
                                  smoothstep(beaconRadius + 0.8, beaconRadius, distFromCenter);
            factoryColor += vec3f(0.5, 1.0, 0.7) * beaconRing * (1.0 - beaconPhase) * 0.4;
        }

        let haloStrength: f32 = smoothstep(factoryThreshold * 0.2, factoryThreshold * 0.6, p2BuiltFactoryDensity);
        let haloColor: vec3f = vec3f(0.4, 1.0, 0.6) * haloStrength * (0.4 + ultraThrob * 0.4);
        color = color + haloColor * 0.5;

        if (energyLevel > 0.2) {
            factoryColor += vec3f(0.1, 0.25, 0.15) * energyLevel;
            let sparkle: f32 = fract(sin(dot(pixelPos + params.time * 12.0, vec2f(12.9898, 78.233))) * 43758.5453);
            if (sparkle > 0.88) {
                factoryColor += vec3f(0.5, 0.9, 0.6);
            }
        }

        color = mix(color, factoryColor, blobStrength);
    }

    // ========================================================================
    // Player 1 Unbuilt Factory
    // ========================================================================
    if (p1UnbuiltFactoryDensity > factoryThreshold) {
        let blobStrength: f32 = smoothstep(factoryThreshold, factoryThreshold + 1.5, p1UnbuiltFactoryDensity);
        let grayColor: vec3f = vec3f(0.25, 0.22, 0.28);
        let purpleColor: vec3f = vec3f(0.5, 0.2, 0.6);
        var unbuiltColor: vec3f = mix(grayColor, purpleColor, p1BuildProgress);
        let constructPulse: f32 = sin(params.time * 2.0) * 0.5 + 0.5;
        unbuiltColor += vec3f(0.05, 0.02, 0.08) * constructPulse;
        let grid: f32 = step(0.5, fract(pixelPos.x * 0.5)) * step(0.5, fract(pixelPos.y * 0.5));
        unbuiltColor *= 0.9 + grid * 0.1;
        color = mix(color, unbuiltColor, blobStrength);
    }

    // ========================================================================
    // Player 2 Unbuilt Factory
    // ========================================================================
    if (p2UnbuiltFactoryDensity > factoryThreshold) {
        let blobStrength: f32 = smoothstep(factoryThreshold, factoryThreshold + 1.5, p2UnbuiltFactoryDensity);
        let grayColor: vec3f = vec3f(0.22, 0.25, 0.23);
        let greenColor: vec3f = vec3f(0.2, 0.5, 0.3);
        var unbuiltColor: vec3f = mix(grayColor, greenColor, p2BuildProgress);
        let constructPulse: f32 = sin(params.time * 2.0) * 0.5 + 0.5;
        unbuiltColor += vec3f(0.02, 0.08, 0.04) * constructPulse;
        let grid: f32 = step(0.5, fract(pixelPos.x * 0.5)) * step(0.5, fract(pixelPos.y * 0.5));
        unbuiltColor *= 0.9 + grid * 0.1;
        color = mix(color, unbuiltColor, blobStrength);
    }

    // ========================================================================
    // MISSILES
    // ========================================================================
    let missileThreshold: f32 = 0.5;

    // Player 1 Missile
    if (p1MissileDensity > missileThreshold) {
        var blobStrength: f32 = smoothstep(missileThreshold, missileThreshold + 2.0, p1MissileDensity);
        let throb: f32 = sin(params.time * 2.0) * 0.3 + 0.7;
        let warningPulse: f32 = sin(params.time * 8.0) * 0.5 + 0.5;

        var missileColor: vec3f;
        if (d.p1MissileArmed > 0.0 || d.p1MissileMoving > 0.0) {
            let armedBase: vec3f = vec3f(0.0, 0.4, 0.5);
            let armedGlow: vec3f = vec3f(0.2, 1.0, 1.0);
            missileColor = mix(armedBase, armedGlow, 0.3 + throb * 0.3);
            let warningRed: vec3f = vec3f(1.0, 0.2, 0.1);
            missileColor += warningRed * warningPulse * 0.3;
        } else {
            let buildingBase: vec3f = vec3f(0.3, 0.1, 0.4);
            let buildingGlow: vec3f = vec3f(0.8, 0.3, 1.0);
            missileColor = mix(buildingBase, buildingGlow, 0.3 + throb * 0.3);
        }

        if (d.p1MissileSelected > 0.0 && params.currentPlayer == PLAYER_1) {
            let selectPulse: f32 = sin(params.time * 8.0) * 0.5 + 0.5;
            let selectGlow: vec3f = vec3f(1.0, 1.0, 0.5);
            missileColor = mix(missileColor, selectGlow, 0.5 + selectPulse * 0.3);
        }

        if (p1MissileExplosion > 0.0) {
            let explosionIntensity: f32 = smoothstep(0.0, 2.0, p1MissileExplosion);
            let explosionColor: vec3f = vec3f(1.0, 0.8, 0.3);
            let fireColor: vec3f = vec3f(1.0, 0.3, 0.1);
            let explosionPhase: f32 = fract(params.time * 3.0);
            missileColor = mix(explosionColor, fireColor, explosionPhase);
            missileColor *= 1.5 + explosionIntensity;
            blobStrength = 1.0;
        }

        color = mix(color, missileColor, blobStrength);
    }

    // Player 2 Missile
    if (p2MissileDensity > missileThreshold) {
        var blobStrength: f32 = smoothstep(missileThreshold, missileThreshold + 2.0, p2MissileDensity);
        let throb: f32 = sin(params.time * 2.0) * 0.3 + 0.7;
        let warningPulse: f32 = sin(params.time * 8.0) * 0.5 + 0.5;

        var missileColor: vec3f;
        if (d.p2MissileArmed > 0.0 || d.p2MissileMoving > 0.0) {
            let armedBase: vec3f = vec3f(0.5, 0.4, 0.0);
            let armedGlow: vec3f = vec3f(1.0, 1.0, 0.2);
            missileColor = mix(armedBase, armedGlow, 0.3 + throb * 0.3);
            let warningRed: vec3f = vec3f(1.0, 0.2, 0.1);
            missileColor += warningRed * warningPulse * 0.3;
        } else {
            let buildingBase: vec3f = vec3f(0.1, 0.3, 0.25);
            let buildingGlow: vec3f = vec3f(0.3, 1.0, 0.6);
            missileColor = mix(buildingBase, buildingGlow, 0.3 + throb * 0.3);
        }

        if (d.p2MissileSelected > 0.0 && params.currentPlayer == PLAYER_2) {
            let selectPulse: f32 = sin(params.time * 8.0) * 0.5 + 0.5;
            let selectGlow: vec3f = vec3f(1.0, 1.0, 0.5);
            missileColor = mix(missileColor, selectGlow, 0.5 + selectPulse * 0.3);
        }

        if (p2MissileExplosion > 0.0) {
            let explosionIntensity: f32 = smoothstep(0.0, 2.0, p2MissileExplosion);
            let explosionColor: vec3f = vec3f(1.0, 0.8, 0.3);
            let fireColor: vec3f = vec3f(1.0, 0.3, 0.1);
            let explosionPhase: f32 = fract(params.time * 3.0);
            missileColor = mix(explosionColor, fireColor, explosionPhase);
            missileColor *= 1.5 + explosionIntensity;
            blobStrength = 1.0;
        }

        color = mix(color, missileColor, blobStrength);
    }

    // ========================================================================
    // Demolish
    // ========================================================================
    let demolishDensity: f32 = d.demolishDens;
    if (demolishDensity > factoryThreshold) {
        let blobStrength: f32 = smoothstep(factoryThreshold, factoryThreshold + 1.5, demolishDensity);
        let flash: f32 = sin(params.time * 6.0) * 0.5 + 0.5;
        let redColor: vec3f = vec3f(0.8, 0.2, 0.1);
        let orangeColor: vec3f = vec3f(1.0, 0.5, 0.1);
        var demolishColor: vec3f = mix(redColor, orangeColor, flash);
        let sparks: f32 = fract(sin(dot(pixelPos + params.time * 20.0, vec2f(12.9898, 78.233))) * 43758.5453);
        if (sparks > 0.9) {
            demolishColor += vec3f(0.5, 0.3, 0.0);
        }
        color = mix(color, demolishColor, blobStrength);
    }

    // ========================================================================
    // Explosion particles
    // ========================================================================
    let explosionThreshold: f32 = 0.3;
    if (d.explosionDensity > explosionThreshold) {
        let blobStrength: f32 = smoothstep(explosionThreshold, explosionThreshold + 2.0, d.explosionDensity);
        let lifeRatio: f32 = d.explosionLifeAvg / EXPLOSION_PARTICLE_LIFETIME_F;
        let youngColor: vec3f = vec3f(1.0, 1.0, 0.3);
        let oldColor: vec3f = vec3f(1.0, 0.15, 0.0);
        var fireColor: vec3f = mix(oldColor, youngColor, lifeRatio);
        let flicker: f32 = 0.7 + 0.3 * sin(pixelPos.x * 15.0 + pixelPos.y * 11.0 + params.time * 20.0);
        fireColor *= flicker;
        fireColor *= 1.3;
        color = mix(color, fireColor, blobStrength);
    }

    } // end of if (!outOfBounds) block

    // ========================================================================
    // Selection UI Overlay (screen-space)
    // ========================================================================

    if (params.isSelecting > 0.5) {
        let boxMin: vec2f = min(params.selectionStart, params.selectionEnd);
        let boxMax: vec2f = max(params.selectionStart, params.selectionEnd);
        let borderWidth: f32 = 2.0 / params.canvasResolution.x;

        let inBox: bool = in.uv.x >= boxMin.x && in.uv.x <= boxMax.x &&
                          in.uv.y >= boxMin.y && in.uv.y <= boxMax.y;
        let inInnerBox: bool = in.uv.x >= boxMin.x + borderWidth && in.uv.x <= boxMax.x - borderWidth &&
                               in.uv.y >= boxMin.y + borderWidth && in.uv.y <= boxMax.y - borderWidth;

        if (inBox) {
            if (!inInnerBox) {
                color = mix(color, vec3f(1.0), 0.8);
            } else {
                color = mix(color, vec3f(1.0), 0.1);
            }
        }
    }

    // Command crosshair
    if (params.hasActiveSelection > 0.5) {
        let cursorDist: vec2f = abs(in.uv - params.mousePos);
        let pixelSize: f32 = 1.0 / params.canvasResolution.x;
        let crossSize: f32 = 15.0 * pixelSize;
        let crossWidth: f32 = 2.0 * pixelSize;
        let gapSize: f32 = 4.0 * pixelSize;

        let onHorizontal: bool = cursorDist.y < crossWidth &&
                                 cursorDist.x > gapSize && cursorDist.x < crossSize;
        let onVertical: bool = cursorDist.x < crossWidth &&
                               cursorDist.y > gapSize && cursorDist.y < crossSize;

        if (onHorizontal || onVertical) {
            let pulse: f32 = sin(params.time * 4.0) * 0.2 + 0.8;
            let crosshairColor: vec3f = vec3f(1.0, 0.85, 0.3) * pulse;
            color = mix(color, crosshairColor, 0.9);
        }

        let centerDist: f32 = length(cursorDist);
        if (centerDist < 3.0 * pixelSize) {
            color = vec3f(1.0, 0.85, 0.3);
        }
    }

    // Delete mode indicator
    if (params.shiftHeld > 0.5) {
        let baseRadiusUV: f32 = params.deleteRadius / params.resolution.x / params.cameraZoom;
        var radiusUV: vec2f;
        if (params.aspectRatio >= 1.0) {
            radiusUV = vec2f(baseRadiusUV / params.aspectRatio, baseRadiusUV);
        } else {
            radiusUV = vec2f(baseRadiusUV, baseRadiusUV * params.aspectRatio);
        }
        let boxMin: vec2f = params.mousePos - radiusUV;
        let boxMax: vec2f = params.mousePos + radiusUV;
        let borderWidth: f32 = 2.0 / params.canvasResolution.x;

        let inBox: bool = in.uv.x >= boxMin.x && in.uv.x <= boxMax.x &&
                          in.uv.y >= boxMin.y && in.uv.y <= boxMax.y;
        let inInnerBox: bool = in.uv.x >= boxMin.x + borderWidth && in.uv.x <= boxMax.x - borderWidth &&
                               in.uv.y >= boxMin.y + borderWidth && in.uv.y <= boxMax.y - borderWidth;

        if (inBox) {
            let pulse: f32 = sin(params.time * 3.0) * 0.15 + 0.85;
            let deleteColor: vec3f = vec3f(1.0, 0.3, 0.3);
            if (!inInnerBox) {
                color = mix(color, deleteColor * pulse, 0.8);
            } else {
                color = mix(color, deleteColor, 0.15);
            }
        }
    }

    // ========================================================================
    // MINIMAP
    // ========================================================================
    {
        let minimapBaseSize: f32 = 0.2;
        let minimapMargin: f32 = 0.02;
        var minimapSize: vec2f;
        if (params.aspectRatio >= 1.0) {
            minimapSize = vec2f(minimapBaseSize / params.aspectRatio, minimapBaseSize);
        } else {
            minimapSize = vec2f(minimapBaseSize, minimapBaseSize * params.aspectRatio);
        }
        let minimapOrigin: vec2f = vec2f(minimapMargin, minimapMargin);
        let minimapUV: vec2f = (in.uv - minimapOrigin) / minimapSize;

        if (minimapUV.x >= 0.0 && minimapUV.x <= 1.0 &&
            minimapUV.y >= 0.0 && minimapUV.y <= 1.0) {

            var minimapColor: vec3f = vec3f(0.02, 0.04, 0.06);
            let borderWidth: f32 = 0.02;
            let onBorder: bool = minimapUV.x < borderWidth || minimapUV.x > 1.0 - borderWidth ||
                                 minimapUV.y < borderWidth || minimapUV.y > 1.0 - borderWidth;

            if (onBorder) {
                minimapColor = vec3f(0.3, 0.35, 0.4);
            } else {
                let worldSampleUV: vec2f = minimapUV;
                var resourceDens: f32 = 0.0;
                var p1FactoryDens: f32 = 0.0;
                var p2FactoryDens: f32 = 0.0;
                var p1UnitDens: f32 = 0.0;
                var p2UnitDens: f32 = 0.0;
                var wallDens: f32 = 0.0;

                let blockSize: f32 = 4.0 / params.resolution.x;
                for (var mdy: i32 = 0; mdy < 4; mdy++) {
                    for (var mdx: i32 = 0; mdx < 4; mdx++) {
                        let sampleOffset: vec2f = vec2f(f32(mdx), f32(mdy)) * blockSize / 4.0;
                        let sampleUV: vec2f = worldSampleUV + sampleOffset;
                        let cell: vec4f = textureSampleLevel(u_state0, u_sampler, sampleUV, 0.0);
                        let cellType: f32 = getCellType(cell);

                        if (cellType == CELL_RESOURCE) {
                            resourceDens += 1.0;
                        } else if (cellType == CELL_WALL) {
                            wallDens += 1.0;
                        } else if (isMiningFactory(cell)) {
                            let player: f32 = getPlayerFromCell(cell);
                            if (player == PLAYER_1) {
                                p1FactoryDens += 8.0;
                            } else {
                                p2FactoryDens += 8.0;
                            }
                        } else if (isMiningUnit(cell)) {
                            let player: f32 = getPlayerFromCell(cell);
                            if (player == PLAYER_1) {
                                p1UnitDens += 1.0;
                            } else {
                                p2UnitDens += 1.0;
                            }
                        }
                    }
                }

                resourceDens /= 16.0;
                p1FactoryDens /= 16.0;
                p2FactoryDens /= 16.0;
                p1UnitDens /= 16.0;
                p2UnitDens /= 16.0;
                wallDens /= 16.0;

                let throb: f32 = sin(params.time * 5.0) * 0.5 + 0.5;
                let fastThrob: f32 = sin(params.time * 12.0) * 0.3 + 0.7;
                let ultraThrob: f32 = sin(params.time * 2.5) * 0.4 + 0.6;

                if (resourceDens > 0.0) {
                    minimapColor = mix(minimapColor, vec3f(0.6, 0.5, 0.2), resourceDens * 0.8);
                }
                if (wallDens > 0.0) {
                    minimapColor = mix(minimapColor, vec3f(0.3, 0.35, 0.4), wallDens * 0.7);
                }
                if (p1UnitDens > 0.0) {
                    minimapColor = mix(minimapColor, vec3f(0.8, 0.35, 0.9), p1UnitDens);
                }
                if (p2UnitDens > 0.0) {
                    minimapColor = mix(minimapColor, vec3f(0.35, 0.8, 0.7), p2UnitDens);
                }
                if (p1FactoryDens > 0.0) {
                    let combinedThrob: f32 = 0.5 + throb * 0.3 + ultraThrob * 0.2;
                    let factoryCore: vec3f = vec3f(1.3, 0.5, 1.4) * combinedThrob;
                    let factoryGlow: vec3f = vec3f(0.9, 0.3, 1.0) * fastThrob;
                    let factoryStrength: f32 = min(p1FactoryDens * 3.0, 1.0);
                    minimapColor = mix(minimapColor, factoryCore, factoryStrength);
                    minimapColor += factoryGlow * factoryStrength * 0.3;
                }
                if (p2FactoryDens > 0.0) {
                    let combinedThrob: f32 = 0.5 + throb * 0.3 + ultraThrob * 0.2;
                    let factoryCore: vec3f = vec3f(0.5, 1.4, 0.7) * combinedThrob;
                    let factoryGlow: vec3f = vec3f(0.3, 1.0, 0.5) * fastThrob;
                    let factoryStrength: f32 = min(p2FactoryDens * 3.0, 1.0);
                    minimapColor = mix(minimapColor, factoryCore, factoryStrength);
                    minimapColor += factoryGlow * factoryStrength * 0.3;
                }

                // Viewport rectangle
                let viewportCenter: vec2f = params.cameraPos / params.resolution;
                let baseViewportSize: f32 = 1.0 / params.cameraZoom;
                var viewportSize: vec2f;
                if (params.aspectRatio >= 1.0) {
                    viewportSize = vec2f(baseViewportSize * params.aspectRatio, baseViewportSize);
                } else {
                    viewportSize = vec2f(baseViewportSize, baseViewportSize / params.aspectRatio);
                }
                let viewportMin: vec2f = viewportCenter - viewportSize * 0.5;
                let viewportMax: vec2f = viewportCenter + viewportSize * 0.5;

                let viewBorderWidth: f32 = 0.01;
                var onViewBorder: bool = false;
                if (minimapUV.x >= viewportMin.x && minimapUV.x <= viewportMax.x &&
                    minimapUV.y >= viewportMin.y && minimapUV.y <= viewportMax.y) {
                    if (minimapUV.x < viewportMin.x + viewBorderWidth || minimapUV.x > viewportMax.x - viewBorderWidth ||
                        minimapUV.y < viewportMin.y + viewBorderWidth || minimapUV.y > viewportMax.y - viewBorderWidth) {
                        onViewBorder = true;
                    }
                }
                if (onViewBorder) {
                    minimapColor = mix(minimapColor, vec3f(1.0, 1.0, 1.0), 0.7);
                }
            }

            color = mix(color, minimapColor, 0.9);
        }
    }

    // Vignette
    let vignette: f32 = 1.0 - length(in.uv - 0.5) * 0.3;
    color *= vignette;

    // Gamma
    color = pow(color, vec3f(0.95));

    return vec4f(color, 1.0);
}
