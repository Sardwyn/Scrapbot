module.exports = {
  apps: [{
    name: 'scrapbot',
    script: '/var/www/scrapbot/start.sh',
    env: {
      NODE_ENV: 'production',

      // Scrapbot DB (scrapbot_clean)
      DATABASE_URL: 'postgres://scrapapp:Outrun1279@127.0.0.1:5432/scrapbot_clean',

      // Sync secret for dashboard -> scrapbot hot-reload endpoint
      SCRAPBOT_SYNC_SECRET: 'Outrun1279'
    }
  }]
}
