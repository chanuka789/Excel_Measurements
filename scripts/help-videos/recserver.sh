#!/bin/bash
cd /home/claude/excel_measurements
H=$(node scripts/hash-password.js "Demo-pass-123" | sed -n 3p)
export LOGIN_LIMIT_PER_IP=1000 RATE_LIMIT_PER_MIN=100000 DATABASE_URL=postgres://postgres@localhost:5433/dwfx_rec2 LOCAL_STORAGE_DIR=/home/claude/.dwfx-rec2-storage PORT=3077 AI_BASE_URL=http://localhost:3099/deepseek AI_API_KEY=t AI_MODEL=deepseek-chat
export APP_USERS="qs.demo@example.com | QS User | admin | $H"
nohup node server.js > /home/claude/.rec2.log 2>&1 &
sleep 4; cat /home/claude/.rec2.log
