#!/usr/bin/env python3
"""
Camera → MQTT JPEG stream
+ Hailo YOLO alerts (human / vehicle / animal)
+ ROI filtering (track polygon) so only "on-track" objects trigger alerts
+ Unknown obstacle / mud / track-lost proxy using "track texture/edge" anomaly inside ROI
+ Distance proxy: bbox + approximate distance (needs calibration)
+ Dataset capture: on MQTT cmd {"cmd":"CAPTURE_30S"} → saves 30s @ DATASET_FPS
+ Camera inverted (hflip+vflip) for your easy mounting

Topics:
- JPEG stream:            obu/cam/jpeg
- (NEW) JPEG metadata:    obu/cam/meta
- Commands:               obu/TRAIN01/cmd
- Alerts (local):         obu/ai/alert
- Alerts (to RBC):        obu/DE0001/ai/alert
- Debug (headless):       obu/TRAIN01/debug
- Status (optional):      obu/TRAIN01/status
"""

import time, io, json
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
from PIL import Image
import paho.mqtt.client as mqtt
from picamera2 import Picamera2
from libcamera import Transform
import cv2

from hailo_platform import HEF, VDevice, FormatType
from hailo_platform.pyhailort.pyhailort import (
    InferVStreams,
    InputVStreamParams,
    OutputVStreamParams,
)

import threading

# =========================
# MQTT / TOPICS
# =========================
TRAIN_NO = "TRAIN01"

BROKER_IP = "192.168.4.4"
BROKER_PORT_CTRL  = 1883
BROKER_PORT_VIDEO = 1886   # new port for video
BROKER_PORT_ALERT = 1887   # new port for AI alerts

TOPIC_CAM = "obu/cam/jpeg"
TOPIC_CAM_META = "obu/cam/meta"  # NEW: metadata for latency/jitter measurement
TOPIC_CMD = f"obu/{TRAIN_NO}/cmd"
TOPIC_STATUS = f"obu/{TRAIN_NO}/status"

TOPIC_ALERT_REMOTE = "obu/ai/alert"
RBC_ID = "DE0001"
TOPIC_ALERT_RBC = f"obu/{RBC_ID}/ai/alert"
TOPIC_DEBUG = f"obu/{TRAIN_NO}/debug"

TOPIC_AI_ACK = "obu/ai/ack"          # Remote OBU will publish ACK here
TOPIC_QOS = f"obu/{TRAIN_NO}/qos"    # Publish RTT metrics for UI/logging

QOS_PUB_CLIENT = None

# =========================
# Camera publish settings
# =========================
FPS = 10
PUB_W, PUB_H = 640, 360
JPEG_QUALITY = 35


# =========================
# Hailo model settings
# =========================
HEF_PATH = "/usr/share/hailo-models/yolov8s_h8l.hef"
MODEL_W, MODEL_H = 640, 640

# Detection threshold used when parsing detections
CONF_TH = 0.20

# only alert if conf >= this
ALERT_CONF_TH = 0.45
ALERT_COOLDOWN_SEC = 0.5

# =========================
# Distance gating (meters)
# =========================
MAX_ALERT_DISTANCE_M = 18.0   # 🚨 ONLY alert if object is closer than this

# =========================
# COCO class groups
# =========================
PERSON_CLASS_ID = 0

VEHICLE_CLASS_IDS = {
    1,  # bicycle
    2,  # car
    3,  # motorcycle
    4,  # airplane (optional)
    5,  # bus
    6,  # train
    7,  # truck
    8,  # boat (optional)
}

ANIMAL_CLASS_IDS = {
    14,  # bird
    15,  # cat
    16,  # dog
    17,  # horse
    18,  # sheep
    19,  # cow
    20,  # elephant
    21,  # bear
    22,  # zebra
    23,  # giraffe
}

COCO_LABELS = {
    0: "person",
    1: "bicycle", 2: "car", 3: "motorcycle",
    5: "bus", 6: "train", 7: "truck",
    14: "bird", 15: "cat", 16: "dog", 17: "horse", 18: "sheep",
    19: "cow", 20: "elephant", 21: "bear", 22: "zebra", 23: "giraffe",
}

def category_for_cls(cls_id: int) -> str:
    if cls_id == PERSON_CLASS_ID:
        return "human"
    if cls_id in VEHICLE_CLASS_IDS:
        return "vehicle"
    if cls_id in ANIMAL_CLASS_IDS:
        return "animal"
    return "other"


# =========================
# Dataset capture (30s @ 4fps)
# =========================
DATASET_DIR = Path.home() / "track_dataset" / "images"
DATASET_DIR.mkdir(parents=True, exist_ok=True)

