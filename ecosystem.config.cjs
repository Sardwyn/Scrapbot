module.exports = {
  apps: [
    {
      name: 'scrapbot',
      script: 'src/server.js',
      env: {
        NODE_ENV: 'production',
        KICK_CLIENT_ID: '01K9JHZRWZ7E6G6JY5ZWPKZHNS',
        KICK_CLIENT_SECRET: 'ecc975ef26e784ddb6e936acf252596396705c112eec12969b66dd0a3150cbe4',
        KICK_AUTH_URL: 'https://id.kick.com/oauth/authorize',
        KICK_TOKEN_URL: 'https://id.kick.com/oauth/token',
        KICK_OAUTH_SCOPE: 'chat:read chat:write events:subscribe',
        PUBLIC_BASE_URL: 'https://scraplet.store',
        DATABASE_URL: 'postgres://scrapapp:Outrun1279@127.0.0.1:5432/scrapbot'
      }
    }
  ]
};
