#!/bin/bash
echo "📡 Starting ETCS stack (obu_Rpi.js only)..."
echo "------------------------------------"

cd "$(dirname "$0")"
sleep 1

echo "▶ Starting obu_Rpi.js"
node obu_Rpi.js &
PID_OBU=$!

echo "✅ ETCS started | OBU PID: $PID_OBU"
echo "------------------------------------"

trap "echo '🛑 Stopping ETCS stack...'; kill $PID_OBU; exit" SIGINT
wait
