/**
 * Test Framework - Shared utilities for all test files
 */

const results = [];
const testResults = []; // Track individual test pass/fail for visual summary
let passed = 0;
let failed = 0;
let totalExpected = 0;

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
    const progressText = totalExpected > 0 
        ? `Running tests... ${completed}/${totalExpected}`
        : `Running tests... ${completed} completed`;
    
    const barWidth = 30;
    const filledWidth = totalExpected > 0 ? Math.round((completed / totalExpected) * barWidth) : 0;
    const progressBar = totalExpected > 0 
        ? `[${'█'.repeat(filledWidth)}${'░'.repeat(barWidth - filledWidth)}]`
        : '';
    
    const currentLine = currentTest ? `\n▶ ${currentTest}` : '';
    output.textContent = `${progressText}\n${progressBar}${currentLine}`;
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
    updateProgress(name);
    try {
        await fn();
        results.push({ type: 'pass', name });
        testResults.push({ passed: true, name });
        passed++;
    } catch (e) {
        results.push({ type: 'fail', name, error: e.message });
        testResults.push({ passed: false, name });
        failed++;
    }
    updateProgress();
}

export function outputResults() {
    const output = document.getElementById('output');
    const total = passed + failed;
    const passPercent = total > 0 ? (passed / total) * 100 : 100;
    const failPercent = 100 - passPercent;
    
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
            }
            #test-summary .counts span { display: flex; align-items: center; gap: 4px; }
            #test-summary .dot { width: 8px; height: 8px; border-radius: 50%; }
            #test-summary .dot.green { background: #4ade80; }
            #test-summary .dot.red { background: #f87171; }
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
            }
            #test-summary .failing-list .item {
                color: #fca5a5;
                padding: 2px 0;
            }
        </style>
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
            <span>${total} total</span>
        </div>
        ${failed > 0 ? `
        <div class="failing-list">
            <div class="title">Failing Tests:</div>
            ${testResults.filter(t => !t.passed).map(t => `<div class="item">• ${t.name}</div>`).join('')}
        </div>
        ` : ''}
    `;
    
    // Build detailed results for pre tag
    let detailedResults = '';
    for (const result of results) {
        if (result.type === 'section') {
            detailedResults += `\n--- ${result.name} ---\n`;
        } else if (result.type === 'pass') {
            detailedResults += `🟢 [PASS] ${result.name}\n`;
        } else if (result.type === 'fail') {
            detailedResults += `🔴 [FAIL] ${result.name}\n`;
            detailedResults += `         ${result.error}\n`;
        }
    }
    
    // Final summary line
    const finalSummary = `\n${'═'.repeat(50)}\nTests: ${passed} passed, ${failed} failed, ${total} total\n`;
    
    // Insert summary div before output, set output content
    output.parentNode.insertBefore(summaryDiv, output);
    output.textContent = detailedResults + finalSummary;
    console.log(detailedResults + finalSummary);
}

export function logSection(name) {
    results.push({ type: 'section', name });
}
