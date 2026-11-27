#!/bin/bash
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund
(sleep 2; open http://localhost:8080) &
node server.mjs
