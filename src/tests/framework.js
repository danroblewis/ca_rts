/**
 * Test Framework - Shared utilities for all test files
 */

const results = [];
const testResults = []; // Track individual test pass/fail for visual summary
let passed = 0;
let failed = 0;
let skipped = 0;
let totalExpected = 0;
let totalDuration = 0;

// Test filter from URL parameter
const urlParams = new URLSearchParams(window.location.search);
const testFilter = urlParams.get('test') || urlParams.get('t') || '';
const testFilterLower = testFilter.toLowerCase();
// Split by | for multiple filters (used when running failing tests)
const testFilterParts = testFilterLower.split('|').map(s => s.trim()).filter(s => s.length > 0);

/**
 * Check if a test name matches the current filter
 * Supports multiple filters separated by | (OR logic)
 */
export function shouldRunTest(name) {
    if (!testFilter) return true;
    const nameLower = name.toLowerCase();
    // Match if ANY filter part matches
    return testFilterParts.some(filter => nameLower.includes(filter));
}

/**
 * Get the current test filter
 */
export function getTestFilter() {
    return testFilter;
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms) {
    if (ms < 1) return '<1ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Set the expected total number of tests for progress display
 */
export function setTotalTests(count) {
    totalExpected = count;
}

/**
 * Update the progress display
 */
function updateProgress(currentTest = null) {
    const output = document.getElementById('output');
    const completed = passed + failed;
    const filterInfo = testFilter ? `\n🔍 Filter: "${testFilter}"` : '';
    const progressText = totalExpected > 0 
        ? `Running tests... ${completed}/${totalExpected}`
        : `Running tests... ${completed} completed`;
    
    const barWidth = 30;
    const filledWidth = totalExpected > 0 ? Math.round((completed / totalExpected) * barWidth) : 0;
    const progressBar = totalExpected > 0 
        ? `[${'█'.repeat(filledWidth)}${'░'.repeat(barWidth - filledWidth)}]`
        : '';
    
    const currentLine = currentTest ? `\n▶ ${currentTest}` : '';
    output.textContent = `${progressText}${filterInfo}\n${progressBar}${currentLine}`;
}

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
    // Skip tests that don't match the filter
    if (!shouldRunTest(name)) {
        skipped++;
        return;
    }
    
    updateProgress(name);
    const startTime = performance.now();
    try {
        await fn();
        const duration = performance.now() - startTime;
        totalDuration += duration;
        results.push({ type: 'pass', name, duration });
        testResults.push({ passed: true, name, duration });
        passed++;
    } catch (e) {
        const duration = performance.now() - startTime;
        totalDuration += duration;
        results.push({ type: 'fail', name, error: e.message, duration });
        testResults.push({ passed: false, name, duration });
        failed++;
    }
    updateProgress();
}

