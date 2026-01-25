#!/usr/bin/env bash
set -euo pipefail
cd /var/www/scrapbot
set -a; . ./.env; set +a
exec node src/index.js
