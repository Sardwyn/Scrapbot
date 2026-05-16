// src/workers/clipManager.js
import db from '../lib/db.js';

/**
 * Clip Manager - handles !clip commands for Kick and Twitch
 */

/**
 * Create a clip for the current stream
 */
export async function createClip(platform, channelId, userId, username) {
  try {
    let clipUrl = null;
    let clipId = null;
    let error = null;

    if (platform === 'kick') {
      // Kick clip creation via API
      const result = await createKickClip(channelId);
      if (result.success) {
        clipUrl = result.clipUrl;
        clipId = result.clipId;
      } else {
        error = result.error;
      }
    } else if (platform === 'twitch') {
      // Twitch clip creation via API
      const result = await createTwitchClip(channelId);
      if (result.success) {
        clipUrl = result.clipUrl;
        clipId = result.clipId;
      } else {
        error = result.error;
      }
    } else {
      error = 'Clips not supported on this platform';
    }

    // Store clip in database
    if (clipUrl) {
      await db.query(`
        INSERT INTO scrapbot_clips (platform, channel_id, user_id, username, clip_id, clip_url, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [platform, channelId, userId, username, clipId, clipUrl]);

      return {
        success: true,
        clipUrl,
        message: `@${username} Clip created: ${clipUrl}`
      };
    } else {
      return {
        success: false,
        error: error || 'Failed to create clip',
        message: `@${username} ${error || 'Failed to create clip'}`
      };
    }
  } catch (err) {
    console.error('[ClipManager] Error creating clip:', err);
    return {
      success: false,
      error: 'Internal error',
      message: `@${username} Failed to create clip (internal error)`
    };
  }
}

/**
 * Create Kick clip
 */
async function createKickClip(channelId) {
  try {
    // Note: Kick's clip API requires authentication and may not be publicly available
    // This is a placeholder implementation
    console.log('[ClipManager] Kick clip creation not yet implemented');
    return {
      success: false,
      error: 'Kick clips not yet supported'
    };
  } catch (error) {
    console.error('[ClipManager] Kick clip error:', error);
    return {
      success: false,
      error: 'Failed to create Kick clip'
    };
  }
}

/**
 * Create Twitch clip
 */
async function createTwitchClip(channelId) {
  try {
    // Get Twitch access token from environment or database
    const twitchClientId = process.env.TWITCH_CLIENT_ID;
    const twitchAccessToken = process.env.TWITCH_ACCESS_TOKEN;

    if (!twitchClientId || !twitchAccessToken) {
      return {
        success: false,
        error: 'Twitch API credentials not configured'
      };
    }

    // Get broadcaster ID from channel name
    const userResponse = await fetch(`https://api.twitch.tv/helix/users?login=${channelId}`, {
      headers: {
        'Client-ID': twitchClientId,
        'Authorization': `Bearer ${twitchAccessToken}`
      }
    });

    if (!userResponse.ok) {
      return {
        success: false,
        error: 'Failed to get Twitch user info'
      };
    }

    const userData = await userResponse.json();
    if (!userData.data || userData.data.length === 0) {
      return {
        success: false,
        error: 'Twitch user not found'
      };
    }

    const broadcasterId = userData.data[0].id;

    // Create clip
    const clipResponse = await fetch('https://api.twitch.tv/helix/clips', {
      method: 'POST',
      headers: {
        'Client-ID': twitchClientId,
        'Authorization': `Bearer ${twitchAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        has_delay: false
      })
    });

    if (!clipResponse.ok) {
      const errorData = await clipResponse.text();
      console.error('[ClipManager] Twitch clip API error:', errorData);
      return {
        success: false,
        error: 'Failed to create Twitch clip'
      };
    }

    const clipData = await clipResponse.json();
    if (!clipData.data || clipData.data.length === 0) {
      return {
        success: false,
        error: 'No clip data returned'
      };
    }

    const clip = clipData.data[0];
    const clipUrl = `https://clips.twitch.tv/${clip.id}`;

    return {
      success: true,
      clipId: clip.id,
      clipUrl: clipUrl
    };
  } catch (error) {
    console.error('[ClipManager] Twitch clip error:', error);
    return {
      success: false,
      error: 'Failed to create Twitch clip'
    };
  }
}

/**
 * Get recent clips for a channel
 */
export async function getRecentClips(channelId, limit = 5) {
  try {
    const { rows } = await db.query(`
      SELECT clip_id, clip_url, username, created_at
      FROM scrapbot_clips
      WHERE channel_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [channelId, limit]);

    return rows;
  } catch (error) {
    console.error('[ClipManager] Error getting recent clips:', error);
    return [];
  }
}

/**
 * Handle clip command
 */
export async function handleClipCommand(platform, channelId, userId, username) {
  const result = await createClip(platform, channelId, userId, username);
  return {
    type: 'chat',
    text: result.message
  };
}