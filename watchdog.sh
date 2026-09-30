#!/bin/bash
cd ~/nftmintsoft
for i in $(seq 1 2000); do
  if grep -qE "MINTED|confirmed=[1-9]|SOLD OUT" state/live.log 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] decisive outcome reached, watchdog exiting" >> state/watchdog.log
    exit 0
  fi
  PID=$(cat state/mint.pid 2>/dev/null)
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] mint process gone - restarting" >> state/watchdog.log
    nohup node index.js --now --debug >> state/live.log 2>&1 &
    echo $! > state/mint.pid
  fi
  sleep 20
done
