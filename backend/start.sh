#!/usr/bin/env bash
# GeoIntel Backend — Startup Script
# Usage: ./start.sh
#        AV_KEY=your_key ./start.sh      (optional Alpha Vantage key)
#        NEWS_API_KEY=your_key ./start.sh (optional NewsAPI key)

set -e
cd "$(dirname "$0")"

echo "=== GeoIntel Backend ==="
echo "Python: $(python3 --version)"

# Install dependencies if not already present
if ! python3 -c "import fastapi, uvicorn, sse_starlette, feedparser" 2>/dev/null; then
    echo "Installing dependencies..."
    pip3 install -r requirements.txt --quiet
else
    echo "Dependencies OK"
fi

echo "Starting server on http://localhost:8765"
echo "Press Ctrl+C to stop."
echo ""

python3 server.py
