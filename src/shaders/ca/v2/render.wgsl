// Debug Render Shader (WebGPU)
//
// Simple per-cell color rendering without metaball effects.
// Shows exact cell contents for debugging.

#include "../../common/cell_types.wgsl"

// ============================================================================
// BINDINGS
// ============================================================================

// Debug shader only uses current frame (state0)
@group(0) @binding(0) var u_state0: texture_2d<f32>;
@group(0) @binding(1) var u_sampler: sampler;
@group(0) @binding(2) var<uniform> params: RenderParams;

struct RenderParams {
    resolution: vec2f,          // Grid resolution
    canvasResolution: vec2f,    // Canvas pixel resolution
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
    quality: f32,
    _pad1: f32,
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
// HELPERS
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

// Integer-based type helpers for debug render
fn getTypeI(raw: vec4f) -> i32 {
    return i32(floor(raw.r + 0.5));
}

fn isUnitI(cellType: i32) -> bool {
    return cellType == 2 || cellType == 5;
}

fn isFactoryI(cellType: i32) -> bool {
    return cellType == 3 || cellType == 7;
}

fn isMissileI(cellType: i32) -> bool {
    return cellType == 8 || cellType == 9;
}

fn isExplosionI(cellType: i32) -> bool {
    return cellType == 10;
}

fn getPlayerI(cellType: i32) -> i32 {
    if (cellType == 2 || cellType == 3 || cellType == 8) { return 1; }
    if (cellType == 5 || cellType == 7 || cellType == 9) { return 2; }
    return 0;
}

fn getUnitHoldingI(raw: vec4f) -> bool {
    return (floor(raw.g) % 2.0) > 0.5;
}

fn getUnitAgeI(raw: vec4f) -> f32 {
    return floor(raw.g / 64.0);
}

fn getFactoryPosI(raw: vec4f) -> vec2f {
    return vec2f(raw.b, raw.a);
}

fn getFactoryResourcesI(raw: vec4f) -> f32 {
    return raw.g;
}

fn getFactoryBuildProgressI(raw: vec4f) -> f32 {
    return raw.g;
}

fn getDemolishCenterI(raw: vec4f) -> vec2f {
    return vec2f(raw.b, raw.a);
}

fn getMissileStateI(raw: vec4f) -> i32 {
    return i32(floor(raw.g / 16.0) % 4.0);
}

fn getMissileExplosionTimerI(raw: vec4f) -> i32 {
    return i32(floor(raw.g / 64.0) % 16.0);
}

fn getMissileCenterI(raw: vec4f) -> vec2f {
    let packed: f32 = raw.a;
    if (packed < 0.0) { return vec2f(-1.0); }
    return vec2f(packed % 512.0, floor(packed / 512.0));
}

fn getExplosionLifetimeI(raw: vec4f) -> i32 {
    return i32(raw.g);
}

fn sumFactoryBuildProgressDebug(centerPos: vec2f) -> f32 {
    var total: f32 = 0.0;
    for (var dy: i32 = -1; dy <= 1; dy++) {
        for (var dx: i32 = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) { continue; }
            let cellPos: vec2f = centerPos + vec2f(f32(dx), f32(dy));
            let sampleUV: vec2f = (cellPos + 0.5) / params.resolution;
            let cellRaw: vec4f = textureSampleLevel(u_state0, u_sampler, sampleUV, 0.0);
            if (isFactoryI(getTypeI(cellRaw))) {
                total += getFactoryBuildProgressI(cellRaw);
            }
        }
    }
    return total;
}

