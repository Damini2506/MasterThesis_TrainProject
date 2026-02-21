import argparse
import subprocess
import sys
from pathlib import Path

import pandas as pd
import matplotlib.pyplot as plt


def run_tshark(tshark_path: str, args: list[str]) -> str:
    cmd = [tshark_path] + args
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        return out
    except subprocess.CalledProcessError as e:
        print("❌ tshark failed.\nCommand:", " ".join(cmd), "\n\nOutput:\n", e.output, file=sys.stderr)
        raise


def extract_packets_df(tshark_path: str, pcap: Path, display_filter: str) -> pd.DataFrame:
    """
    Extract minimal fields for per-packet time series + totals.
    We use:
      - frame.time_epoch (float seconds)
      - frame.len (bytes on wire)
      - tcp.len (TCP payload bytes; may be missing for pure ACKs)
    """
    out = run_tshark(
        tshark_path,
        [
            "-r", str(pcap),
            "-Y", display_filter,
            "-T", "fields",
            "-E", "header=y",
            "-E", "separator=,",
            "-E", "quote=d",
            "-e", "frame.time_epoch",
            "-e", "frame.len",
            "-e", "tcp.len",
        ],
    )
    # tshark outputs CSV-like lines; pandas can read from a string via io.StringIO
    from io import StringIO
    df = pd.read_csv(StringIO(out))

    # Clean & type
    df["frame.time_epoch"] = pd.to_numeric(df["frame.time_epoch"], errors="coerce")
    df["frame.len"] = pd.to_numeric(df["frame.len"], errors="coerce").fillna(0).astype(int)
    # tcp.len can be blank
    if "tcp.len" in df.columns:
        df["tcp.len"] = pd.to_numeric(df["tcp.len"], errors="coerce").fillna(0).astype(int)
    else:
        df["tcp.len"] = 0

    df = df.dropna(subset=["frame.time_epoch"]).reset_index(drop=True)
    return df


def compute_port_metrics(tshark_path: str, pcap: Path, a_ip: str, b_ip: str, port: int) -> dict:
    """
    Matches your Wireshark filter logic:
      tcp.port == PORT && ip.addr == A && ip.addr == B
    Retransmissions filter:
      tcp.analysis.retransmission && same flow filter
    """
    base_filter = f"tcp.port == {port} && ip.addr == {a_ip} && ip.addr == {b_ip}"
    rexmit_filter = f"tcp.analysis.retransmission && {base_filter}"

    df_all = extract_packets_df(tshark_path, pcap, base_filter)
    df_rex = extract_packets_df(tshark_path, pcap, rexmit_filter)

    total_pkts = int(len(df_all))
    rexmit_pkts = int(len(df_rex))

    if total_pkts > 0:
        t0 = float(df_all["frame.time_epoch"].min())
        t1 = float(df_all["frame.time_epoch"].max())
        duration_s = max(1e-9, t1 - t0)
    else:
        t0 = t1 = 0.0
        duration_s = 0.0

    total_bytes_wire = int(df_all["frame.len"].sum())          # bytes on wire (includes headers)
    total_bytes_payload = int(df_all["tcp.len"].sum())         # TCP payload bytes

    avg_thr_mbps_wire = (total_bytes_wire * 8.0 / duration_s / 1e6) if duration_s > 0 else 0.0
    avg_thr_mbps_payload = (total_bytes_payload * 8.0 / duration_s / 1e6) if duration_s > 0 else 0.0

    loss_proxy_pct = (rexmit_pkts / total_pkts * 100.0) if total_pkts > 0 else 0.0

    return {
        "port": port,
        "ip_a": a_ip,
        "ip_b": b_ip,
        "total_packets": total_pkts,
        "retransmissions": rexmit_pkts,      # proxy for "lost/resent"
        "loss_proxy_%": loss_proxy_pct,
        "duration_s": duration_s,
        "bytes_wire": total_bytes_wire,
        "bytes_tcp_payload": total_bytes_payload,
        "avg_throughput_mbps_wire": avg_thr_mbps_wire,
        "avg_throughput_mbps_payload": avg_thr_mbps_payload,
    }


def plot_double_bar(df: pd.DataFrame, out_png: Path):
    ports = df["port"].astype(str).tolist()
    total = df["total_packets"].tolist()
    lost = df["retransmissions"].tolist()

    x = range(len(ports))
    width = 0.38

    plt.figure(figsize=(9, 5))
    plt.bar([i - width/2 for i in x], total, width=width, label="Total packets")
    plt.bar([i + width/2 for i in x], lost,  width=width, label="Retransmissions (loss proxy)")

    plt.xticks(list(x), ports)
    plt.xlabel("TCP port")
    plt.ylabel("Packet count")
    plt.title("Packets vs Retransmissions per Port (between the two IPs)")
    plt.legend()
    plt.tight_layout()
    plt.savefig(out_png, dpi=200)
    plt.close()


def main():
    import tkinter as tk
    from tkinter import filedialog

    ap = argparse.ArgumentParser()
    ap.add_argument("--pcap", help="PCAP file name (if not provided, file dialog will open)")
    ap.add_argument("--a", required=True, help="IP address A (e.g., 192.168.4.20)")
    ap.add_argument("--b", required=True, help="IP address B (e.g., 192.168.4.4)")
    ap.add_argument("--ports", default="1883,1886,1887")
    ap.add_argument("--tshark", default="tshark")
    ap.add_argument("--outdir", default="out_kpis")
    args = ap.parse_args()

    # If filename not given → open file dialog
    if not args.pcap:
        root = tk.Tk()
        root.withdraw()
        file_path = filedialog.askopenfilename(
            title="Select PCAPNG file",
            filetypes=[("PCAPNG files", "*.pcapng"), ("All files", "*.*")]
        )
        if not file_path:
            print("No file selected.")
            return
        pcap = Path(file_path)
    else:
        pcap = Path(args.pcap)

    if not pcap.exists():
        raise FileNotFoundError(pcap)

    ports = [int(p.strip()) for p in args.ports.split(",") if p.strip()]
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    rows = []
    for port in ports:
        rows.append(compute_port_metrics(args.tshark, pcap, args.a, args.b, port))

    df = pd.DataFrame(rows).sort_values("port").reset_index(drop=True)

    csv_path = outdir / f"{pcap.stem}_port_kpis.csv"
    df.to_csv(csv_path, index=False)

    png_path = outdir / f"{pcap.stem}_packets_vs_retransmissions.png"
    plot_double_bar(df, png_path)

    print("\nResults:")
    print(df)
    print("\nSaved:")
    print(csv_path)
    print(png_path)


if __name__ == "__main__":
    main()
