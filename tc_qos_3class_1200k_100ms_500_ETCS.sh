#!/usr/bin/env bash
set -euo pipefail

# -------- CONFIG --------
IFACE="${IFACE:-wlan0}"
IFB="${IFB:-ifb0}"
DUR="${DUR:-180}"

RATE_TOTAL="${RATE_TOTAL:-1200kbit}"
DELAY="${DELAY:-100ms}"

RATE_ETCS="${RATE_ETCS:-500kbit}"
RATE_AI="${RATE_AI:-400kbit}"
RATE_VIDEO="${RATE_VIDEO:-300kbit}"

ETCS_PORT="${ETCS_PORT:-1883}"
VIDEO_PORT="${VIDEO_PORT:-1886}"
AI_PORT="${AI_PORT:-1887}"
# ------------------------

PIDFILE="/tmp/tc_duplex_${IFACE}.pid"

kill_timer() {
  if [[ -f "$PIDFILE" ]]; then
    local pid
    pid="$(cat "$PIDFILE" || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      sudo kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
}

clear_dev() {
  local dev="$1"
  sudo tc qdisc del dev "$dev" root 2>/dev/null || true
  sudo tc qdisc del dev "$dev" ingress 2>/dev/null || true
  sudo tc qdisc del dev "$dev" clsact 2>/dev/null || true
}

clear_all() {
  kill_timer

  # clear IFACE (both root and ingress hooks)
  clear_dev "$IFACE"
  sudo tc qdisc del dev "$IFACE" handle ffff: ingress 2>/dev/null || true

  # clear IFB if it exists
  if ip link show "$IFB" >/dev/null 2>&1; then
    clear_dev "$IFB"
    sudo ip link set dev "$IFB" down 2>/dev/null || true
    sudo ip link del "$IFB" 2>/dev/null || true
  fi

  # best-effort unload
  sudo modprobe -r ifb 2>/dev/null || true
}

show_all() {
  echo "=== $IFACE qdisc ==="
  sudo tc -s qdisc show dev "$IFACE" || true
  echo "=== $IFACE class ==="
  sudo tc -s class show dev "$IFACE" || true
  echo "=== $IFACE filters (htb) ==="
  sudo tc filter show dev "$IFACE" parent 1: || true
  echo "=== $IFACE ingress filters ==="
  sudo tc filter show dev "$IFACE" parent ffff: 2>/dev/null || true

  if ip link show "$IFB" >/dev/null 2>&1; then
    echo "=== $IFB qdisc ==="
    sudo tc -s qdisc show dev "$IFB" || true
    echo "=== $IFB class ==="
    sudo tc -s class show dev "$IFB" || true
    echo "=== $IFB filters (htb) ==="
    sudo tc filter show dev "$IFB" parent 1: || true
  else
    echo "=== $IFB does not exist ==="
  fi
}

apply_3class() {
  local DEV="$1"

  # Root scheduler
  sudo tc qdisc add dev "$DEV" root handle 1: htb default 30
  sudo tc class add dev "$DEV" parent 1: classid 1:1 htb rate "$RATE_TOTAL" ceil "$RATE_TOTAL"

  # 3 classes with priorities (lower = higher priority)
  sudo tc class add dev "$DEV" parent 1:1 classid 1:10 htb rate "$RATE_ETCS"  ceil "$RATE_TOTAL" prio 0
  sudo tc class add dev "$DEV" parent 1:1 classid 1:20 htb rate "$RATE_AI"    ceil "$RATE_TOTAL" prio 1
  sudo tc class add dev "$DEV" parent 1:1 classid 1:30 htb rate "$RATE_VIDEO" ceil "$RATE_TOTAL" prio 2

  # Same delay for all classes
# netem adds delay; limit keeps queue from becoming huge
sudo tc qdisc add dev "$DEV" parent 1:10 handle 10: netem delay "$DELAY" limit 50
sudo tc qdisc add dev "$DEV" parent 10:1 handle 110: fq_codel

sudo tc qdisc add dev "$DEV" parent 1:20 handle 20: netem delay "$DELAY" limit 50
sudo tc qdisc add dev "$DEV" parent 20:1 handle 120: fq_codel

sudo tc qdisc add dev "$DEV" parent 1:30 handle 30: netem delay "$DELAY" limit 200
sudo tc qdisc add dev "$DEV" parent 30:1 handle 130: fq_codel

  # Classify TCP both directions by port (sport/dport)
  # ETCS
  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 10 u32 \
    match ip protocol 6 0xff match ip dport "$ETCS_PORT" 0xffff flowid 1:10
  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 11 u32 \
    match ip protocol 6 0xff match ip sport "$ETCS_PORT" 0xffff flowid 1:10

  # AI
  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 20 u32 \
    match ip protocol 6 0xff match ip dport "$AI_PORT" 0xffff flowid 1:20
  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 21 u32 \
    match ip protocol 6 0xff match ip sport "$AI_PORT" 0xffff flowid 1:20

  # VIDEO
  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 30 u32 \
    match ip protocol 6 0xff match ip dport "$VIDEO_PORT" 0xffff flowid 1:30
  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 31 u32 \
    match ip protocol 6 0xff match ip sport "$VIDEO_PORT" 0xffff flowid 1:30
  
  # CTRL WebSockets (Remote OBU control client)
CTRL_WS_PORT=9001

sudo tc filter add dev "$DEV" protocol ip parent 1: prio 12 u32 \
  match ip protocol 6 0xff match ip dport $CTRL_WS_PORT 0xffff flowid 1:10
sudo tc filter add dev "$DEV" protocol ip parent 1: prio 13 u32 \
  match ip protocol 6 0xff match ip sport $CTRL_WS_PORT 0xffff flowid 1:10
}

# -------- CLI --------
if [[ "${1:-}" == "--clear" ]]; then
  echo "[duplex_qos] Clearing tc + ifb..."
  clear_all
  show_all
  exit 0
fi

if [[ "${1:-}" == "--show" ]]; then
  show_all
  exit 0
fi

echo "[duplex_qos] Applying FULL DUPLEX QoS for ${DUR}s"
echo "[duplex_qos] TOTAL=$RATE_TOTAL, DELAY=$DELAY"
echo "[duplex_qos] rates: ETCS=$RATE_ETCS(prio0) AI=$RATE_AI(prio1) VIDEO=$RATE_VIDEO(prio2)"
echo "[duplex_qos] ports: ETCS=$ETCS_PORT AI=$AI_PORT VIDEO=$VIDEO_PORT"
echo "[duplex_qos] IFACE=$IFACE IFB=$IFB"

clear_all

# --- Setup IFB for ingress shaping ---
sudo modprobe ifb numifbs=1
sudo ip link add "$IFB" type ifb 2>/dev/null || true
sudo ip link set dev "$IFB" up

# Redirect ALL ingress on IFACE to IFB
sudo tc qdisc add dev "$IFACE" handle ffff: ingress
sudo tc filter add dev "$IFACE" parent ffff: protocol ip u32 match u32 0 0 \
  action mirred egress redirect dev "$IFB"

# Apply QoS both directions
apply_3class "$IFACE"
apply_3class "$IFB"

echo "[duplex_qos] Applied. Snapshot:"
show_all

# Fail-safe rollback (store PID so --clear can kill it)
(
  sleep "$DUR"
  echo "[duplex_qos] Fail-safe: clearing tc + ifb"
  clear_all
) &
echo $! | sudo tee "$PIDFILE" >/dev/null

echo "[duplex_qos] Done. Emergency clear:"
echo "  sudo ./${0##*/} --clear"
