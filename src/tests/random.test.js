/**
 * Random/Hash Determinism Tests
 * 
 * These tests verify that our hash functions produce identical results
 * across different GPU architectures (PC vs Mac M4).
 * 
 * If these tests pass on PC but fail on Mac, we've identified the problem!
 */

import { GPU } from '../gpu/GPU.js';
import { DataTexture } from '../gpu/DataTexture.js';
import { Framebuffer } from '../gpu/Framebuffer.js';
import { ComputeShader } from '../gpu/ComputeShader.js';
import { runTest, assert, assertApprox, logSection } from './framework.js';

// Test shader for ihash function
const IHASH_TEST_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_seed;

// Large prime modulus - keeps all values in safe range
const int HASH_MOD = 100003;

// Safe modulo using floor-based division for cross-platform determinism
int safeMod(int x, int m) {
    // Use native modulo operator for cross-platform determinism
    int result = x % m;
    if (result < 0) result += m;
    return result;
}

// Integer hash using safe modular arithmetic
int ihash(int x) {
    x = safeMod(x, HASH_MOD);
    x = safeMod(x * 31 + 17, HASH_MOD);
    x = safeMod(x * 37 + 23, HASH_MOD);
    x = safeMod(x * 41 + 29, HASH_MOD);
    return x;
}

void main() {
    // Each pixel tests a different input value
    int px = int(floor(gl_FragCoord.x));
    int py = int(floor(gl_FragCoord.y));
    int testIndex = py * 16 + px;
    
    // Create inputVal based on test index and seed
    int inputVal = testIndex * 1000 + int(floor(u_seed));
    int result = ihash(inputVal);
    
    // Encode result in RGBA (split into bytes)
    float r = float(safeMod(result, 256)) / 255.0;
    float g = float(safeMod(result / 256, 256)) / 255.0;
    float b = float(safeMod(result / 65536, 256)) / 255.0;
    float a = 1.0;
    
    fragColor = vec4(r, g, b, a);
}`;

// Test shader for hashPosTime function
const HASH_POS_TIME_TEST_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
uniform float u_textureSize;

const int HASH_MOD = 100003;

int safeMod(int x, int m) {
    // Use native modulo operator for cross-platform determinism
    int result = x % m;
    if (result < 0) result += m;
    return result;
}

int ihash(int x) {
    x = safeMod(x, HASH_MOD);
    x = safeMod(x * 31 + 17, HASH_MOD);
    x = safeMod(x * 37 + 23, HASH_MOD);
    x = safeMod(x * 41 + 29, HASH_MOD);
    return x;
}

int hashPosTime(vec2 pos, float time) {
    // Use floor() explicitly for cross-platform determinism
    int px = int(floor(pos.x + 0.5));
    int py = int(floor(pos.y + 0.5));
    int t = int(floor(time));
    
    px = safeMod(px, 1009);
    py = safeMod(py, 1013);
    t = safeMod(t, 10007);
    
    int h = px * 73 + py * 71 + t * 83;
    return ihash(h);
}

float hash(vec2 p, float time) {
    int h = hashPosTime(p, time);
    return float(h) / float(HASH_MOD);
}

void main() {
    // Match JS position calculation: Math.floor((px / textureSize) * 512)
    vec2 pixelCoord = floor(gl_FragCoord.xy);
    vec2 pos = floor(pixelCoord / u_textureSize * 512.0);
    
    float hashResult = hash(pos, u_time);
    
    // Output hash value directly (0-1 range fits in R channel)
    fragColor = vec4(hashResult, hashResult, hashResult, 1.0);
}`;

// Test shader for randomDir function
const RANDOM_DIR_TEST_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;
uniform float u_textureSize;

const int HASH_MOD = 100003;

int safeMod(int x, int m) {
    // Use native modulo operator for cross-platform determinism
    int result = x % m;
    if (result < 0) result += m;
    return result;
}

int ihash(int x) {
    x = safeMod(x, HASH_MOD);
    x = safeMod(x * 31 + 17, HASH_MOD);
    x = safeMod(x * 37 + 23, HASH_MOD);
    x = safeMod(x * 41 + 29, HASH_MOD);
    return x;
}

int hashPosTime(vec2 pos, float time) {
    // Use floor() explicitly for cross-platform determinism
    int px = int(floor(pos.x + 0.5));
    int py = int(floor(pos.y + 0.5));
    int t = int(floor(time));
    
    px = safeMod(px, 1009);
    py = safeMod(py, 1013);
    t = safeMod(t, 10007);
    
    int h = px * 73 + py * 71 + t * 83;
    return ihash(h);
}

int randomDir(vec2 pos, float time) {
    int h = hashPosTime(pos, time);
    return safeMod(h, 8) + 1;
}

