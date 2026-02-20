#!/usr/bin/env python3
import json
import os
import subprocess
import time
import socket
import paho.mqtt.client as mqtt

BROKER_HOST = "192.168.4.4"      # Mosquitto host (your laptop)
BROKER_PORT = 1883              # normal MQTT port (not websockets)
TRAIN_NO = "TRAIN01"

TOPIC_CMD = f"obu/{TRAIN_NO}/cmd"
TOPIC_STATUS = f"obu/{TRAIN_NO}/status"

TRAIN_SCRIPT = os.path.join(os.path.dirname(__file__), "start_train_stack.sh")
ETCS_SCRIPT  = os.path.join(os.path.dirname(__file__), "start_etcs_stack.sh")


def pub_status(client, service, state, extra=None):
    msg = {
        "type": "STATUS",
        "trainNo": TRAIN_NO,
        "service": service,
        "state": state,
        "ts": int(time.time() * 1000),
        "host": socket.gethostname(),
    }
    if extra:
        msg.update(extra)
    client.publish(TOPIC_STATUS, json.dumps(msg), qos=1, retain=True)

def run_script(client, script_path, service_name):
    if not os.path.exists(script_path):
        pub_status(client, service_name, "error", {"reason": f"missing {script_path}"})
        print("❌ Missing:", script_path)
        return

    workdir = os.path.dirname(__file__)
    log_path = os.path.join(workdir, f"{service_name}.log")

    try:
        with open(log_path, "a") as f:
            f.write("\n\n===== START %s %s =====\n" % (service_name, time.ctime()))
            f.flush()

            p = subprocess.Popen(
                ["bash", script_path],
                cwd=workdir,
                stdout=f,
                stderr=f,
                start_new_session=True
            )

        pub_status(client, service_name, "started", {"pid": p.pid})
        print(f"🟩 Started {service_name} PID {p.pid} | logging to {log_path}")

        time.sleep(1)
        if p.poll() is not None:
            pub_status(client, service_name, "error", {"reason": "exited immediately"})
            print(f"❌ {service_name} exited immediately. Check {log_path}")

    except Exception as e:
        pub_status(client, service_name, "error", {"reason": str(e)})
        print(f"❌ Failed to start {service_name}:", e)


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("✅ Connected to broker")
        client.subscribe(TOPIC_CMD, qos=1)
        pub_status(client, "launcher", "online")
    else:
        print("❌ MQTT connect failed rc=", rc)

def on_message(client, userdata, msg):
    payload = msg.payload.decode("utf-8", errors="ignore")
    print("📩", msg.topic, payload)

    try:
        data = json.loads(payload)
    except Exception:
        data = {"cmd": payload.strip()}

    cmd = (data.get("cmd") or "").strip().upper()
    if cmd == "START_TRAIN_STACK":
        pub_status(client, "launcher", "start_train_requested")
        run_script(client, TRAIN_SCRIPT, "train_stack")

    elif cmd == "START_ETCS_STACK":
        pub_status(client, "launcher", "start_etcs_requested")
        run_script(client, ETCS_SCRIPT, "etcs_stack")

    elif cmd == "PING":
        pub_status(client, "launcher", "pong")
    else:
        pub_status(client, "launcher", "unknown_cmd", {"cmd": cmd})


def main():
    client = mqtt.Client(client_id=f"OBU_LAUNCHER_{TRAIN_NO}")
    client.on_connect = on_connect
    client.on_message = on_message

    client.connect(BROKER_HOST, BROKER_PORT, keepalive=30)
    client.loop_forever()

if __name__ == "__main__":
    main()

