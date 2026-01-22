/**
 * Test Framework - Shared utilities for all test files
 */

const results = [];
let passed = 0;
let failed = 0;

export function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

export function assertApprox(actual, expected, epsilon = 0.001, message = '') {
    if (Math.abs(actual - expected) > epsilon) {
        throw new Error(`${message} Expected ${expected}, got ${actual}`);
    }
}

export function assertArrayApprox(actual, expected, epsilon = 0.001, message = '') {
    if (actual.length !== expected.length) {
        throw new Error(`${message} Array length mismatch: ${actual.length} vs ${expected.length}`);
    }
    for (let i = 0; i < actual.length; i++) {
        if (Math.abs(actual[i] - expected[i]) > epsilon) {
            throw new Error(`${message} At index ${i}: expected ${expected[i]}, got ${actual[i]}`);
        }
    }
}

export async function runTest(name, fn) {
    try {
        await fn();
        results.push(`[PASS] ${name}`);
        passed++;
    } catch (e) {
        results.push(`[FAIL] ${name}`);
        results.push(`       ${e.message}`);
        failed++;
    }
}

export function outputResults() {
    const output = document.getElementById('output');
    const summary = `\n${'='.repeat(50)}\nTests: ${passed} passed, ${failed} failed, ${passed + failed} total\n`;
    output.textContent = results.join('\n') + summary;
    console.log(output.textContent);
}

export function logSection(name) {
    results.push(`\n--- ${name} ---`);
}
