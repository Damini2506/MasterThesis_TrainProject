#!/usr/bin/env bash
set -euo pipefail

# ---------------- CONFIG ----------------
IFACE="${IFACE:-wlan0}"
IFB="${IFB:-ifb0}"
DELAY="${DELAY:-100ms}"

# Force user to provide total available bandwidth in kbit
# Example:
#   sudo ./tc_qos_dynamic_start.sh 1200
#   sudo ./tc_qos_dynamic_start.sh 900
RATE_TOTAL_KBIT="${1:?Please specify bandwidth in kbit, e.g. 1200, 900, 600}"
RATE_TOTAL="${RATE_TOTAL_KBIT}kbit"

# Relative service weights
W_ETCS="${W_ETCS:-5}"
W_AI="${W_AI:-3}"
W_VIDEO="${W_VIDEO:-1}"

# Service ports
ETCS_PORT="${ETCS_PORT:-1883}"
VIDEO_PORT="${VIDEO_PORT:-1886}"
AI_PORT="${AI_PORT:-1887}"
CTRL_WS_PORT="${CTRL_WS_PORT:-9001}"

# Optional duration for fail-safe auto-clear
DUR="${DUR:-180}"
PIDFILE="/tmp/tc_qos_dynamic_${IFACE}.pid"
# ----------------------------------------

SUM_W=$((W_ETCS + W_AI + W_VIDEO))

RATE_ETCS_MIN_KBIT=$(( RATE_TOTAL_KBIT * W_ETCS / SUM_W ))
RATE_AI_MIN_KBIT=$(( RATE_TOTAL_KBIT * W_AI / SUM_W ))
RATE_VIDEO_MIN_KBIT=$(( RATE_TOTAL_KBIT * W_VIDEO / SUM_W ))

RATE_ETCS_MIN="${RATE_ETCS_MIN_KBIT}kbit"
RATE_AI_MIN="${RATE_AI_MIN_KBIT}kbit"
RATE_VIDEO_MIN="${RATE_VIDEO_MIN_KBIT}kbit"

kill_timer() {
  if [[ -f "$PIDFILE" ]]; then
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

  clear_dev "$IFACE"
  sudo tc qdisc del dev "$IFACE" handle ffff: ingress 2>/dev/null || true

  if ip link show "$IFB" >/dev/null 2>&1; then
    clear_dev "$IFB"
    sudo ip link set dev "$IFB" down 2>/dev/null || true
    sudo ip link del "$IFB" 2>/dev/null || true
  fi

  sudo modprobe -r ifb 2>/dev/null || true
}

show_all() {
  echo "=== $IFACE qdisc ==="
  sudo tc -s qdisc show dev "$IFACE" || true
  echo "=== $IFACE class ==="
  sudo tc -s class show dev "$IFACE" || true
  echo "=== $IFACE filters ==="
  sudo tc filter show dev "$IFACE" parent 1: || true
  echo "=== $IFACE ingress filters ==="
  sudo tc filter show dev "$IFACE" parent ffff: 2>/dev/null || true

  if ip link show "$IFB" >/dev/null 2>&1; then
    echo "=== $IFB qdisc ==="
    sudo tc -s qdisc show dev "$IFB" || true
    echo "=== $IFB class ==="
    sudo tc -s class show dev "$IFB" || true
    echo "=== $IFB filters ==="
    sudo tc filter show dev "$IFB" parent 1: || true
  else
    echo "=== $IFB does not exist ==="
  fi
}

