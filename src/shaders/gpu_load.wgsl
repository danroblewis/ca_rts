// Synthetic GPU load - burns a configurable amount of ALU time per dispatch.
//
// Used to simulate a slow GPU (?gpuload=N / window.setGpuLoad(N)) so the
// quality ladder's automatic adjustment can be exercised on a fast machine.
// The result is written to a buffer so the work cannot be optimised away.

struct LoadParams {
    iterations: u32,
    seed: u32,
    _a: u32,
    _b: u32,
}

@group(0) @binding(0) var<uniform> params: LoadParams;
@group(0) @binding(1) var<storage, read_write> sink: array<f32>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    var x: f32 = f32(gid.x) * 0.001 + f32(params.seed) * 0.0001;
    for (var i: u32 = 0u; i < params.iterations; i++) {
        x = sin(x) * 1.7 + cos(x * 0.31) * 0.9;
    }
    sink[gid.x % 1024u] = x;
}
