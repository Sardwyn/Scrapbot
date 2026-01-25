// /var/www/scrapbot/src/lib/kickPublic.js
import axios from "axios";

/**
 * Fetch channel by slug using Kick's public API.
 * Example: https://kick.com/api/v2/channels/<slug>
 * Returns minimal { id, username } for DB.
 */
export async function fetchChannelBySlug(slug) {
  if (!slug) return null;
  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`;
  const { data } = await axios.get(url, {
    timeout: 10000,
    headers: { "User-Agent": "Scrapbot/1.0 (+scraplet.store)" },
  });

  // Typical shapes seen:
  // - data.user_id (numeric) + data.username (string)
  // - some dumps have data.id instead of user_id
  const id = String(data.user_id ?? data.id ?? "").trim();
  const username = String(data.username ?? data.slug ?? "").trim();

  if (!id || !username) {
    throw new Error(`kickPublic bad shape for ${slug}: ` + JSON.stringify({
      have_user_id: !!data.user_id, have_id: !!data.id, have_username: !!data.username, have_slug: !!data.slug
    }));
  }
  return { id, username };
}
