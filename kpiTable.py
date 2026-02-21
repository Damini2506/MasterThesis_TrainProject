#!/usr/bin/env python3
"""
KPI Table Builder (thesis-friendly, clock-safe)

Reads:
  - RBC JSONL
  - Remote-OBU JSONL

Outputs a fixed KPI table with stable row names.

Important principle:
  - Never compute one-way latency by subtracting timestamps from different machines
    (OBU vs RBC vs Remote-OBU) unless you have clock sync or offset correction.
  - Prefer receiver-side deltas (single clock) like rtt_ms, inter_arrival_ms,
    remote_ack_rx_delay_ms, etc.
"""

from __future__ import annotations

import argparse
import json
from typing import Optional, Tuple

import pandas as pd

MISSING = "—"
PLAUSIBLE_MAX_MS = 60_000  # guard against cross-clock epoch offsets


# -----------------------------
# IO
# -----------------------------
def read_jsonl(path: str) -> pd.DataFrame:
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return pd.DataFrame(rows)


# -----------------------------
# helpers
# -----------------------------
def to_num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")


def plausible(vals: pd.Series, max_ms: int = PLAUSIBLE_MAX_MS) -> pd.Series:
    vals = to_num(vals).dropna()
    return vals[(vals >= 0) & (vals <= max_ms)]


def mean_std(vals: pd.Series) -> Tuple[Optional[float], Optional[float]]:
    v = plausible(vals)
    if v.empty:
        return None, None
    m = float(v.mean())
    sd = float(v.std(ddof=1)) if len(v) >= 2 else None
    return m, sd


def p95(vals: pd.Series) -> Optional[float]:
    v = plausible(vals)
    if v.empty:
        return None
    return float(v.quantile(0.95))


def fmt(x: Optional[float], ndigits: int = 1) -> str:
    if x is None:
        return MISSING
    return f"{float(x):.{ndigits}f}"


# -----------------------------
# ETCS KPIs (RBC-side, clock-safe)
# -----------------------------
def compute_etcs_rtt_from_rbc(rbc: pd.DataFrame) -> Optional[float]:
    """
    Preferred:
      event == "ETCS_RTT_RX" with numeric 'rtt_ms'  (computed on RBC clock)
    Fallback:
      Pair ETCS_RX(nid_message=155) with ETCS_TX(nid_message=32) by 'sequence'
      using ONLY RBC-local timestamps:
        rtt_ms ~= t_send_ms(32) - t_rbc_recv_ms(155)

    NEVER uses t_app_ms because that is often OBU-origin for RX.
    """
    if rbc.empty or "event" not in rbc.columns:
        return None

    # 1) preferred: explicit RTT
    if "rtt_ms" in rbc.columns:
        rtt_rows = rbc[rbc["event"] == "ETCS_RTT_RX"]
        if not rtt_rows.empty:
            vals = plausible(rtt_rows["rtt_ms"])
            if not vals.empty:
                return float(vals.mean())

    # 2) fallback pairing on RBC timestamps only
    needed = {"event", "nid_message", "sequence", "t_rbc_recv_ms", "t_send_ms"}
    if not needed.issubset(set(rbc.columns)):
        return None

    rx = rbc[(rbc["event"] == "ETCS_RX") & (rbc["nid_message"] == 155)][
        ["sequence", "t_rbc_recv_ms"]
    ].copy()
    tx = rbc[(rbc["event"] == "ETCS_TX") & (rbc["nid_message"] == 32)][
        ["sequence", "t_send_ms"]
    ].copy()

    if rx.empty or tx.empty:
        return None

    rx["sequence"] = to_num(rx["sequence"])
    tx["sequence"] = to_num(tx["sequence"])
    rx["t_rbc_recv_ms"] = to_num(rx["t_rbc_recv_ms"])
    tx["t_send_ms"] = to_num(tx["t_send_ms"])

    pairs = rx.merge(tx, on="sequence", how="inner")
    if pairs.empty:
        return None

    rtt = (pairs["t_send_ms"] - pairs["t_rbc_recv_ms"]).dropna()
    rtt = plausible(rtt)
    return float(rtt.mean()) if not rtt.empty else None