void main() {
    // Match JS position calculation: Math.floor((px / textureSize) * 512)
    vec2 pixelCoord = floor(gl_FragCoord.xy);
    vec2 pos = floor(pixelCoord / u_textureSize * 512.0);
    
    int dir = randomDir(pos, u_time);
    
    // Output direction as a value 1-8 normalized to 0-1
    float dirNorm = float(dir - 1) / 7.0;  // 0.0 to 1.0
    fragColor = vec4(dirNorm, dirNorm, dirNorm, 1.0);
}`;

// Test shader for high tick counts (the likely overflow case)
const HIGH_TICK_TEST_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;
out vec4 fragColor;

uniform float u_time;  // Will be a high value like 33931
uniform float u_textureSize;  // Size of the texture (16 or 64)

const int HASH_MOD = 100003;

int safeMod(int x, int m) {
    // Use native modulo operator for cross-platform determinism
    int result = x % m;
    if (result < 0) result += m;
    return result;
}

int ihash(int x) {
    x = safeMod(x, HASH_MOD);
    x = safeMod(x * 31 + 17, HASH_MOD);
    x = safeMod(x * 37 + 23, HASH_MOD);
    x = safeMod(x * 41 + 29, HASH_MOD);
    return x;
}

int hashPosTime(vec2 pos, float time) {
    // Use floor() explicitly for cross-platform determinism
    int px = int(floor(pos.x + 0.5));
    int py = int(floor(pos.y + 0.5));
    int t = int(floor(time));
    
    px = safeMod(px, 1009);
    py = safeMod(py, 1013);
    t = safeMod(t, 10007);
    
    int h = px * 73 + py * 71 + t * 83;
    return ihash(h);
}

float hash(vec2 p, float time) {
    int h = hashPosTime(p, time);
    return float(h) / float(HASH_MOD);
}

void main() {
    // Match JS position calculation: Math.floor((px / textureSize) * 512)
    vec2 pixelCoord = floor(gl_FragCoord.xy);
    vec2 pos = floor(pixelCoord / u_textureSize * 512.0);
    
    float hashResult = hash(pos, u_time);
    
    fragColor = vec4(hashResult, hashResult, hashResult, 1.0);
}`;

// Calculate expected hash values in JavaScript (for validation)
function jsHash(x, mod = 100003) {
    x = ((x % mod) + mod) % mod;
    x = ((x * 31 + 17) % mod + mod) % mod;
    x = ((x * 37 + 23) % mod + mod) % mod;
    x = ((x * 41 + 29) % mod + mod) % mod;
    return x;
}

function jsHashPosTime(px, py, t) {
    px = ((px % 1009) + 1009) % 1009;
    py = ((py % 1013) + 1013) % 1013;
    t = ((t % 10007) + 10007) % 10007;
    const h = px * 73 + py * 71 + t * 83;  // Must match random.glsl coefficients
    return jsHash(h);
}

// Helper to create and run a test shader
async function runHashShader(fragSource, uniforms, size = 16) {
    const shader = new ComputeShader(fragSource);
    const texture = new DataTexture(size, size, { format: 'float' });
    const fb = new Framebuffer(texture);
    
    fb.bind();
    shader.use();
    
    // Set uniforms (including texture size for position calculations)
    const allUniforms = { ...uniforms, u_textureSize: size };
    for (const [name, value] of Object.entries(allUniforms)) {
        shader.setFloat(name, value);
    }
    
    shader.dispatch();
    fb.unbind();
    
    // Read back results
    const data = texture.download(fb.framebuffer);
    
    // Cleanup
    shader.destroy();
    texture.destroy();
    fb.destroy();
    
    return data;
}