apply_3class() {
  local DEV="$1"

  sudo tc qdisc add dev "$DEV" root handle 1: htb default 30
  sudo tc class add dev "$DEV" parent 1: classid 1:1 \
    htb rate "$RATE_TOTAL" ceil "$RATE_TOTAL"

  sudo tc class add dev "$DEV" parent 1:1 classid 1:10 \
    htb rate "$RATE_ETCS_MIN" ceil "$RATE_TOTAL" prio 0

  sudo tc class add dev "$DEV" parent 1:1 classid 1:20 \
    htb rate "$RATE_AI_MIN" ceil "$RATE_TOTAL" prio 1

  sudo tc class add dev "$DEV" parent 1:1 classid 1:30 \
    htb rate "$RATE_VIDEO_MIN" ceil "$RATE_TOTAL" prio 2

  sudo tc qdisc add dev "$DEV" parent 1:10 handle 10: netem delay "$DELAY" limit 50
  sudo tc qdisc add dev "$DEV" parent 10:1 handle 110: fq_codel

  sudo tc qdisc add dev "$DEV" parent 1:20 handle 20: netem delay "$DELAY" limit 50
  sudo tc qdisc add dev "$DEV" parent 20:1 handle 120: fq_codel

  sudo tc qdisc add dev "$DEV" parent 1:30 handle 30: netem delay "$DELAY" limit 200
  sudo tc qdisc add dev "$DEV" parent 30:1 handle 130: fq_codel

  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 10 u32 \
    match ip protocol 6 0xff match ip dport "$ETCS_PORT" 0xffff flowid 1:10
  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 11 u32 \
    match ip protocol 6 0xff match ip sport "$ETCS_PORT" 0xffff flowid 1:10

  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 12 u32 \
    match ip protocol 6 0xff match ip dport "$CTRL_WS_PORT" 0xffff flowid 1:10
  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 13 u32 \
    match ip protocol 6 0xff match ip sport "$CTRL_WS_PORT" 0xffff flowid 1:10

  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 20 u32 \
    match ip protocol 6 0xff match ip dport "$AI_PORT" 0xffff flowid 1:20
  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 21 u32 \
    match ip protocol 6 0xff match ip sport "$AI_PORT" 0xffff flowid 1:20

  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 30 u32 \
    match ip protocol 6 0xff match ip dport "$VIDEO_PORT" 0xffff flowid 1:30
  sudo tc filter add dev "$DEV" protocol ip parent 1: prio 31 u32 \
    match ip protocol 6 0xff match ip sport "$VIDEO_PORT" 0xffff flowid 1:30
}

case "${2:-}" in
  --clear|clear)
    echo "[qos] Clearing tc + ifb on $IFACE"
    clear_all
    show_all
    exit 0
    ;;
  --show|show)
    show_all
    exit 0
    ;;
esac

echo "[qos] Applying dynamic QoS"
echo "[qos] IFACE=$IFACE IFB=$IFB"
echo "[qos] TOTAL=$RATE_TOTAL DELAY=$DELAY"
echo "[qos] Weights: ETCS=$W_ETCS AI=$W_AI VIDEO=$W_VIDEO"
echo "[qos] Min rates: ETCS=$RATE_ETCS_MIN AI=$RATE_AI_MIN VIDEO=$RATE_VIDEO_MIN"
echo "[qos] Ports: ETCS=$ETCS_PORT AI=$AI_PORT VIDEO=$VIDEO_PORT CTRL_WS=$CTRL_WS_PORT"

clear_all

sudo modprobe ifb numifbs=1
sudo ip link add "$IFB" type ifb 2>/dev/null || true
sudo ip link set dev "$IFB" up

sudo tc qdisc add dev "$IFACE" handle ffff: ingress
sudo tc filter add dev "$IFACE" parent ffff: protocol ip u32 match u32 0 0 \
  action mirred egress redirect dev "$IFB"

apply_3class "$IFACE"
apply_3class "$IFB"

echo "[qos] Applied successfully. Snapshot:"
show_all

(
  sleep "$DUR"
  echo "[qos] Fail-safe triggered: clearing tc + ifb"
  clear_all
) &
echo $! | sudo tee "$PIDFILE" >/dev/null

echo "[qos] Done."
echo "[qos] Emergency clear:"
echo "  sudo ./${0##*/} ${RATE_TOTAL_KBIT} --clear"