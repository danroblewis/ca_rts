/**
 * Test Runner - Loads and runs all test files
 */

import { GPU } from '../gpu/GPU.js';
import { outputResults, setTotalTests } from './framework.js';

// Import test suites
import { runGPUTests } from './gpu.test.js';
import { runGOLTests } from './gol.test.js';
import { runMiningTests, runUnitMovementNearFactoryTests } from './mining.test.js';
import { runRandomTests } from './random.test.js';

// Total test count: gpu(15) + gol(10) + mining(39) + unitMovementNearFactory(10) + random(10) = 84
setTotalTests(84);

// Initialize GPU once before all tests
const canvas = document.getElementById('canvas');
GPU.init(canvas);

// Run all test suites
await runGPUTests();
await runGOLTests();
await runMiningTests();
await runUnitMovementNearFactoryTests();
await runRandomTests();

// Output final results
outputResults();