// ============================================================================
// FRAGMENT SHADER
// ============================================================================

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let worldUV: vec2f = screenToWorldUV(in.uv);

    if (!isInBounds(worldUV)) {
        return vec4f(0.02, 0.03, 0.05, 1.0);
    }

    let raw: vec4f = textureSampleLevel(u_state0, u_sampler, worldUV, 0.0);
    let cellType: i32 = getTypeI(raw);
    let pos: vec2f = floor(worldUV * params.resolution);

    var color: vec3f;

    if (cellType == 0) {
        // EMPTY
        color = vec3f(0.08, 0.1, 0.14);
    }
    else if (cellType == 1) {
        // RESOURCE
        color = vec3f(0.9, 0.7, 0.2);
    }
    else if (isUnitI(cellType)) {
        let age: f32 = getUnitAgeI(raw);
        let ageRatio: f32 = age / MAX_AGE;
        let player: i32 = getPlayerI(cellType);

        var baseColor: vec3f;
        if (player == 1) {
            if (getUnitHoldingI(raw)) {
                baseColor = vec3f(0.95, 0.4, 0.8);
            } else {
                baseColor = vec3f(0.6, 0.4, 1.0);
            }
        } else {
            if (getUnitHoldingI(raw)) {
                baseColor = vec3f(0.4, 0.95, 0.35);
            } else {
                baseColor = vec3f(0.3, 0.85, 0.7);
            }
        }

        let fadeStart: f32 = 0.3;
        let deathFlashStart: f32 = 0.9;

        if (ageRatio < fadeStart) {
            color = baseColor;
        } else if (ageRatio < deathFlashStart) {
            let fadeFactor: f32 = (ageRatio - fadeStart) / (deathFlashStart - fadeStart);
            color = baseColor * (1.0 - fadeFactor * 0.7);
        } else {
            let deathProgress: f32 = (ageRatio - deathFlashStart) / (1.0 - deathFlashStart);
            if (deathProgress < 0.3) {
                let flashIntensity: f32 = deathProgress / 0.3;
                color = mix(baseColor * 0.3, vec3f(1.0, 1.0, 1.0), flashIntensity);
            } else {
                let fadeOut: f32 = (deathProgress - 0.3) / 0.7;
                color = mix(vec3f(1.0, 1.0, 1.0), vec3f(0.05), fadeOut);
            }
        }
    }
    else if (isFactoryI(cellType)) {
        let factoryCenter: vec2f = getFactoryPosI(raw);
        let totalBuildProgress: f32 = sumFactoryBuildProgressDebug(factoryCenter);
        let isBuilt: bool = totalBuildProgress >= BUILD_THRESHOLD;
        let player: i32 = getPlayerI(cellType);

        let builtColor: vec3f = select(vec3f(0.2, 0.8, 0.4), vec3f(0.7, 0.2, 0.8), player == 1);
        let unbuiltColor: vec3f = select(vec3f(0.2, 0.6, 0.3), vec3f(0.5, 0.2, 0.7), player == 1);

        if (isBuilt) {
            let brightness: f32 = 0.5 + min(getFactoryResourcesI(raw) / 10.0, 0.5);
            color = builtColor * brightness;
        } else {
            let buildProgress: f32 = getFactoryBuildProgressI(raw);
            let progress: f32 = buildProgress / MAX_BUILD_PER_CELL;
            let baseBrightness: f32 = 0.2;
            let maxBrightness: f32 = 0.6;
            let brightness: f32 = baseBrightness + progress * (maxBrightness - baseBrightness);
            let pulse: f32 = 0.8 + 0.2 * sin(factoryCenter.x * 0.5 + factoryCenter.y * 0.5);
            color = unbuiltColor * brightness * pulse;
        }
    }
    else if (cellType == 4) {
        // WALL
        color = vec3f(0.35, 0.35, 0.4);
    }
    else if (cellType == 6) {
        // DEMOLISH
        let demolishCenter: vec2f = getDemolishCenterI(raw);
        let pulse: f32 = 0.7 + 0.3 * sin(demolishCenter.x * 0.3 + demolishCenter.y * 0.3);
        color = vec3f(0.9, 0.3, 0.2) * 0.6 * pulse;
    }
    else if (isMissileI(cellType)) {
        let missileState: i32 = getMissileStateI(raw);
        let player: i32 = getPlayerI(cellType);
        let center: vec2f = getMissileCenterI(raw);
        let pulse: f32 = 0.7 + 0.3 * sin(center.x * 0.5 + center.y * 0.5);

        if (missileState == 0) {
            // BUILDING
            color = select(
                vec3f(0.6, 1.0, 0.1) * pulse,
                vec3f(1.0, 0.6, 0.1) * pulse,
                player == 1
            );
        }
        else if (missileState == 1) {
            // ARMED
            color = select(
                vec3f(1.0, 1.0, 0.0),
                vec3f(0.0, 1.0, 1.0),
                player == 1
            );
        }
        else if (missileState == 2) {
            // MOVING
            let fastPulse: f32 = 0.5 + 0.5 * sin(center.x * 2.0 + center.y * 2.0);
            color = select(
                vec3f(0.5, 1.0, 0.5) * fastPulse + vec3f(0.0, 0.5, 0.0),
                vec3f(1.0, 0.5, 0.5) * fastPulse + vec3f(0.5, 0.0, 0.0),
                player == 1
            );
        }
        else if (missileState == 3) {
            // EXPLODING
            let timer: i32 = getMissileExplosionTimerI(raw);
            let intensity: f32 = 1.0 - f32(timer) / MISSILE_EXPLOSION_DURATION;
            color = vec3f(1.0, 1.0, 0.5) * intensity + vec3f(1.0, 0.3, 0.0) * (1.0 - intensity);
        }
        else {
            color = vec3f(1.0, 0.0, 1.0);  // Unknown - magenta debug
        }
    }
    else if (isExplosionI(cellType)) {
        let lifetime: i32 = getExplosionLifetimeI(raw);
        let lifeRatio: f32 = f32(lifetime) / EXPLOSION_PARTICLE_LIFETIME_F;
        let youngColor: vec3f = vec3f(1.0, 1.0, 0.3);
        let oldColor: vec3f = vec3f(1.0, 0.2, 0.0);
        color = mix(oldColor, youngColor, lifeRatio);
        let flicker: f32 = 0.8 + 0.2 * sin(pos.x * 10.0 + pos.y * 7.0 + f32(lifetime) * 3.0);
        color *= flicker;
    }
    else {
        color = vec3f(0.0, 0.0, 0.0);  // Unknown
    }

    return vec4f(color, 1.0);
}