export function outputResults() {
    const output = document.getElementById('output');
    const total = passed + failed;
    const passPercent = total > 0 ? (passed / total) * 100 : 100;
    const failPercent = 100 - passPercent;
    const filterActive = testFilter !== '';
    
    // Create HTML summary
    const summaryDiv = document.createElement('div');
    summaryDiv.id = 'test-summary';
    summaryDiv.innerHTML = `
        <style>
            #test-summary {
                font-family: system-ui, -apple-system, sans-serif;
                padding: 12px 16px;
                background: #1a1a2e;
                border-radius: 8px;
                margin-bottom: 16px;
            }
            #test-summary .filter-info {
                background: #2d3748;
                padding: 8px 12px;
                border-radius: 4px;
                margin-bottom: 12px;
                font-size: 13px;
                color: #fbbf24;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #test-summary .filter-info code {
                background: #1a202c;
                padding: 2px 6px;
                border-radius: 3px;
                font-family: monospace;
            }
            #test-summary .filter-info a {
                color: #60a5fa;
                text-decoration: none;
                margin-left: auto;
            }
            #test-summary .filter-info a:hover {
                text-decoration: underline;
            }
            #test-summary .status {
                font-size: 18px;
                font-weight: 600;
                margin-bottom: 8px;
            }
            #test-summary .status.pass { color: #4ade80; }
            #test-summary .status.fail { color: #f87171; }
            #test-summary .bar-container {
                display: flex;
                height: 24px;
                border-radius: 4px;
                overflow: hidden;
                background: #2d2d44;
                margin-bottom: 8px;
            }
            #test-summary .bar-pass {
                background: linear-gradient(90deg, #22c55e, #4ade80);
                display: flex;
                align-items: center;
                justify-content: center;
                color: #000;
                font-weight: 600;
                font-size: 12px;
                min-width: ${passed > 0 ? '40px' : '0'};
            }
            #test-summary .bar-fail {
                background: linear-gradient(90deg, #ef4444, #f87171);
                display: flex;
                align-items: center;
                justify-content: center;
                color: #000;
                font-weight: 600;
                font-size: 12px;
                min-width: ${failed > 0 ? '40px' : '0'};
            }
            #test-summary .counts {
                display: flex;
                gap: 16px;
                font-size: 13px;
                color: #a0a0b0;
                flex-wrap: wrap;
            }
            #test-summary .counts span { display: flex; align-items: center; gap: 4px; }
            #test-summary .dot { width: 8px; height: 8px; border-radius: 50%; }
            #test-summary .dot.green { background: #4ade80; }
            #test-summary .dot.red { background: #f87171; }
            #test-summary .dot.gray { background: #6b7280; }
            #test-summary .failing-list {
                margin-top: 12px;
                padding: 8px 12px;
                background: rgba(239, 68, 68, 0.15);
                border-left: 3px solid #ef4444;
                border-radius: 0 4px 4px 0;
                font-size: 13px;
            }
            #test-summary .failing-list .title {
                color: #f87171;
                font-weight: 600;
                margin-bottom: 4px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            #test-summary .failing-list .run-failing-link {
                font-size: 11px;
                color: #60a5fa;
                text-decoration: none;
                background: rgba(96, 165, 250, 0.15);
                padding: 2px 8px;
                border-radius: 4px;
                border: 1px solid rgba(96, 165, 250, 0.3);
            }
            #test-summary .failing-list .run-failing-link:hover {
                background: rgba(96, 165, 250, 0.25);
                text-decoration: none;
            }
            #test-summary .failing-list .item {
                color: #fca5a5;
                padding: 2px 0;
            }
            #test-summary .failing-list .item a {
                color: #fca5a5;
                text-decoration: none;
            }
            #test-summary .failing-list .item a:hover {
                text-decoration: underline;
                color: #fef08a;
            }
        </style>
        ${filterActive ? `
        <div class="filter-info">
            🔍 Filter active: <code>${testFilter}</code> (${skipped} skipped)
            <a href="test.html">Run all tests</a>
        </div>
        ` : ''}
        <div class="status ${failed === 0 ? 'pass' : 'fail'}">
            ${failed === 0 ? '✓ ALL TESTS PASSED' : `✗ ${failed} TEST${failed > 1 ? 'S' : ''} FAILED`}
        </div>
        <div class="bar-container">
            <div class="bar-pass" style="width: ${passPercent}%">${passed > 0 ? passed : ''}</div>
            <div class="bar-fail" style="width: ${failPercent}%">${failed > 0 ? failed : ''}</div>
        </div>
        <div class="counts">
            <span><span class="dot green"></span> ${passed} passed</span>
            <span><span class="dot red"></span> ${failed} failed</span>
            ${filterActive ? `<span><span class="dot gray"></span> ${skipped} skipped</span>` : ''}
            <span>${total} run</span>
            <span>⏱ ${formatDuration(totalDuration)}</span>
        </div>
        ${failed > 0 ? `
        <div class="failing-list">
            <div class="title">
                Failing Tests:
                <a href="test.html?test=${encodeURIComponent(testResults.filter(t => !t.passed).map(t => t.name).join('|'))}" 
                   class="run-failing-link" 
                   title="Run only failing tests">
                   ▶ Run Failing
                </a>
            </div>
            ${testResults.filter(t => !t.passed).map(t => `
                <div class="item">
                    <a href="test.html?test=${encodeURIComponent(t.name)}" title="Run this test only">• ${t.name}</a>
                </div>
            `).join('')}
        </div>
        ` : ''}
    `;
    
    // Build detailed results for pre tag
    let detailedResults = '';
    for (const result of results) {
        if (result.type === 'section') {
            detailedResults += `\n--- ${result.name} ---\n`;
        } else if (result.type === 'pass') {
            detailedResults += `🟢 [PASS] ${result.name} (${formatDuration(result.duration)})\n`;
        } else if (result.type === 'fail') {
            detailedResults += `🔴 [FAIL] ${result.name} (${formatDuration(result.duration)})\n`;
            detailedResults += `         ${result.error}\n`;
        }
    }
    
    // Final summary line
    const skippedText = filterActive ? `, ${skipped} skipped` : '';
    const filterText = filterActive ? ` (filter: "${testFilter}")` : '';
    const finalSummary = `\n${'═'.repeat(50)}\nTests: ${passed} passed, ${failed} failed${skippedText}, ${total} run in ${formatDuration(totalDuration)}${filterText}\n`;
    
    // Insert summary div before output, set output content
    output.parentNode.insertBefore(summaryDiv, output);
    output.textContent = detailedResults + finalSummary;
    console.log(detailedResults + finalSummary);
}

export function logSection(name) {
    results.push({ type: 'section', name });
}