# -----------------------------
# Video KPIs (Remote-side)
# -----------------------------
def compute_video_kpis(remote: pd.DataFrame) -> Tuple[Optional[float], Optional[float]]:
    """
    Jitter:
      std(inter_arrival_ms) from VIDEO_META_RX
    Loss:
      inferred from frame_id gaps (if present)
    """
    if remote.empty or "event" not in remote.columns:
        return None, None

    v = remote[remote["event"] == "VIDEO_META_RX"].copy()
    if v.empty:
        return None, None

    jitter = None
    if "inter_arrival_ms" in v.columns:
        _, jitter = mean_std(v["inter_arrival_ms"])  # std part
        if jitter is None:
            ia = plausible(v["inter_arrival_ms"])
            if len(ia) >= 2:
                jitter = float(ia.std(ddof=1))

    loss = None
    if "frame_id" in v.columns:
        seq = to_num(v["frame_id"]).dropna().astype(int)
        if len(seq) >= 2:
            seq_sorted = seq.sort_values()
            expected = int(seq_sorted.iloc[-1] - seq_sorted.iloc[0] + 1)
            received = int(len(seq_sorted.unique()))
            missing = max(0, expected - received)
            loss = float(missing) / float(expected) if expected > 0 else None

    return jitter, loss


# -----------------------------
# Video RTT / E2E (clock-safe)
# -----------------------------
def compute_video_rtt(
    remote: pd.DataFrame,
) -> Tuple[Optional[float], Optional[float], Optional[float], Optional[float]]:
    """
    RTT (clock-safe):
      Uses VIDEO_RTT events: rtt_ms
      E2E estimate from VIDEO_RTT: e2e_est_ms (RTT/2)

    Fallback E2E (best-effort):
      If VIDEO_RTT missing, use VIDEO_META_RX.e2e_ms (requires roughly aligned clocks)
    Returns:
      (rtt_mean, e2e_mean, rtt_p95, e2e_p95)
    """
    if remote.empty or "event" not in remote.columns:
        return None, None, None, None

    # --- RTT path (preferred) ---
    v_rtt = remote[remote["event"] == "VIDEO_RTT"].copy()
    rtt_mean = e2e_mean = rtt_p95_val = e2e_p95_val = None

    if not v_rtt.empty:
        if "rtt_ms" in v_rtt.columns:
            rtt_mean, _ = mean_std(v_rtt["rtt_ms"])
            rtt_p95_val = p95(v_rtt["rtt_ms"])

        # preferred e2e from RTT/2 if logged
        if "e2e_est_ms" in v_rtt.columns:
            e2e_mean, _ = mean_std(v_rtt["e2e_est_ms"])
            e2e_p95_val = p95(v_rtt["e2e_est_ms"])

        # if RTT exists but e2e_est_ms doesn't, compute it
        if e2e_mean is None and "rtt_ms" in v_rtt.columns:
            series = to_num(v_rtt["rtt_ms"]) / 2.0
            e2e_mean, _ = mean_std(series)
            e2e_p95_val = p95(series)

    # --- Fallback E2E from meta (only if RTT-based e2e missing) ---
    if e2e_mean is None:
        v_meta = remote[remote["event"] == "VIDEO_META_RX"].copy()
        if not v_meta.empty and "e2e_ms" in v_meta.columns:
            e2e_mean, _ = mean_std(v_meta["e2e_ms"])
            e2e_p95_val = p95(v_meta["e2e_ms"])

    return rtt_mean, e2e_mean, rtt_p95_val, e2e_p95_val

# -----------------------------
# AI alerts (Remote-side; clock-safe via AI_RTT series)
# -----------------------------
def compute_ai_remote_e2e(
    remote: pd.DataFrame,
) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """
    Clock-safe AI alert delivery metric without clock sync:
    Use AI_RTT computed on a single clock and estimate one-way as RTT/2.
    Returns:
      (mean, std, p95)
    """
    if remote.empty or "event" not in remote.columns:
        return None, None, None

    # NOTE: .get on DataFrame is ok; returns Series/None
    ack_from = remote.get("ack_from")
    if ack_from is None:
        return None, None, None

    df = remote[(remote["event"] == "AI_RTT") & (ack_from == "remote_obu")].copy()
    if df.empty:
        return None, None, None

    if "e2e_est_ms" in df.columns:
        series = to_num(df["e2e_est_ms"])
    elif "rtt_ms" in df.columns:
        series = to_num(df["rtt_ms"]) / 2.0
    else:
        return None, None, None

    m, sd = mean_std(series)
    return m, sd, p95(series)


