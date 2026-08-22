// Random/Hash Functions - xorshift128++ based
//
// Uses xorshift128++ algorithm adapted for stateless shader use.

// Initialize state from position and time
fn xorshiftSeed(pos: vec2f, time: f32) -> vec4u {
    let px: u32 = u32(i32(floor(pos.x + 0.5)));
    let py: u32 = u32(i32(floor(pos.y + 0.5)));
    let t: u32 = u32(i32(floor(time)));

    var s: vec4u;
    s.x = (px * 73856093u) ^ (py * 19349663u) ^ (t * 83492791u);
    s.y = (px * 41729371u) ^ (py * 73856093u) ^ (t * 19349663u);
    s.z = (px * 83492791u) ^ (py * 41729371u) ^ (t * 73856093u);
    s.w = (px * 19349663u) ^ (py * 83492791u) ^ (t * 41729371u);

    if (s.x == 0u && s.y == 0u && s.z == 0u && s.w == 0u) {
        s.x = 1u;
    }

    return s;
}

// Single xorshift128++ iteration
fn xorshift128pp(s: ptr<function, vec4u>) -> u32 {
    var t: u32 = (*s).x;
    let const_s: u32 = (*s).w;

    (*s).x = (*s).y;
    (*s).y = (*s).z;
    (*s).z = (*s).w;

    t ^= t << 11u;
    t ^= t >> 8u;
    (*s).w = t ^ const_s ^ (const_s >> 19u);

    return (*s).w + (*s).y;
}

// Get a random uint from position and time
fn hashUint(pos: vec2f, time: f32) -> u32 {
    var state: vec4u = xorshiftSeed(pos, time);
    xorshift128pp(&state);
    xorshift128pp(&state);
    return xorshift128pp(&state);
}

// Get a float 0.0-1.0 from position and time
fn hash(pos: vec2f, time: f32) -> f32 {
    let h: u32 = hashUint(pos, time);
    return f32(h) / 4294967296.0;
}

// Get a second independent random value
fn hash2(pos: vec2f, time: f32) -> f32 {
    return hash(pos, time + 10000.0);
}

// Random direction 1-8 (including diagonals)
fn randomDir(pos: vec2f, time: f32) -> i32 {
    let h: u32 = hashUint(pos, time);
    return i32(h % 8u) + 1;
}

// Random direction 1-4 (cardinal only)
fn randomDir4(pos: vec2f, time: f32) -> i32 {
    let h: u32 = hashUint(pos, time);
    return i32(h % 4u) + 1;
}

// Direction toward target
fn dirToward(from_pos: vec2f, to_pos: vec2f, seed: f32) -> i32 {
    let diff: vec2f = to_pos - from_pos;

    if (abs(diff.x) < 0.5 && abs(diff.y) < 0.5) {
        return 0;
    }

    let canX: bool = abs(diff.x) > 0.5;
    let canY: bool = abs(diff.y) > 0.5;

    if (canX && canY) {
        if (diff.x > 0.0 && diff.y > 0.0) { return 5; }
        if (diff.x < 0.0 && diff.y > 0.0) { return 6; }
        if (diff.x < 0.0 && diff.y < 0.0) { return 7; }
        if (diff.x > 0.0 && diff.y < 0.0) { return 8; }
    } else if (canX) {
        if (diff.x > 0.0) { return 1; } else { return 3; }
    } else if (canY) {
        if (diff.y > 0.0) { return 2; } else { return 4; }
    }

    return 0;
}
