#!/bin/bash

echo "🚆 Starting OBU communication stack..."
echo "------------------------------------"

# Make sure we are in the script directory
cd "$(dirname "$0")"


# Small delay so logs are readable
sleep 1

# Start MQTT → AMQP bridge
echo "▶ Starting mqtt-to-amqp_V2.js"
node mqtt-to-amqp_V2.js &
PID_MQTT_AMQP=$!

sleep 1

# Start AMQP → MQTT bridge
echo "▶ Starting amqp-to-mqtt_V2.js"
node amqp-to-mqtt_V2.js &
PID_AMQP_MQTT=$!

# Start OBU logic
echo "▶ Starting obu_Rpi.js"
node obu_Rpi.js &
PID_OBU=$!
echo "------------------------------------"
echo "✅ All components started"
echo "OBU PID:        $PID_OBU"
echo "MQTT→AMQP PID:  $PID_MQTT_AMQP"
echo "AMQP→MQTT PID:  $PID_AMQP_MQTT"
echo ""
echo "Press Ctrl+C to stop everything cleanly"
echo "------------------------------------"

# Handle Ctrl+C properly
trap "echo '🛑 Stopping OBU stack...'; kill $PID_OBU $PID_MQTT_AMQP $PID_AMQP_MQTT; exit" SIGINT

# Wait so script stays alive
wait