DATASET_DURATION_S = 30.0
DATASET_FPS = 4.0

dataset_active = False
dataset_until = 0.0
last_dataset_ts = 0.0


# =========================
# Timestamp + IDs (NEW)
# =========================
CLIENT_CTRL = None  # will point to the ctrl-plane MQTT client (1883)
CLIENT_ALERT = None  # mqtt client on 1887
frame_seq = 0
alert_seq = 0

def now_ms() -> int:
    return int(time.time_ns() // 1_000_000)

def next_frame_id() -> int:
    global frame_seq
    frame_seq += 1
    return frame_seq

def next_alert_id(prefix: str = "AI") -> str:
    global alert_seq
    alert_seq += 1
    return f"{prefix}_{TRAIN_NO}_{alert_seq}", alert_seq

ai_lock = threading.Lock()

# msg_id -> t_send_ms (when alert was published)
ai_sent_ts = {}
AI_SENT_TTL_MS = 60_000  # keep 60s history max

last_ai_rtt_ms = None
last_ai_rtt_ts_ms = None

# =========================
# Helpers
# =========================
def resize_rgb(arr_rgb: np.ndarray, w: int, h: int) -> np.ndarray:
    img = Image.fromarray(arr_rgb, mode="RGB")
    img = img.resize((w, h), Image.BILINEAR)
    return np.array(img, dtype=np.uint8)

def encode_jpeg_from_rgb(arr_rgb: np.ndarray, quality: int) -> bytes:
    img = Image.fromarray(arr_rgb, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=int(quality), subsampling=0)
    return buf.getvalue()

def bbox_bottom_center_in_roi(xmin, ymin, xmax, ymax, roi_mask: np.ndarray) -> bool:
    h, w = roi_mask.shape
    cx = int(round((xmin + xmax) / 2.0))
    cy = int(round(ymax))  # bottom of bbox
    cx = max(0, min(w - 1, cx))
    cy = max(0, min(h - 1, cy))
    return roi_mask[cy, cx] == 1


last_dbg_ts = 0.0
def publish_debug(client, data, min_period=0.5):
    global last_dbg_ts
    now = time.time()
    if now - last_dbg_ts < min_period:
        return
    last_dbg_ts = now
    data["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    client.publish(TOPIC_DEBUG, json.dumps(data), qos=0, retain=False)


def unwrap_singletons(x):
    while isinstance(x, list) and len(x) == 1:
        x = x[0]
    return x

def _to_list_maybe(x):
    if isinstance(x, np.ndarray):
        return x.tolist()
    return x

def parse_classwise_nms(out_val):
    """
    out_val expected: list length 80 (COCO classes),
    each entry is a list/ndarray of detections for that class.
    Detection row usually: [ymin, xmin, ymax, xmax, score]
    Sometimes:             [xmin, ymin, xmax, ymax, score]
    Returns: (cls, score, xmin, ymin, xmax, ymax)
    """
    dets = []
    x = unwrap_singletons(out_val)

    if not isinstance(x, list) or len(x) != 80:
        return dets

    for cls in range(80):
        det_list = _to_list_maybe(x[cls])
        if not isinstance(det_list, list) or len(det_list) == 0:
            continue

        for d in det_list:
            d = _to_list_maybe(d)
            if not isinstance(d, (list, tuple)) or len(d) < 5:
                continue

            a0, a1, a2, a3, a4 = d[:5]
            try:
                a0, a1, a2, a3, score = float(a0), float(a1), float(a2), float(a3), float(a4)
            except Exception:
                continue

            if score < CONF_TH:
                continue

            ymin, xmin, ymax, xmax = a0, a1, a2, a3

            # If invalid ordering, try the other common order
            if xmax < xmin or ymax < ymin:
                xmin, ymin, xmax, ymax = a0, a1, a2, a3

            dets.append((cls, score, xmin, ymin, xmax, ymax))

    return dets

def publish_status(client, service, state, extra=None):
    msg = {
        "type": "STATUS",
        "service": service,
        "state": state,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if isinstance(extra, dict):
        msg.update(extra)
    client.publish(TOPIC_STATUS, json.dumps(msg), qos=1, retain=False)


# =========================
# MQTT command handler
# =========================
def on_message(client, userdata, msg):
    global dataset_active, dataset_until, last_dataset_ts, ai_sent_ts
    global last_ai_rtt_ms, last_ai_rtt_ts_ms

    # ---- AI ACK handler (RTT measured on Pi; no clock sync needed) ----
    if msg.topic == TOPIC_AI_ACK:
        try:
            payload = msg.payload.decode("utf-8", errors="ignore")
            ack = json.loads(payload)
        except Exception:
            return

        if not isinstance(ack, dict):
            return

        if ack.get("type") != "AI_ACK":
            return

        msg_id = ack.get("msg_id")
        if not msg_id:
            return

  
        t_ack_recv_ms = now_ms()
        t_ack_recv_mono_ns = time.monotonic_ns()

        with ai_lock:
            rec = ai_sent_ts.get(msg_id)

        if not rec:
            # 🔥 IMPORTANT: don’t fail silently
            publish_debug(client, {
                "type": "AI_ACK_DROP",
                "reason": "msg_id_not_found",
                "msg_id": msg_id,
                "t_ack_recv_ms": int(t_ack_recv_ms),
                "ack_from": ack.get("receiver"),
            }, min_period=0.0)
            return

        t_send_ms = int(rec.get("t_send_ms", 0))
        t_send_mono_ns = rec.get("t_send_mono_ns")

        # ✅ Clock-safe RTT (monotonic)
        if isinstance(t_send_mono_ns, int) and t_send_mono_ns > 0:
            rtt_ms = (t_ack_recv_mono_ns - t_send_mono_ns) / 1e6
        else:
            # fallback (shouldn’t happen once you store mono_ns everywhere)
            rtt_ms = float(t_ack_recv_ms - t_send_ms)

        # basic sanity clamp (prevents weird negatives from ever propagating)
        if rtt_ms < 0:
            publish_debug(client, {
                "type": "AI_ACK_DROP",
                "reason": "negative_rtt",
                "msg_id": msg_id,
                "rtt_ms": float(rtt_ms),
                "t_send_ms": int(t_send_ms),
                "t_ack_recv_ms": int(t_ack_recv_ms),
            }, min_period=0.0)
            return

        e2e_est_ms = float(rtt_ms) / 2.0

        # jitter
        jitter_ms = None
        global last_ai_rtt_ms, last_ai_rtt_ts_ms
        if last_ai_rtt_ms is not None:
            jitter_ms = abs(float(rtt_ms) - float(last_ai_rtt_ms))
        last_ai_rtt_ms = float(rtt_ms)
        last_ai_rtt_ts_ms = int(t_ack_recv_ms)

        receiver = ack.get("receiver")
        receiver_norm = receiver.strip().upper() if isinstance(receiver, str) else ""

        with ai_lock:
            acked = rec.get("acked")
            if not isinstance(acked, dict):
                acked = {}
                rec["acked"] = acked
            if receiver_norm:
                acked[receiver_norm] = int(t_ack_recv_ms)

        payload_qos = json.dumps({
            "type": "AI_RTT",
            "msg_id": msg_id,
            "rtt_ms": float(rtt_ms),
            "jitter_ms": jitter_ms,
            "e2e_est_ms": e2e_est_ms,
            "ack_from": receiver,
            "t_send_ms": int(t_send_ms),
            "t_ack_recv_ms": int(t_ack_recv_ms),
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })

        # publish on BOTH planes
        try:
            (CLIENT_CTRL or client).publish(TOPIC_QOS, payload_qos, qos=1, retain=False)
        except Exception:
            pass
        try:
            (CLIENT_ALERT or client).publish(TOPIC_QOS, payload_qos, qos=1, retain=False)
        except Exception:
            pass

        # cleanup (safe)
        with ai_lock:
            rec = ai_sent_ts.get(msg_id)
            if not rec:
                publish_debug(client, {
                    "type": "AI_ACK_DROP",
                    "reason": "msg_id_not_tracked",
                    "msg_id": msg_id,
                    "ack_from": ack.get("receiver"),
                    "t_ack_recv_ms": int(t_ack_recv_ms),
                    "tracked_count": len(ai_sent_ts),
                }, min_period=0.0)
                return


            if "t_first_send_ms" not in rec:
                rec["t_first_send_ms"] = int(t_send_ms)

            acked = rec.get("acked", {})
            got_rbc = "RBC" in acked
            got_other = any(k != "RBC" for k in acked.keys())

            if got_rbc and got_other:
                ai_sent_ts.pop(msg_id, None)
            else:
                age_ms = int(t_ack_recv_ms - int(rec.get("t_first_send_ms", t_send_ms)))
                if age_ms > 10000:
                    ai_sent_ts.pop(msg_id, None)

        

    # ---- existing CMD handler ----
    if msg.topic != TOPIC_CMD:
        return

    try:
        payload = msg.payload.decode("utf-8", errors="ignore")
        obj = json.loads(payload)
    except Exception:
        return

    if not isinstance(obj, dict):
        return

    cmd = (obj.get("cmd") or "").strip().upper()
    if cmd == "CAPTURE_30S":
        dataset_active = True
        dataset_until = time.time() + DATASET_DURATION_S
        last_dataset_ts = 0.0
        publish_status(client, "dataset", "started", {"duration_s": DATASET_DURATION_S, "fps": DATASET_FPS})


# =========================
# ROI (Labelme JSON) helpers
# =========================
ROI_DIR = Path("/home/daminiraspi/Thesis_train_obu/roi")
ROI_STRAIGHT_JSON = ROI_DIR / "track_straight.json"
ROI_CURVE_JSON    = ROI_DIR / "track_curve.json"

ROI_MODE = "straight"   # "straight" or "curve" (manual). Auto will override per-frame below.

# stricter -> fewer false "on track" detections
ROI_OVERLAP_TH = 0.20

def load_labelme_polygon(json_path: Path, target_w: int, target_h: int, label_name: str) -> np.ndarray:
    obj = json.loads(json_path.read_text(encoding="utf-8"))
    src_w = int(obj.get("imageWidth", target_w))
    src_h = int(obj.get("imageHeight", target_h))

    shapes = obj.get("shapes", [])
    pts = None
    for s in shapes:
        if (s.get("label") or "").strip() == label_name:
            pts = s.get("points")
            break
    if pts is None:
        raise ValueError(f"Label '{label_name}' not found in {json_path}")

    pts = np.array(pts, dtype=np.float32)  # Nx2 in source coords
    sx = float(target_w) / float(src_w)
    sy = float(target_h) / float(src_h)
    pts[:, 0] *= sx
    pts[:, 1] *= sy
    return pts.astype(np.int32)

def polygon_to_mask(poly_pts: np.ndarray, w: int, h: int) -> np.ndarray:
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, [poly_pts], 1)
    return mask

def bbox_roi_overlap(xmin, ymin, xmax, ymax, roi_mask: np.ndarray) -> float:
    h, w = roi_mask.shape
    x1 = max(0, min(w - 1, int(xmin)))
    y1 = max(0, min(h - 1, int(ymin)))
    x2 = max(0, min(w,     int(xmax)))
    y2 = max(0, min(h,     int(ymax)))

    if x2 <= x1 or y2 <= y1:
        return 0.0

    roi_crop = roi_mask[y1:y2, x1:x2]
    overlap = float(roi_crop.sum())
    area = float((x2 - x1) * (y2 - y1))
    return overlap / area if area > 0 else 0.0


# =========================
# Distance proxy (approx, requires calibration)
# =========================
CAL_FOCAL_PX = 820.0  # adjust once using a known distance test

REAL_HEIGHT_M = {
    0: 1.70,  # person
    1: 1.50,  # bicycle+rider approx
    2: 1.50,  # car
    3: 1.50,  # motorcycle+rider approx
    5: 3.00,  # bus
    6: 3.20,  # train front approx
    7: 3.00,  # truck
}

DIST_CLOSE_M = 3.0
DIST_MEDIUM_M = 6.0

def estimate_distance_m(cls_id: int, bbox_h_px: float) -> Optional[float]:
    if bbox_h_px <= 1.0:
        return None
    H = REAL_HEIGHT_M.get(int(cls_id))
    if not H:
        return None
    return (H * float(CAL_FOCAL_PX)) / float(bbox_h_px)

def distance_bucket(dist_m: Optional[float]) -> str:
    if dist_m is None:
        return "unknown"
    if dist_m <= DIST_CLOSE_M:
        return "CLOSE"
    if dist_m <= DIST_MEDIUM_M:
        return "MEDIUM"
    return "FAR"


# =========================
# Track visibility / unknown-obstacle proxy (VERY STRICT)
# =========================
TRACK_CHECK_DOWNSCALE = 320

TRACK_EDGE_DENSITY_TH = 0.0022
TRACK_BAD_SECONDS_TO_ALERT = 3.0
TRACK_BAD_MIN_FRAMES = 28
TRACK_ANOMALY_COOLDOWN_S = 12.0

TRACK_DENSITY_EMA_ALPHA = 0.10
ROI_SELECT_HYSTERESIS = 0.00025

track_bad_start_ts: Optional[float] = None
track_bad_frames = 0
last_track_anomaly_ts = 0.0

roi_mode_used = ROI_MODE

ema_straight: Optional[float] = None
ema_curve: Optional[float] = None

def _prep_small(gray: np.ndarray, target: int) -> np.ndarray:
    if gray.shape[0] == target and gray.shape[1] == target:
        return gray
    return cv2.resize(gray, (target, target), interpolation=cv2.INTER_AREA)

def edge_density_in_roi(gray_s: np.ndarray, roi_mask_small: np.ndarray) -> float:
    gray_s = cv2.GaussianBlur(gray_s, (5, 5), 0)
    edges = cv2.Canny(gray_s, 60, 140)

    roi = roi_mask_small.astype(np.uint8)
    roi_area = float(roi.sum())
    if roi_area <= 10.0:
        return 1.0

    edge_hits = float(((edges > 0) & (roi > 0)).sum())
    return edge_hits / roi_area

def choose_roi_mode_auto(gray_s: np.ndarray,
                         roi_straight_mask_small: np.ndarray,
                         roi_curve_mask_small: np.ndarray) -> Tuple[str, float, float]:
    global roi_mode_used, ema_straight, ema_curve

    dens_s = edge_density_in_roi(gray_s, roi_straight_mask_small)
    dens_c = edge_density_in_roi(gray_s, roi_curve_mask_small)

    if ema_straight is None:
        ema_straight = dens_s
    else:
        ema_straight = (1.0 - TRACK_DENSITY_EMA_ALPHA) * float(ema_straight) + TRACK_DENSITY_EMA_ALPHA * dens_s

    if ema_curve is None:
        ema_curve = dens_c
    else:
        ema_curve = (1.0 - TRACK_DENSITY_EMA_ALPHA) * float(ema_curve) + TRACK_DENSITY_EMA_ALPHA * dens_c

    if roi_mode_used == "straight":
        if float(ema_curve) > float(ema_straight) + ROI_SELECT_HYSTERESIS:
            roi_mode_used = "curve"
    else:
        if float(ema_straight) > float(ema_curve) + ROI_SELECT_HYSTERESIS:
            roi_mode_used = "straight"

    return roi_mode_used, float(ema_straight), float(ema_curve)

def update_track_anomaly_strict(client_ctrl, client_alert,
                                dens_used_ema: float,
                                now: float,
                                mode_used: str,
                                t_capture_ms: Optional[int] = None):
    global track_bad_start_ts, track_bad_frames, last_track_anomaly_ts
    global ai_sent_ts

    is_bad = dens_used_ema < TRACK_EDGE_DENSITY_TH

    if is_bad:
        track_bad_frames += 1
        if track_bad_start_ts is None:
            track_bad_start_ts = now
    else:
        track_bad_frames = 0
        track_bad_start_ts = None

    bad_duration = 0.0 if track_bad_start_ts is None else (now - track_bad_start_ts)

    publish_debug(client_ctrl, {
        "type": "TRACK_VIS",
        "roi_mode_used": mode_used,
        "edge_density_ema": round(float(dens_used_ema), 6),
        "th": TRACK_EDGE_DENSITY_TH,
        "bad_frames": int(track_bad_frames),
        "bad_duration_s": round(float(bad_duration), 2),
        "cooldown_left_s": round(max(0.0, TRACK_ANOMALY_COOLDOWN_S - (now - last_track_anomaly_ts)), 2),
    }, min_period=0.5)

    if (track_bad_start_ts is not None and
        bad_duration >= TRACK_BAD_SECONDS_TO_ALERT and
        track_bad_frames >= TRACK_BAD_MIN_FRAMES and
        (now - last_track_anomaly_ts) >= TRACK_ANOMALY_COOLDOWN_S):

        msg_id, seq = next_alert_id("TRACK")
        #t_send_ms = now_ms()
        
        # ✅ store for RTT (Pi will receive ACK later)
        #ai_sent_ts[msg_id] = {"t_send_ms": int(t_send_ms)}
        
        t_send_ms = now_ms()
        t_send_mono_ns = time.monotonic_ns()

        with ai_lock:
            ai_sent_ts[msg_id] = {
                "t_send_ms": int(t_send_ms),
                "t_send_mono_ns": int(t_send_mono_ns),
                "acked": {}
            }


        # simple TTL cleanup
        cutoff = now_ms() - AI_SENT_TTL_MS
        for k in list(ai_sent_ts.keys()):
            if ai_sent_ts[k]["t_send_ms"] < cutoff:
                ai_sent_ts.pop(k, None)
        
        anomaly = {
            "type": "AI_ALERT",
            "category": "unknown",
            "label": "track_anomaly",
            "reason": "low_track_texture",
            "roi_mode": mode_used,
            "edge_density_ema": round(float(dens_used_ema), 6),
            "threshold": TRACK_EDGE_DENSITY_TH,
            "bad_frames": int(track_bad_frames),
            "bad_duration_s": round(float(bad_duration), 2),

            # ✅ IDs + timestamps
            "msg_id": msg_id,
            "seq": int(seq),
            "t_capture_ms": int(t_capture_ms) if t_capture_ms is not None else None,
            "t_send_ms": int(t_send_ms),

            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "src": "pi_cam_hailo_combo",
            "plane": "alert",
            "origin": "pi"

        }
        client_alert.publish(TOPIC_ALERT_REMOTE, json.dumps(anomaly), qos=1, retain=False)
        client_alert.publish(TOPIC_ALERT_RBC, json.dumps(anomaly), qos=2, retain=False)

        last_track_anomaly_ts = now
        track_bad_start_ts = None
        track_bad_frames = 0


# =========================
# Main
# =========================
def main():
    global dataset_active, dataset_until, last_dataset_ts
    global roi_mode_used

    client_ctrl = mqtt.Client(client_id="pi_cam_ctrl")
    
    #NEW ADDITIONS
    global CLIENT_CTRL
    CLIENT_CTRL = client_ctrl

    client_ctrl.on_message = on_message
    client_ctrl.connect(BROKER_IP, BROKER_PORT_CTRL, keepalive=30)
    client_ctrl.loop_start()
    client_ctrl.subscribe(TOPIC_CMD, qos=1)
    client_ctrl.subscribe(TOPIC_AI_ACK, qos=1)

    client_video = mqtt.Client(client_id="pi_cam_video")
    client_video.connect(BROKER_IP, BROKER_PORT_VIDEO, keepalive=30)
    client_video.loop_start()
    
    client_alert = mqtt.Client(client_id="pi_cam_alert")
    client_alert.on_message = on_message
    
    global CLIENT_ALERT
    CLIENT_ALERT = client_alert

    client_alert.connect(BROKER_IP, BROKER_PORT_ALERT, keepalive=30)
    client_alert.loop_start()
    
    client_alert.subscribe(TOPIC_AI_ACK, qos=1)

    global QOS_PUB_CLIENT
    QOS_PUB_CLIENT = client_ctrl


    publish_status(client_ctrl, "camera", "starting", {"topic": TOPIC_CAM})
    publish_status(client_ctrl, "dataset", "dir", {"path": str(DATASET_DIR)})


    # Camera (inverted)
    picam2 = Picamera2()
    cfg = picam2.create_video_configuration(
        main={"size": (MODEL_W, MODEL_H), "format": "RGB888"},
        transform=Transform(hflip=True, vflip=True)
    )
    picam2.configure(cfg)
    picam2.start()

    try:
        picam2.set_controls({"AfMode": 2})
    except Exception:
        pass

    time.sleep(1)
    publish_status(client_ctrl, "camera", "active")

    # Load ROI polygons + masks
    roi_straight_pts = load_labelme_polygon(ROI_STRAIGHT_JSON, MODEL_W, MODEL_H, "track_roi_straight")
    roi_curve_pts    = load_labelme_polygon(ROI_CURVE_JSON,    MODEL_W, MODEL_H, "track_roi_curve")

    roi_straight_mask = polygon_to_mask(roi_straight_pts, MODEL_W, MODEL_H)
    roi_curve_mask    = polygon_to_mask(roi_curve_pts,    MODEL_W, MODEL_H)

    roi_straight_mask_small = cv2.resize(
        roi_straight_mask.astype(np.uint8),
        (TRACK_CHECK_DOWNSCALE, TRACK_CHECK_DOWNSCALE),
        interpolation=cv2.INTER_NEAREST
    )
    roi_curve_mask_small = cv2.resize(
        roi_curve_mask.astype(np.uint8),
        (TRACK_CHECK_DOWNSCALE, TRACK_CHECK_DOWNSCALE),
        interpolation=cv2.INTER_NEAREST
    )

    # Hailo
    hef = HEF(HEF_PATH)

    with VDevice() as vdevice:
        network_groups = vdevice.configure(hef)
        ng = network_groups[0]
        ng_params = ng.create_params()

        input_info = hef.get_input_vstream_infos()[0]
        in_params = InputVStreamParams.make(ng, format_type=FormatType.UINT8)
        out_params = OutputVStreamParams.make(ng, format_type=FormatType.FLOAT32)

        last_alert_ts = 0.0
        period = 1.0 / FPS

        with ng.activate(ng_params):
            with InferVStreams(ng, in_params, out_params) as infer:
                try:
                    while True:
                        t0 = time.time()

                        # ✅ Frame ID + capture timestamp
                        frame_id = next_frame_id()
                        t_capture_ms = now_ms()

                        # Capture
                        frame = picam2.capture_array()

                        # Keep same behavior (channel flip)
                        frame_rgb = np.ascontiguousarray(frame[..., ::-1], dtype=np.uint8)

                        # Publish JPEG (and meta)
                        pub_rgb = resize_rgb(frame_rgb, PUB_W, PUB_H)
                        jpeg_bytes = encode_jpeg_from_rgb(pub_rgb, JPEG_QUALITY)

                        t_jpeg_send_ms = now_ms()
                        client_video.publish(
                            TOPIC_CAM,
                            payload=jpeg_bytes,
                            qos=0,
                            retain=False,
                        )

                        # ✅ NEW: metadata topic (for video latency/jitter without touching JPEG bytes)
                        client_video.publish(
                            TOPIC_CAM_META,
                            json.dumps({
                                "type": "CAM_META",
                                "frame_id": int(frame_id),
                                "t_capture_ms": int(t_capture_ms),
                                "t_send_ms": int(t_jpeg_send_ms),
                                "jpeg_bytes": int(len(jpeg_bytes)),
                                "w": int(PUB_W),
                                "h": int(PUB_H),
                                "plane": "video",
                                "origin": "pi"
                            }),
                            qos=0,
                            retain=False
                        )

                        # Inference
                        outputs = infer.infer({input_info.name: frame_rgb[None, ...]})
                        t_infer_done_ms = now_ms()

                        # Parse detections
                        all_dets = []
                        for _, out_val in outputs.items():
                            all_dets.extend(parse_classwise_nms(out_val))

                        now = time.time()

                        # Filter to relevant classes
                        relevant = [
                            d for d in all_dets
                            if (d[0] == PERSON_CLASS_ID or d[0] in VEHICLE_CLASS_IDS or d[0] in ANIMAL_CLASS_IDS)
                        ]

                        # Debug: publish best raw YOLO detection
                        if relevant:
                            best_raw = max(relevant, key=lambda x: x[1])
                            cls_id, score, xmin, ymin, xmax, ymax = best_raw
                            coord_mode = "normalized" if (xmax <= 1.5 and ymax <= 1.5) else "pixels"
                            publish_debug(client_ctrl, {
                                "type": "YOLO_BEST",
                                "label": COCO_LABELS.get(int(cls_id), str(int(cls_id))),
                                "conf": round(float(score), 3),
                                "coord_mode": coord_mode,
                                "bbox": [float(xmin), float(ymin), float(xmax), float(ymax)]
                            })
                        else:
                            publish_debug(client_ctrl, {"type": "YOLO_BEST", "label": None})

                        # ---------- AUTO ROI MODE SELECTION (straight/curve) ----------
                        gray = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2GRAY)
                        gray_s = _prep_small(gray, TRACK_CHECK_DOWNSCALE)

                        roi_mode_used, dens_s_ema, dens_c_ema = choose_roi_mode_auto(
                            gray_s, roi_straight_mask_small, roi_curve_mask_small
                        )

                        roi_mask = roi_straight_mask if roi_mode_used == "straight" else roi_curve_mask
                        dens_used_ema = dens_s_ema if roi_mode_used == "straight" else dens_c_ema

                        publish_debug(client_ctrl, {
                            "type": "ROI_AUTO",
                            "roi_mode_used": roi_mode_used,
                            "dens_straight_ema": round(dens_s_ema, 6),
                            "dens_curve_ema": round(dens_c_ema, 6),
                            "hyst": ROI_SELECT_HYSTERESIS
                        }, min_period=0.5)

                        # ---------- Unknown obstacle proxy: VERY STRICT anomaly ----------
                        update_track_anomaly_strict(client_ctrl, client_alert, dens_used_ema, now, roi_mode_used, t_capture_ms=t_capture_ms)

                        # ---------- ROI filter ----------
                        relevant_on_track = []
                        for (cls, score, xmin, ymin, xmax, ymax) in relevant:
                            # If normalized, scale to pixels
                            if xmax <= 1.5 and ymax <= 1.5:
                                xmin *= MODEL_W
                                xmax *= MODEL_W
                                ymin *= MODEL_H
                                ymax *= MODEL_H

                            ov = bbox_roi_overlap(xmin, ymin, xmax, ymax, roi_mask)
                            ov = bbox_roi_overlap(xmin, ymin, xmax, ymax, roi_mask)
                            on_track_point = bbox_bottom_center_in_roi(xmin, ymin, xmax, ymax, roi_mask)

                            if ov >= ROI_OVERLAP_TH and on_track_point:
                                relevant_on_track.append((cls, score, xmin, ymin, xmax, ymax, ov))

                        publish_debug(client_ctrl, {
                            "type": "ROI_FILTER",
                            "roi_mode_used": roi_mode_used,
                            "overlap_th": ROI_OVERLAP_TH,
                            "relevant_count": len(relevant),
                            "on_track_count": len(relevant_on_track)
                        }, min_period=0.5)

                        # ---------- ALERT ----------
                        if relevant_on_track:
                            best = max(relevant_on_track, key=lambda x: x[1])
                            cls_id, best_score, xmin, ymin, xmax, ymax, best_ov = best

                            bbox_h_px = max(1.0, float(ymax - ymin))
                            dist_m = estimate_distance_m(int(cls_id), bbox_h_px)

                            if dist_m is None or dist_m > MAX_ALERT_DISTANCE_M:
                                publish_debug(client_ctrl, {
                                    "type": "DISTANCE_FILTER",
                                    "roi_mode_used": roi_mode_used,
                                    "distance_m": None if dist_m is None else round(dist_m, 2),
                                    "max_m": MAX_ALERT_DISTANCE_M,
                                    "decision": "ignored_far_object"
                                }, min_period=0.5)
                            else:
                                if best_score >= ALERT_CONF_TH and (now - last_alert_ts) >= ALERT_COOLDOWN_SEC:
                                    label = COCO_LABELS.get(int(cls_id), f"class_{int(cls_id)}")
                                    cat = category_for_cls(int(cls_id))

                                    msg_id, seq = next_alert_id("AI")
                                    #t_send_ms = now_ms()
                                    
                                    # ✅ store for RTT (Pi will receive ACK later)
                                    #ai_sent_ts[msg_id] = {"t_send_ms": int(t_send_ms)}
                                    
                                    t_send_ms = now_ms()
                                    t_send_mono_ns = time.monotonic_ns()

                                    with ai_lock:
                                        ai_sent_ts[msg_id] = {
                                            "t_send_ms": int(t_send_ms),
                                            "t_send_mono_ns": int(t_send_mono_ns),
                                            "acked": {}
                                        }


                                    # simple TTL cleanup
                                    cutoff = now_ms() - AI_SENT_TTL_MS
                                    for k in list(ai_sent_ts.keys()):
                                        if ai_sent_ts[k]["t_send_ms"] < cutoff:
                                            ai_sent_ts.pop(k, None)

                                    
                                    alert = {
                                        "type": "AI_ALERT",
                                        "category": cat,
                                        "cls_id": int(cls_id),
                                        "label": label,
                                        "conf": round(float(best_score), 3),
                                        "roi_overlap": round(float(best_ov), 3),

                                        "bbox": [round(float(xmin), 1), round(float(ymin), 1),
                                                 round(float(xmax), 1), round(float(ymax), 1)],
                                        "bbox_h_px": round(float(bbox_h_px), 1),

                                        "distance_m": round(float(dist_m), 2),
                                        "distance_bucket": distance_bucket(dist_m),

                                        "roi_mode": roi_mode_used,

                                        # ✅ IDs + timestamps
                                        "msg_id": msg_id,
                                        "seq": int(seq),
                                        "frame_id": int(frame_id),
                                        "t_capture_ms": int(t_capture_ms),
                                        "t_infer_done_ms": int(t_infer_done_ms),
                                        "t_send_ms": int(t_send_ms),

                                        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                        "src": "pi_cam_hailo_combo",
                                        "plane": "alert",
                                        "origin": "pi"

                                    }
                 
                                    client_alert.publish(TOPIC_ALERT_REMOTE, json.dumps(alert), qos=1, retain=False)
                                    client_alert.publish(TOPIC_ALERT_RBC, json.dumps(alert), qos=2, retain=False)

                                    last_alert_ts = now

                        # ---------- Dataset capture ----------
                        if dataset_active:
                            if now >= dataset_until:
                                dataset_active = False
                                publish_status(client_ctrl, "dataset", "finished")
                            else:
                                if last_dataset_ts == 0.0 or (now - last_dataset_ts) >= (1.0 / DATASET_FPS):
                                    last_dataset_ts = now
                                    ts = time.strftime("%Y%m%d_%H%M%S", time.localtime())
                                    ms = int((time.time() * 1000) % 1000)
                                    fname = f"frame_{ts}_{ms:03d}.jpg"
                                    fpath = DATASET_DIR / fname

                                    Image.fromarray(frame_rgb, mode="RGB").save(
                                        fpath,
                                        format="JPEG",
                                        quality=95,
                                        subsampling=0
                                    )
                                    publish_status(client_ctrl, "dataset", "saved", {"file": str(fpath)})

                        # FPS pacing
                        dt = time.time() - t0
                        if dt < period:
                            time.sleep(period - dt)

                except KeyboardInterrupt:
                    pass
                finally:
                    try:
                        picam2.stop()
                    except Exception:
                        pass
                    client_ctrl.loop_stop()
                    client_ctrl.disconnect()
                    
                    client_video.loop_stop()
                    client_video.disconnect()
                    
                    client_alert.loop_stop()
                    client_alert.disconnect()

if __name__ == "__main__":
    main()

