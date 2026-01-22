/**
 * Test Runner - Loads and runs all test files
 */

import { GPU } from '../gpu/GPU.js';
import { outputResults } from './framework.js';

// Import test suites
import { runGPUTests } from './gpu.test.js';
import { runGOLTests } from './gol.test.js';

// Initialize GPU once before all tests
const canvas = document.getElementById('canvas');
GPU.init(canvas);

// Run all test suites
await runGPUTests();
await runGOLTests();

// Output final results
outputResults();
