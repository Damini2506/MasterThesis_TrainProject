#!/bin/bash
echo "🚆 Starting TRAIN stack (bridges + camera + AI)..."
echo "------------------------------------"

cd "$(dirname "$0")"
sleep 1

# MQTT → AMQP bridge
echo "▶ Starting mqtt-to-amqp_V2.js"
node mqtt-to-amqp_V2.js &
PID_MQTT_AMQP=$!
sleep 1

# AMQP → MQTT bridge
echo "▶ Starting amqp-to-mqtt_V2.js"
node amqp-to-mqtt_V2.js &
PID_AMQP_MQTT=$!
sleep 1

# Camera + Hailo AI + Alerts (your python file name here)
echo "?? Killing any previous cam_mqtt_jpeg_and_hailo_alert.py..."
pkill -f "cam_mqtt_jpeg_and_hailo_alert.py" 2>/dev/null || true
sleep 0.5

echo "▶ Starting cam + hailo + alerts"
python3 cam_mqtt_jpeg_and_hailo_alert.py &
PID_CAM_AI=$!

echo "------------------------------------"
echo "✅ TRAIN components started"
echo "CAM+AI PID:     $PID_CAM_AI"
echo "MQTT→AMQP PID:  $PID_MQTT_AMQP"
echo "AMQP→MQTT PID:  $PID_AMQP_MQTT"
echo "------------------------------------"

trap "echo '🛑 Stopping TRAIN stack...'; kill $PID_CAM_AI $PID_MQTT_AMQP $PID_AMQP_MQTT; exit" SIGINT
wait
