import "dotenv/config";
import crypto from "crypto";
import axios from "axios";
import qs from "qs";

/** PKCE helpers */
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+/g, "");

export const newVerifier = () => b64url(crypto.randomBytes(32));
const challenge = (verifier) => b64url(crypto.createHash("sha256").update(verifier).digest());

/** Build the Kick authorize URL */
export function startAuthUrl({ state, verifier, slug }) {
  const authorize = process.env.KICK_AUTH_URL || "https://id.kick.com/oauth/authorize";
  const params = new URLSearchParams({
    client_id: process.env.KICK_CLIENT_ID || "",
    response_type: "code",
    redirect_uri: process.env.KICK_REDIRECT_URI || "",
    scope: (process.env.KICK_OAUTH_SCOPE || "chat:read chat:write events:subscribe").trim(),
    state
  });
  params.set("code_challenge", challenge(verifier));
  params.set("code_challenge_method", "S256");
  if (slug) params.set("slug", slug);
  return `${authorize}?${params.toString()}`;
}

/** Exchange auth code for tokens (include client_secret — Kick requires it) */
export async function exchangeCodeForToken({ code, verifier }) {
  const url = process.env.KICK_TOKEN_URL || "https://id.kick.com/oauth/token";
  const body = qs.stringify({
    grant_type: "authorization_code",
    client_id: process.env.KICK_CLIENT_ID || "",
    client_secret: process.env.KICK_CLIENT_SECRET || "",
    redirect_uri: process.env.KICK_REDIRECT_URI || "",
    code_verifier: verifier,
    code
  });

  const { data } = await axios.post(url, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10000,
    // Cloudflare sometimes 400s without UA; being explicit helps
    validateStatus: (s) => s >= 200 && s < 300
  }).catch((e) => {
    // rethrow with the minimal context we need
    const status = e?.response?.status;
    const note = status === 400 ? "Bad Request (check client_secret, redirect_uri, or code_verifier)" : `HTTP ${status}`;
    throw new Error(`token exchange failed: ${note}`);
  });

  return data; // { access_token, refresh_token?, expires_in, token_type, scope?, owner_id? ... }
}

/** Userinfo (OIDC). If 404, return a minimal record so we can still bind the account. */
export async function getUserInfo(accessToken) {
  const url = process.env.KICK_OIDC_USERINFO_URL || "https://id.kick.com/oauth/userinfo";
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000,
      validateStatus: (s) => s >= 200 && s < 300
    });
    return {
      id: String(data.sub ?? data.user_id ?? data.id ?? "").trim(),
      username: String(data.preferred_username ?? data.username ?? data.name ?? "").trim()
    };
  } catch (e) {
    if (e?.response?.status === 404) {
      // Kick’s OIDC sometimes doesn’t expose userinfo; let caller fall back to slug/public API.
      return { id: "", username: "" };
    }
    throw e;
  }
}
