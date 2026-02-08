#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./e2e/run.sh                          # run all tests
#   ./e2e/run.sh -g "demolish"            # run tests matching "demolish"
#   ./e2e/run.sh -g "replicate|rollback"  # run multiple tests by regex
#   ./e2e/run.sh --headed                 # watch tests in a browser
#   ./e2e/run.sh --headed -g "demolish"   # combine flags
#
# All arguments are forwarded to `npx playwright test`.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PORT=8080
SERVER_PID=""

cleanup() {
    if [ -n "$SERVER_PID" ]; then
        echo "Stopping server (pid $SERVER_PID)..."
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Install Playwright deps if needed
cd "$SCRIPT_DIR"
if [ ! -d node_modules ]; then
    echo "Installing Playwright..."
    npm install
    npx playwright install chrome
fi

# Start server in background
echo "Starting game server on port $PORT..."
cd "$PROJECT_DIR"
#python3 server.py --port "$PORT" &
python3 server.py --port "$PORT" 2>&1 >/dev/null &
SERVER_PID=$!

# Wait for server to be ready
echo "Waiting for server..."
for i in $(seq 1 30); do
    if curl -s -o /dev/null "http://localhost:$PORT" 2>/dev/null; then
        echo "Server ready."
        break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "Server failed to start."
        exit 1
    fi
    sleep 1
done

# Run tests
cd "$SCRIPT_DIR"
npx playwright test "$@"