def compute_ai_rtt_by_receiver(
    remote: pd.DataFrame, receiver_name: str
) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """
    Uses AI_RTT where ack_from == receiver_name, expects e2e_est_ms to exist.
    Returns:
      (mean, std_as_jitter, p95)
    """
    if remote.empty or "event" not in remote.columns:
        return None, None, None

    ack_from = remote.get("ack_from")
    if ack_from is None:
        return None, None, None

    df = remote[(remote["event"] == "AI_RTT") & (ack_from == receiver_name)].copy()
    if df.empty or "e2e_est_ms" not in df.columns:
        return None, None, None

    e2e_mean, e2e_jitter = mean_std(df["e2e_est_ms"])
    return e2e_mean, e2e_jitter, p95(df["e2e_est_ms"])


# -----------------------------
# Remote ACK & processing (use direct fields you already log)
# -----------------------------
def compute_remote_ack_and_processing(
    remote: pd.DataFrame,
) -> Tuple[Optional[float], Optional[float], Optional[float], Optional[float]]:
    """
    Returns:
      (ack_delay_mean, ack_delay_p95, proc_mean, proc_p95)
    """
    if remote.empty or "event" not in remote.columns:
        return None, None, None, None

    ack_delay_mean = ack_delay_p95_val = None
    proc_mean = proc_p95_val = None

    rx = remote[remote["event"] == "AI_ACK_RX"].copy()
    tx = remote[remote["event"] == "AI_ACK_TX"].copy()

    if not rx.empty and "remote_ack_rx_delay_ms" in rx.columns:
        ack_delay_mean, _ = mean_std(rx["remote_ack_rx_delay_ms"])
        ack_delay_p95_val = p95(rx["remote_ack_rx_delay_ms"])

    if not tx.empty and "remote_ack_processing_ms" in tx.columns:
        proc_mean, _ = mean_std(tx["remote_ack_processing_ms"])
        proc_p95_val = p95(tx["remote_ack_processing_ms"])

    return ack_delay_mean, ack_delay_p95_val, proc_mean, proc_p95_val


# -----------------------------
# Sensor / Stop row (best-effort, receiver-side only)
# -----------------------------
def compute_sensor_stop_e2e(
    remote: pd.DataFrame,
) -> Tuple[Optional[float], Optional[float]]:
    """
    Use Remote-side command ACK RTT as a proxy for Start/Stop (Remote -> OBU via ESP32).
    Clock-safe because it's computed on Remote clock:
      e2e_ms = t_ack_recv_ms - t_cmd_send_ms
    Returns:
      (mean, p95)
    """
    if remote.empty or "event" not in remote.columns:
        return None, None

    df = remote[remote["event"] == "TRAIN_CMD_ACK_RX"].copy()
    if df.empty:
        return None, None

    if "cmd" in df.columns:
        df = df[df["cmd"].isin(["START", "STOP"])]

    if "e2e_ms" not in df.columns:
        return None, None

    vals = pd.to_numeric(df["e2e_ms"], errors="coerce").dropna()
    vals = vals[(vals >= 0) & (vals <= 60_000)]
    if vals.empty:
        return None, None

    return float(vals.mean()), float(vals.quantile(0.95))


