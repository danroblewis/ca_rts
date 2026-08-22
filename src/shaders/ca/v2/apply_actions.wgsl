// Apply player actions to the grid on the GPU.
//
// Replaces the CPU path (download grid -> ActionApplier -> upload) that used
// to stall the frame on a 4MB readback. Every cell loops over the tick's
// actions, in order, and applies the ones that touch it. The semantics match
// src/game/ActionApplier.js exactly (verified by the action-pass unit tests),
// so both multiplayer peers and the single-player game use the same code.

#include "./core/types.wgsl"

const ACTION_PLACE_FACTORY: u32 = 1u;
const ACTION_DEMOLISH: u32 = 2u;
const ACTION_UNIT_COMMAND: u32 = 3u;
const ACTION_UNIT_SELECTION: u32 = 4u;
const ACTION_CLEAR_SELECTION: u32 = 5u;

const COMMAND_FRESHNESS: f32 = 100.0;

struct Action {
    kind: u32,
    player: u32,
    x: i32,
    y: i32,
    p0: f32,
    p1: f32,
    p2: f32,
    p3: f32,
};

struct ActionParams {
    resolution: vec2f,
    count: u32,
    _pad: u32,
};

@group(0) @binding(0) var u_state: texture_2d<f32>;
@group(0) @binding(1) var u_output: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform> params: ActionParams;
@group(0) @binding(3) var<storage, read> u_actions: array<Action>;

fn unitTypeFor(player: u32) -> i32 {
    if (player == 2u) { return TYPE_UNIT_P2; }
    return TYPE_UNIT;
}

fn factoryTypeFor(player: u32) -> i32 {
    if (player == 2u) { return TYPE_FACTORY_P2; }
    return TYPE_FACTORY;
}

fn missileTypeFor(player: u32) -> i32 {
    if (player == 2u) { return TYPE_MISSILE_P2; }
    return TYPE_MISSILE;
}

// Matches GameUtils.setUnitSelectionInG (float math on integer-valued G).
fn setUnitSelectionG(g: f32, selected: bool) -> f32 {
    let holding: f32 = floor(g) % 2.0;
    let counter: f32 = floor(g / 2.0) % 16.0;
    let age: f32 = floor(g / AGE_PACK_BASE);
    return holding + counter * 2.0 + select(0.0, SELECTED_PACK_BASE, selected) + age * AGE_PACK_BASE;
}

// Matches GameUtils.getUnitSelectedFromG
fn unitSelectedG(g: f32) -> bool {
    return (floor(g / SELECTED_PACK_BASE) % 2.0) >= 0.5;
}

// Matches GameUtils.getMissileSelectedFromG
fn missileSelectedG(g: f32) -> bool {
    return (floor(g / MISSILE_SELECTED_PACK_BASE) % 2.0) == 1.0;
}

// Matches GameUtils.getMissileStateFromG
fn missileStateG(g: f32) -> i32 {
    return i32(floor((g / 16.0) % 4.0));
}

// Matches GameUtils.setMissileSelectionInG
fn setMissileSelectionG(g: f32, selected: bool) -> f32 {
    let current: bool = missileSelectedG(g);
    if (current == selected) { return g; }
    if (selected) { return g + MISSILE_SELECTED_PACK_BASE; }
    return g - MISSILE_SELECTED_PACK_BASE;
}

fn packXY(x: f32, y: f32) -> f32 {
    if (x < 0.0 || y < 0.0) { return -1.0; }
    return floor(x) + floor(y) * COORD_PACK_BASE;
}

fn applyOne(a: Action, pos: vec2i, cellIn: vec4f) -> vec4f {
    var cell: vec4f = cellIn;
    let cellType: i32 = getType(cell);

    if (a.kind == ACTION_PLACE_FACTORY) {
        let dx: i32 = pos.x - a.x;
        let dy: i32 = pos.y - a.y;
        if (abs(dx) <= 1 && abs(dy) <= 1) {
            if (dx == 0 && dy == 0) {
                cell = vec4f(0.0, 0.0, 0.0, 0.0);
            } else {
                // p0 = resources per cell (0 for unbuilt factories)
                cell = vec4f(f32(factoryTypeFor(a.player)), a.p0, f32(a.x), f32(a.y));
            }
        }
    } else if (a.kind == ACTION_DEMOLISH) {
        let radius: i32 = i32(a.p0);
        if (abs(pos.x - a.x) <= radius && abs(pos.y - a.y) <= radius) {
            if (cellType == factoryTypeFor(a.player)) {
                let buildCount: f32 = cell.g;
                if (buildCount > 0.0) {
                    cell = vec4f(f32(TYPE_DEMOLISH), 0.0, cell.b, cell.a);
                } else {
                    cell = vec4f(0.0, 0.0, 0.0, 0.0);
                }
            }
        }
    } else if (a.kind == ACTION_UNIT_COMMAND) {
        let destX: f32 = a.p0;
        let destY: f32 = a.p1;
        if (cellType == unitTypeFor(a.player) && unitSelectedG(cell.g)) {
            let packed: f32 = packXY(destX, destY);
            cell.b = packed;
            cell.a = packed + COMMAND_FRESHNESS * MEMORY_PACK_BASE;
        }
        if (cellType == missileTypeFor(a.player) && missileSelectedG(cell.g)) {
            if (missileStateG(cell.g) == MISSILE_ARMED) {
                cell.b = packXY(destX, destY);
                let buildProgress: f32 = cell.g % 16.0;
                cell.g = buildProgress + 2.0 * 16.0;   // MISSILE_MOVING, selection cleared
            }
        }
    } else if (a.kind == ACTION_UNIT_SELECTION) {
        // region: x1 = a.x, y1 = a.y, x2 = p0, y2 = p1 (inclusive)
        if (pos.x >= a.x && pos.x <= i32(a.p0) && pos.y >= a.y && pos.y <= i32(a.p1)) {
            if (cellType == unitTypeFor(a.player)) {
                cell.g = setUnitSelectionG(cell.g, true);
            }
            if (cellType == missileTypeFor(a.player)) {
                if (missileStateG(cell.g) == MISSILE_ARMED) {
                    cell.g = setMissileSelectionG(cell.g, true);
                }
            }
        }
    } else if (a.kind == ACTION_CLEAR_SELECTION) {
        if (cellType == unitTypeFor(a.player) && unitSelectedG(cell.g)) {
            cell.g = setUnitSelectionG(cell.g, false);
        }
        if (cellType == missileTypeFor(a.player) && missileSelectedG(cell.g)) {
            cell.g = setMissileSelectionG(cell.g, false);
        }
    }

    return cell;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let pos: vec2i = vec2i(gid.xy);
    if (pos.x >= i32(params.resolution.x) || pos.y >= i32(params.resolution.y)) { return; }

    var cell: vec4f = textureLoad(u_state, pos, 0);
    for (var i: u32 = 0u; i < params.count; i++) {
        cell = applyOne(u_actions[i], pos, cell);
    }
    textureStore(u_output, pos, cell);
}
