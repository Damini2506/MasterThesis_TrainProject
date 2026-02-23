#!/usr/bin/env bash
set -euo pipefail

IFACE="${IFACE:-wlan0}"
DUR="${DUR:-180}"

RATE_TOTAL="${RATE_TOTAL:-1200kbit}"
DELAY="${DELAY:-100ms}"

PIDFILE="/tmp/tc_noqos_${IFACE}.pid"

kill_timer() {
  if [[ -f "$PIDFILE" ]]; then
    pid="$(cat "$PIDFILE" || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      sudo kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
}

clear_tc() {
  kill_timer
  sudo tc qdisc del dev "$IFACE" root 2>/dev/null || true
  sudo tc qdisc del dev "$IFACE" ingress 2>/dev/null || true
  sudo tc qdisc del dev "$IFACE" clsact 2>/dev/null || true
}

show_tc() {
  echo "---- qdisc ----"
  sudo tc -s qdisc show dev "$IFACE" || true
  echo "---- class ----"
  sudo tc -s class show dev "$IFACE" || true
}

case "${1:-}" in
  --clear)
    echo "[noqos] Clearing tc on $IFACE ..."
    clear_tc
    show_tc
    exit 0
    ;;
  --show)
    show_tc
    exit 0
    ;;
esac

echo "[noqos] Applying shared impairment on $IFACE for ${DUR}s"
echo "[noqos] TOTAL=$RATE_TOTAL, DELAY=$DELAY"

clear_tc

# One class only -> no QoS separation; everything competes together
sudo tc qdisc add dev "$IFACE" root handle 1: htb default 10
sudo tc class add dev "$IFACE" parent 1: classid 1:1  htb rate "$RATE_TOTAL" ceil "$RATE_TOTAL"
sudo tc class add dev "$IFACE" parent 1:1 classid 1:10 htb rate "$RATE_TOTAL" ceil "$RATE_TOTAL"

# Same delay for all traffic
sudo tc qdisc add dev "$IFACE" parent 1:10 handle 10: netem delay "$DELAY"

show_tc

# Fail-safe rollback (store PID)
(
  sleep "$DUR"
  echo "[noqos] Fail-safe triggered: clearing tc on $IFACE"
  clear_tc
) &
echo $! | sudo tee "$PIDFILE" >/dev/null

echo "[noqos] Done. Emergency clear:"
echo "  sudo ./tc_noqos_1200k_100ms.sh --clear"