# -----------------------------
# Build the exact table you want
# -----------------------------
def build_table(rbc: pd.DataFrame, remote: pd.DataFrame) -> pd.DataFrame:
    etcs_rtt = compute_etcs_rtt_from_rbc(rbc)
    etcs_e2e = (etcs_rtt / 2.0) if etcs_rtt is not None else None

    video_jitter, video_loss = compute_video_kpis(remote)
    video_rtt, video_e2e, video_rtt_p95, video_e2e_p95 = compute_video_rtt(remote)

    ai_remote_e2e, ai_remote_jitter, ai_remote_e2e_p95 = compute_ai_remote_e2e(remote)
    ai_rbc_e2e, ai_rbc_jitter, ai_rbc_e2e_p95 = compute_ai_rtt_by_receiver(remote, "RBC")

    ack_delay_mean, ack_delay_p95, remote_proc_mean, remote_proc_p95 = compute_remote_ack_and_processing(remote)

    sensor_stop_mean, sensor_stop_p95 = compute_sensor_stop_e2e(remote)

    # Note: We do NOT currently have per-sample ETCS RTT series in this function.
    # So ETCS p95 is left as "—" to avoid misleading values.
    rows = [
        {
            "Type": "RBC → OBU (ETCS msgs)",
            "E2E latency (ms)": fmt(etcs_e2e, 1),
            "E2E p95 (ms)": MISSING,
            "RTT (ms)": fmt(etcs_rtt, 0),
        },
        {
            "Type": "OBU → RBC (ETCS msgs)",
            "E2E latency (ms)": fmt(etcs_e2e, 1),
            "E2E p95 (ms)": MISSING,
            "RTT (ms)": fmt(etcs_rtt, 0),
        },
        {
            "Type": "OBU → RBC (AI alerts)",
            "E2E latency (ms)": fmt(ai_rbc_e2e, 1),
            "E2E p95 (ms)": fmt(ai_rbc_e2e_p95, 1),
            "RTT (ms)": MISSING,
        },
        {
            "Type": "OBU → Remote OBU (video)",
            "E2E latency (ms)": fmt(video_e2e, 1),
            "E2E p95 (ms)": fmt(video_e2e_p95, 1),
            "RTT (ms)": fmt(video_rtt, 0),
        },
        {
            "Type": "OBU → Remote OBU (AI alerts)",
            "E2E latency (ms)": fmt(ai_remote_e2e, 1),
            "E2E p95 (ms)": fmt(ai_remote_e2e_p95, 1),
            "RTT (ms)": MISSING,
        },
        {
            "Type": "Remote OBU ACK (AI alerts)",
            "E2E latency (ms)": fmt(ack_delay_mean, 1),
            "E2E p95 (ms)": fmt(ack_delay_p95, 1),
            "RTT (ms)": MISSING,
        },
        {
            "Type": "Remote → OBU/RPi via ESP32 (Sensor/Stop)",
            "E2E latency (ms)": fmt(sensor_stop_mean, 1),
            "E2E p95 (ms)": fmt(sensor_stop_p95, 1),
            "RTT (ms)": MISSING,
        },
    ]

    # Optional: include video jitter/loss as extra columns WITHOUT affecting old ones
    # If you don't want them, you can delete these 2 lines.
    df = pd.DataFrame(rows)
    df["Video jitter (ms)"] = MISSING
    df["Video loss (ratio)"] = MISSING
    # Only fill in the video row so you keep stable table shape
    vid_idx = df.index[df["Type"] == "OBU → Remote OBU (video)"]
    if len(vid_idx) == 1:
        i = int(vid_idx[0])
        df.loc[i, "Video jitter (ms)"] = fmt(video_jitter, 1)
        df.loc[i, "Video loss (ratio)"] = fmt(video_loss, 3) if video_loss is not None else MISSING

    return df


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rbc", required=True, help="Path to RBC JSONL log")
    ap.add_argument("--remote", required=True, help="Path to Remote-OBU JSONL log")
    ap.add_argument("--out", default=None, help="Output CSV path (alias: --csv)")
    ap.add_argument("--csv", default=None, help="Output CSV path (alias: --out)")
    args = ap.parse_args()

    out_path = args.out or args.csv or "kpi_table.csv"

    rbc = read_jsonl(args.rbc)
    remote = read_jsonl(args.remote)

    table = build_table(rbc, remote)
    table.to_csv(out_path, index=False)

    print(table.to_string(index=False))
    print(f"\nSaved: {out_path}")


if __name__ == "__main__":
    main()
