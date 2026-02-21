Raspberry Pi Setup – Master Thesis Train Project



**Wi-Fi Configuration (Static IP)**



Configured Raspberry Pi to always connect to:



SSID: TRAIN-NET

Static IP: 192.168.4.20



Using NetworkManager:



nmcli con mod "TRAIN-NET" connection.autoconnect yes

nmcli con mod "TRAIN-NET" connection.autoconnect-priority 100



nmcli con mod "TRAIN-NET" ipv4.addresses 192.168.4.20/24

nmcli con mod "TRAIN-NET" ipv4.method manual

nmcli con mod "TRAIN-NET" ipv4.gateway 192.168.4.1

nmcli con mod "TRAIN-NET" ipv4.dns 192.168.4.1

nmcli con mod "TRAIN-NET" ipv6.method disabled



nmcli con down "TRAIN-NET"

nmcli con up "TRAIN-NET"



**Required Installations on Raspberry Pi**



Python Dependencies

sudo apt update

sudo apt install python3-paho-mqtt -y

Node.js Installation

sudo apt update

sudo apt install nodejs npm -y



Verify:



node -v

npm -v



Install Node Dependencies (inside project folder)

npm install



If missing packages:



npm install crypto-js

npm install mqtt

npm install amqplib

npm install bit-buffer



**Auto-start OBU Launcher at Boot**



Created systemd service:



sudo nano /etc/systemd/system/obu-launcher.service



Content:



\[Unit]

Description=OBU MQTT Launcher (TRAIN01)

After=network-online.target

Wants=network-online.target



\[Service]

User=daminiraspi

WorkingDirectory=/home/daminiraspi/Thesis\_train\_obu

ExecStart=/usr/bin/python3 /home/daminiraspi/Thesis\_train\_obu/obu\_launcher.py

Restart=always

RestartSec=5

Environment=PYTHONUNBUFFERED=1



\[Install]

WantedBy=multi-user.target



Then:



sudo systemctl daemon-reload

sudo systemctl enable obu-launcher.service

sudo systemctl start obu-launcher.service



Check status:



sudo systemctl status obu-launcher.service --no-pager



**Running KPI Table Calculation**



python kpiTable.py --rbc RUN\_2026-02-21T11-20-23-378Z\_\_RBC\_DE0001.jsonl --remote kpi\_REMOTE\_OBU\_2026-02-21T11-21-46-841Z.jsonl --csv kpi\_table.csv



**PCAP Port KPI Extraction**



For wireshark (non gui version) open windows power shell:

1\)	$ts = Get-Date -Format "ddMMyy\_HHmm"

2\)	\& "C:\\Program Files\\Wireshark\\dumpcap.exe" -i 4 `

>> -f "tcp port 1883 or tcp port 1886 or tcp port 1887 or tcp port 9001 or tcp port 9002 or tcp port 9003" `

>> -w "C:\\Users\\malpo\\Desktop\\obu-rbc\_project\_zip\\obu-rbc\_project\\wireshark\_result\\bandwidthCongestion\_1200kbit\_64kbitburst\_1500msLatency\_$ts.pcapng"



python pcap\_port\_kpis.py --pcap baseline\_run1702260010.pcapng --a 192.168.4.20 --b 192.168.4.4 --ports 1883,1886,1887 --tshark "C:\\Program Files\\Wireshark\\tshark.exe”  for wireshark (packet loss, throuput) calculation, plot and csv

