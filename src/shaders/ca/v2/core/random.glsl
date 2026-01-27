/**
 * Random/Hash Functions - INTEGER-ONLY for cross-platform determinism
 * 
 * These functions use only integer operations with EXPLICIT MODULAR ARITHMETIC
 * to ensure identical results across different GPU architectures (PC, Mac M4, etc.)
 * 
 * Key insight: Signed integer overflow is UNDEFINED in GLSL. We must keep
 * all values within safe ranges to avoid hardware-specific behavior.
 */

#ifndef RANDOM_GLSL
#define RANDOM_GLSL

// Large prime modulus - keeps all values in safe range
const int HASH_MOD = 100003;  // Prime number, fits well in 32-bit

// Safe modulo using native modulo operator for cross-platform determinism
int safeMod(int x, int m) {
    int result = x % m;
    if (result < 0) result += m;
    return result;
}

// Integer hash using safe modular arithmetic
// All intermediate values stay within safe bounds
int ihash(int x) {
    // First, bring x into safe range
    x = safeMod(x, HASH_MOD);
    
    // Mix using small multipliers that won't overflow
    // 31 * 100003 = 3.1M, safe
    // 37 * 100003 = 3.7M, safe
    x = safeMod(x * 31 + 17, HASH_MOD);
    x = safeMod(x * 37 + 23, HASH_MOD);
    x = safeMod(x * 41 + 29, HASH_MOD);
    
    return x;
}

// Hash position and time to get a deterministic integer
// Uses safe modular arithmetic at each step to prevent overflow
int hashPosTime(vec2 pos, float time) {
    // Convert floats to integers using floor() for cross-platform determinism
    // Position should always be integer-valued (cell coordinates)
    int px = int(floor(pos.x + 0.5));  // Round to nearest integer
    int py = int(floor(pos.y + 0.5));
    int t = int(floor(time));
    
    // Bring each component into safe range BEFORE combining
    // This prevents overflow during multiplication
    px = safeMod(px, 1009);  // Prime < 1024
    py = safeMod(py, 1013);  // Different prime
    t = safeMod(t, 10007);   // Prime for time
    
    // Now combine - max value is roughly 1009*73 + 1013*19 + 10007*83 = ~900K, safe
    int h = px * 73 + py * 19 + t * 83;
    
    return ihash(h);
}

// Get a float 0.0-1.0 from integer hash (for compatibility with existing code)
float hash(vec2 p, float time) {
    int h = hashPosTime(p, time);
    // h is already positive and < HASH_MOD, so just normalize
    return float(h) / float(HASH_MOD);
}

// Random direction 1-8 (including diagonals) - pure integer
int randomDir(vec2 pos, float time) {
    int h = hashPosTime(pos, time);
    return safeMod(h, 8) + 1;  // Returns 1-8
}

// Direction toward target - prefers diagonal when both axes differ
int dirToward(vec2 from, vec2 to, float seed) {
    vec2 diff = to - from;
    
    if (abs(diff.x) < 0.5 && abs(diff.y) < 0.5) {
        return 0;  // Already there
    }
    
    bool canX = abs(diff.x) > 0.5;
    bool canY = abs(diff.y) > 0.5;
    
    // If both axes differ, use diagonal movement
    if (canX && canY) {
        if (diff.x > 0.0 && diff.y > 0.0) return 5;  // DIR_UP_RIGHT
        if (diff.x < 0.0 && diff.y > 0.0) return 6;  // DIR_UP_LEFT
        if (diff.x < 0.0 && diff.y < 0.0) return 7;  // DIR_DOWN_LEFT
        if (diff.x > 0.0 && diff.y < 0.0) return 8;  // DIR_DOWN_RIGHT
    } else if (canX) {
        return diff.x > 0.0 ? 1 : 3;  // RIGHT or LEFT
    } else if (canY) {
        return diff.y > 0.0 ? 2 : 4;  // UP or DOWN
    }
    
    return 0;
}

#endif
