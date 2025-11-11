// /var/www/scrapbot/src/server.js
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';

import health from './routes/health.js';
import auth from './routes/auth.js';
import channels from './routes/channels.js';
import debugRoutes from './routes/debug.js';   // has /__ping and /_dbinfo
import { connectAllKnownChannels } from './lib/wsSupervisor.js';

const app = express();

app.get('/__envcheck', (req, res) => {
  res.json({
    KICK_CLIENT_ID: !!process.env.KICK_CLIENT_ID,
    KICK_CLIENT_SECRET: !!process.env.KICK_CLIENT_SECRET,
    PUBLIC_BASE_URL: !!process.env.PUBLIC_BASE_URL,
    KICK_AUTH_URL: process.env.KICK_AUTH_URL,
    KICK_TOKEN_URL: process.env.KICK_TOKEN_URL,
    scope: process.env.KICK_OAUTH_SCOPE
  });
});


// Core middleware
app.use(express.json());

// Routes (order matters: mount routes before any 404s you might add later)
app.use(health);
app.use(auth);
app.use(channels);
app.use(debugRoutes); // ✅ /__ping and /_dbinfo live here now

// Kick off background connections (don’t block startup)
connectAllKnownChannels().catch((e) =>
  console.error('[wsSupervisor] boot error', e?.message || e)
);

const port = process.env.PORT || 3030;
app.listen(port, () => console.log('Scrapbot v2 listening', { port }));
