/**
 * Test Runner - Loads and runs all test files
 */

import { GPU } from '../gpu/GPU.js';
import { outputResults, setTotalTests } from './framework.js';

// Import GPU/shader test suites
import { runGPUTests } from './gpu.test.js';
import { runGOLTests } from './gol.test.js';
import { runMiningTests, runUnitMovementNearFactoryTests } from './mining.test.js';
import { runRandomTests } from './random.test.js';

// Import refactored module test suites
import { runGameUtilsTests } from './gameutils.test.js';
import { runCameraTests } from './camera.test.js';
import { runGridActionsTests } from './gridactions.test.js';
import { runMapGeneratorTests } from './mapgenerator.test.js';

// Total test count:
// GPU tests: gpu(15) + gol(10) + mining(39) + unitMovementNearFactory(10) + random(10) = 84
// Refactored module tests: gameutils(20) + camera(10) + gridactions(15) + mapgenerator(12) = 57
setTotalTests(141);

// Initialize GPU once before all tests
const canvas = document.getElementById('canvas');
GPU.init(canvas);

// Run GPU/shader test suites
await runGPUTests();
await runGOLTests();
await runMiningTests();
await runUnitMovementNearFactoryTests();
await runRandomTests();

// Run refactored module test suites
await runGameUtilsTests();
await runCameraTests();
await runGridActionsTests();
await runMapGeneratorTests();

// Output final results
outputResults();