export async function runRandomTests() {
    logSection('Random/Hash Determinism Tests');
    
    // Test 1: Basic ihash at various inputs
    await runTest('ihash produces expected values at seed=0', async () => {
        const data = await runHashShader(IHASH_TEST_FRAG, { u_seed: 0 }, 16);
        
        // Check a few specific pixels
        // Pixel (0,0): input = 0*1000 + 0 = 0, expected = jsHash(0)
        const expected0 = jsHash(0);
        const actual0 = Math.round(data[0] * 255) + Math.round(data[1] * 255) * 256 + Math.round(data[2] * 255) * 65536;
        assert(actual0 === expected0, `ihash(0) expected ${expected0}, got ${actual0}`);
        
        // Pixel (1,0): input = 1*1000 + 0 = 1000, expected = jsHash(1000)
        const expected1 = jsHash(1000);
        const actual1 = Math.round(data[4] * 255) + Math.round(data[5] * 255) * 256 + Math.round(data[6] * 255) * 65536;
        assert(actual1 === expected1, `ihash(1000) expected ${expected1}, got ${actual1}`);
    });
    
    // Test 2: ihash with high seed (simulating high tick count)
    await runTest('ihash produces expected values at seed=33931', async () => {
        const data = await runHashShader(IHASH_TEST_FRAG, { u_seed: 33931 }, 16);
        
        // Pixel (0,0): input = 0*1000 + 33931
        const expected = jsHash(33931);
        const actual = Math.round(data[0] * 255) + Math.round(data[1] * 255) * 256 + Math.round(data[2] * 255) * 65536;
        assert(actual === expected, `ihash(33931) expected ${expected}, got ${actual}`);
    });
    
    // Test 3: hashPosTime at low tick
    await runTest('hashPosTime produces expected values at time=100', async () => {
        const data = await runHashShader(HASH_POS_TIME_TEST_FRAG, { u_time: 100 }, 16);
        
        // Check pixel at (0,0) which corresponds to pos (0,0)
        const expected = jsHashPosTime(0, 0, 100) / 100003;
        const actual = data[0];
        assertApprox(actual, expected, 0.001, `hash(0,0,100)`);
    });
    
    // Test 4: hashPosTime at high tick (the failing case!)
    await runTest('hashPosTime produces expected values at time=33931', async () => {
        const data = await runHashShader(HASH_POS_TIME_TEST_FRAG, { u_time: 33931 }, 16);
        
        // Check pixel at (0,0)
        const expected = jsHashPosTime(0, 0, 33931) / 100003;
        const actual = data[0];
        assertApprox(actual, expected, 0.001, `hash(0,0,33931)`);
        
        // Check pixel at (8,8) which corresponds to pos (256,256)
        const idx = (8 + 8 * 16) * 4;  // RGBA stride
        const expected2 = jsHashPosTime(256, 256, 33931) / 100003;
        const actual2 = data[idx];
        assertApprox(actual2, expected2, 0.001, `hash(256,256,33931)`);
    });
    
    // Test 5: hashPosTime at very high tick
    await runTest('hashPosTime produces expected values at time=100000', async () => {
        const data = await runHashShader(HASH_POS_TIME_TEST_FRAG, { u_time: 100000 }, 16);
        
        const expected = jsHashPosTime(0, 0, 100000) / 100003;
        const actual = data[0];
        assertApprox(actual, expected, 0.001, `hash(0,0,100000)`);
    });
    
    // Test 6: High tick count test shader
    await runTest('hash at tick 33931 matches JavaScript', async () => {
        const data = await runHashShader(HIGH_TICK_TEST_FRAG, { u_time: 33931 }, 16);
        
        // Sample multiple positions
        const positions = [
            [0, 0], [1, 0], [0, 1], [8, 8], [15, 15]
        ];
        
        for (const [px, py] of positions) {
            const idx = (px + py * 16) * 4;
            const posX = Math.floor((px / 16) * 512);
            const posY = Math.floor((py / 16) * 512);
            const expected = jsHashPosTime(posX, posY, 33931) / 100003;
            const actual = data[idx];
            assertApprox(actual, expected, 0.01, `hash(${posX},${posY},33931)`);
        }
    });
    
    // Test 7: Consistency across multiple runs (same input = same output)
    await runTest('hash is consistent across multiple shader runs', async () => {
        const data1 = await runHashShader(HIGH_TICK_TEST_FRAG, { u_time: 12345 }, 16);
        const data2 = await runHashShader(HIGH_TICK_TEST_FRAG, { u_time: 12345 }, 16);
        
        // All values should be identical
        for (let i = 0; i < data1.length; i++) {
            assert(data1[i] === data2[i], `Inconsistent at index ${i}: ${data1[i]} vs ${data2[i]}`);
        }
    });
    
    // Test 8: Distribution check (randomDir should produce 1-8 evenly)
    await runTest('randomDir produces values 1-8', async () => {
        const data = await runHashShader(RANDOM_DIR_TEST_FRAG, { u_time: 1000 }, 32);
        
        const dirCounts = [0, 0, 0, 0, 0, 0, 0, 0];
        for (let i = 0; i < data.length; i += 4) {
            const dirNorm = data[i];
            const dir = Math.round(dirNorm * 7) + 1;  // 1-8
            if (dir >= 1 && dir <= 8) {
                dirCounts[dir - 1]++;
            }
        }
        
        // Each direction should appear at least once in 1024 samples
        for (let d = 0; d < 8; d++) {
            assert(dirCounts[d] > 0, `Direction ${d + 1} never appeared (counts: ${dirCounts.join(',')})`);
        }
    });
    
    // Test 9: Large grid test - many positions at high tick
    await runTest('hash produces expected values across large grid at tick 50000', async () => {
        const data = await runHashShader(HIGH_TICK_TEST_FRAG, { u_time: 50000 }, 64);
        
        // Sample a few positions
        const testCases = [
            [0, 0],
            [32, 32],
            [63, 63],
            [10, 50],
            [50, 10]
        ];
        
        for (const [px, py] of testCases) {
            const idx = (px + py * 64) * 4;
            const posX = Math.floor((px / 64) * 512);
            const posY = Math.floor((py / 64) * 512);
            const expected = jsHashPosTime(posX, posY, 50000) / 100003;
            const actual = data[idx];
            assertApprox(actual, expected, 0.02, `hash(${posX},${posY},50000)`);
        }
    });
    
    // Test 10: Edge case - maximum safe values
    await runTest('hashPosTime handles edge position values', async () => {
        // Test with positions near boundaries
        const positions = [0, 1, 511, 512, 1008, 1009, 1010];
        for (const p of positions) {
            const expected = jsHashPosTime(p, p, 1000) / 100003;
            // Just verify JS calculation works (GPU test would need custom shader)
            assert(expected >= 0 && expected <= 1, `JS hash out of range for pos ${p}`);
        }
    });
}
