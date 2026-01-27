/**
 * Test Runner - Loads and runs all test files
 * 
 * URL Parameters:
 *   ?test=name    - Run only tests matching "name"
 *   ?exclude=name - Skip tests matching "name"
 *   ?fast=1       - Skip GPU tests (runs only unit tests)
 *   ?nogpu=1      - Same as ?fast=1
 */

import { GPU } from '../gpu/GPU.js';
import { outputResults, setTotalTests, shouldSkipGPU, logSection } from './framework.js';

// Import GPU/shader test suites
import { runGPUTests } from './gpu.test.js';
import { runGOLTests } from './gol.test.js';
import { runMiningTests, runUnitMovementNearFactoryTests } from './mining.test.js';
import { runRandomTests } from './random.test.js';

// Import refactored module test suites (pure JS, no GPU needed)
import { runGameUtilsTests } from './gameutils.test.js';
import { runCameraTests } from './camera.test.js';
import { runGridActionsTests } from './gridactions.test.js';
import { runMapGeneratorTests } from './mapgenerator.test.js';
import { runActionApplierTests } from './actionapplier.test.js';
import { runRollbackManagerTests } from './rollbackmanager.test.js';

// Check if we should skip GPU tests
const skipGPU = shouldSkipGPU();

// Total test count:
// GPU tests: gpu(15) + gol(10) + mining(39) + unitMovementNearFactory(10) + random(10) = 84
// Refactored module tests: gameutils(20) + camera(10) + gridactions(15) + mapgenerator(12) = 57
const gpuTestCount = 84;
const unitTestCount = 97;  // GameUtils:20 + Camera:13 + GridActions:19 + MapGenerator:12 + ActionApplier:18 + RollbackManager:15
setTotalTests(skipGPU ? unitTestCount : gpuTestCount + unitTestCount);

// Initialize GPU (needed even for some unit tests that mock canvas)
const canvas = document.getElementById('canvas');
GPU.init(canvas);

// Run GPU/shader test suites (unless skipped)
if (!skipGPU) {
    await runGPUTests();
    await runGOLTests();
    await runMiningTests();
    await runUnitMovementNearFactoryTests();
    await runRandomTests();
} else {
    logSection('GPU Tests (SKIPPED - ?fast=1)');
    console.log('Skipping GPU tests. Remove ?fast=1 to run all tests.');
}

// Run refactored module test suites (pure JS, always run)
await runGameUtilsTests();
await runCameraTests();
await runGridActionsTests();
await runMapGeneratorTests();
await runActionApplierTests();
await runRollbackManagerTests();

// Output final results
outputResults();
