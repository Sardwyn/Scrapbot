// /var/www/scrapbot/src/lib/kickAuth.js
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import axios from 'axios';
import qs from 'qs';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

function need(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env: ${name}`);
  return String(v).trim();
}
const KICK_CLIENT_ID     = need('KICK_CLIENT_ID');
const KICK_CLIENT_SECRET = need('KICK_CLIENT_SECRET');
const PUBLIC_BASE_URL    = need('PUBLIC_BASE_URL');

const KICK_AUTH_URL    = (process.env.KICK_AUTH_URL || 'https://id.kick.com/oauth/authorize').trim();
const KICK_TOKEN_URL   = (process.env.KICK_TOKEN_URL || 'https://id.kick.com/oauth/token').trim();
const KICK_OAUTH_SCOPE = (process.env.KICK_OAUTH_SCOPE || 'chat:read chat:write events:subscribe').trim();

const b64url = b => b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
export const newVerifier = () => b64url(crypto.randomBytes(32));
export const challenge = v => b64url(crypto.createHash('sha256').update(v).digest());

// 🧷 Tolerant signature + friendly error
export function startAuthUrl(input = {}) {
  const { state, verifier, slug } = input;
  if (!state || !verifier) throw new Error('startAuthUrl requires { state, verifier }');

  const redirect_uri = `${PUBLIC_BASE_URL}/auth/kick/callback`;
  const url = new URL(KICK_AUTH_URL);
  url.searchParams.set('client_id', KICK_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirect_uri);
  url.searchParams.set('scope', KICK_OAUTH_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (slug) url.searchParams.set('slug', slug);
  return url.toString();
}

export async function exchangeCodeForToken({ code, verifier }) {
  const redirect_uri = `${PUBLIC_BASE_URL}/auth/kick/callback`;
  const payload = {
    grant_type: 'authorization_code',
    client_id: KICK_CLIENT_ID,
    client_secret: KICK_CLIENT_SECRET,
    code,
    redirect_uri,
    code_verifier: verifier
  };
  const { data } = await axios.post(KICK_TOKEN_URL, qs.stringify(payload), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });
  if (!data || !data.access_token) throw new Error('Token exchange returned no access_token');
  return data;
}
