#!/bin/bash
# WardDrive AI - Launch Script
# Usage: bash start.sh [port]

PORT=${1:-7432}

# Check Python 3
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is required but not found."
    exit 1
fi

# Get local IP for iPhone access
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP=$(ifconfig 2>/dev/null | grep "inet " | grep -v "127.0.0.1" | head -1 | awk '{print $2}')
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║           WardDrive AI - Starting            ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Desktop:  http://localhost:$PORT              ║"
if [ -n "$LOCAL_IP" ]; then
echo "║  iPhone:   http://$LOCAL_IP:$PORT     ║"
fi
echo "║                                              ║"
echo "║  On iPhone: Open URL in Safari, then tap    ║"
echo "║  Share → 'Add to Home Screen'               ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

cd "$(dirname "$0")"
python3 server.py
