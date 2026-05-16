// src/workers/mediaQueueManager.js
import db from '../lib/db.js';
import crypto from 'crypto';

/**
 * Media Queue Manager - handles song/video requests via chat commands
 * Commands: !sr <url> [title], !queue, !skip, !clear
 */

// In-memory queue per channel
const queues = new Map(); // channelId -> { items: [], current: null, position: 0 }

/**
 * Initialize media queue for a channel
 */
function initQueue(channelId) {
  if (!queues.has(channelId)) {
    queues.set(channelId, {
      items: [],
      current: null,
      position: 0,
      isPlaying: false
    });
  }
  return queues.get(channelId);
}

/**
 * Add media request to queue
 */
export async function addMediaRequest(channelId, userId, username, url, title = null) {
  try {
    // Validate URL (basic check for YouTube, Spotify, SoundCloud, etc.)
    const urlPattern = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|spotify\.com|soundcloud\.com|twitch\.tv)/i;
    if (!urlPattern.test(url)) {
      return { success: false, error: 'Invalid URL. Supported: YouTube, Spotify, SoundCloud, Twitch' };
    }

    // Extract title from URL if not provided
    if (!title) {
      if (url.includes('youtube.com') || url.includes('youtu.be')) {
        title = 'YouTube Video';
      } else if (url.includes('spotify.com')) {
        title = 'Spotify Track';
      } else if (url.includes('soundcloud.com')) {
        title = 'SoundCloud Track';
      } else {
        title = 'Media Request';
      }
    }

    // Store in database
    const { rows } = await db.query(`
      INSERT INTO scrapbot_media_queue (channel_id, user_id, username, url, title, status)
      VALUES ($1, $2, $3, $4, $5, 'queued')
      RETURNING id, created_at
    `, [channelId, userId, username, url, title]);

    const request = {
      id: rows[0].id,
      channelId,
      userId,
      username,
      url,
      title,
      createdAt: rows[0].created_at
    };

    // Add to in-memory queue
    const queue = initQueue(channelId);
    queue.items.push(request);

    // Publish queue update to overlay
    await publishQueueUpdate(channelId);

    return { success: true, request, position: queue.items.length };
  } catch (error) {
    console.error('[MediaQueue] Error adding request:', error);
    return { success: false, error: 'Failed to add request' };
  }
}

/**
 * Get current queue for channel
 */
export function getQueue(channelId) {
  const queue = initQueue(channelId);
  return {
    current: queue.current,
    items: queue.items,
    position: queue.position,
    isPlaying: queue.isPlaying
  };
}

/**
 * Skip current media
 */
export async function skipCurrent(channelId) {
  const queue = initQueue(channelId);
  
  if (queue.current) {
    // Mark as skipped in DB
    await db.query(`
      UPDATE scrapbot_media_queue 
      SET status = 'skipped', updated_at = NOW()
      WHERE id = $1
    `, [queue.current.id]);
  }

  // Move to next
  if (queue.items.length > 0) {
    queue.current = queue.items.shift();
    queue.position++;
    queue.isPlaying = true;

    // Mark as playing in DB
    if (queue.current) {
      await db.query(`
        UPDATE scrapbot_media_queue 
        SET status = 'playing', updated_at = NOW()
        WHERE id = $1
      `, [queue.current.id]);
    }
  } else {
    queue.current = null;
    queue.isPlaying = false;
  }

  await publishQueueUpdate(channelId);
  return queue.current;
}

/**
 * Clear entire queue
 */
export async function clearQueue(channelId) {
  const queue = initQueue(channelId);
  
  // Mark all as cleared in DB
  await db.query(`
    UPDATE scrapbot_media_queue 
    SET status = 'cleared', updated_at = NOW()
    WHERE channel_id = $1 AND status IN ('queued', 'playing')
  `, [channelId]);

  // Clear in-memory queue
  queue.items = [];
  queue.current = null;
  queue.isPlaying = false;

  await publishQueueUpdate(channelId);
  return { success: true };
}

/**
 * Publish queue update to overlay via SSE
 */
async function publishQueueUpdate(channelId) {
  try {
    const queue = getQueue(channelId);
    
    // Send webhook to dashboard for overlay updates
    const webhookUrl = process.env.SCRAPLET_WEBHOOK_URL;
    if (webhookUrl) {
      const payload = {
        type: 'media.queue.update',
        channelId,
        data: {
          current: queue.current,
          queue: queue.items.slice(0, 10), // Show next 10
          totalCount: queue.items.length,
          isPlaying: queue.isPlaying
        }
      };

      await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Scraplet-Secret': process.env.SCRAPLET_SHARED_SECRET
        },
        body: JSON.stringify(payload)
      });
    }
  } catch (error) {
    console.error('[MediaQueue] Error publishing update:', error);
  }
}

/**
 * Load existing queue from database on startup
 */
export async function loadQueueFromDB(channelId) {
  try {
    const { rows } = await db.query(`
      SELECT id, channel_id, user_id, username, url, title, created_at, status
      FROM scrapbot_media_queue
      WHERE channel_id = $1 AND status IN ('queued', 'playing')
      ORDER BY created_at ASC
    `, [channelId]);

    const queue = initQueue(channelId);
    queue.items = rows.filter(r => r.status === 'queued').map(r => ({
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      username: r.username,
      url: r.url,
      title: r.title,
      createdAt: r.created_at
    }));

    const current = rows.find(r => r.status === 'playing');
    if (current) {
      queue.current = {
        id: current.id,
        channelId: current.channel_id,
        userId: current.user_id,
        username: current.username,
        url: current.url,
        title: current.title,
        createdAt: current.created_at
      };
      queue.isPlaying = true;
    }

    console.log(`[MediaQueue] Loaded queue for ${channelId}: ${queue.items.length} queued, current: ${queue.current?.title || 'none'}`);
  } catch (error) {
    console.error('[MediaQueue] Error loading queue:', error);
  }
}

/**
 * Handle media queue commands
 */
export async function handleMediaCommand(command, channelId, userId, username, args) {
  switch (command) {
    case 'sr':
    case 'songrequest':
      if (!args[0]) {
        return { type: 'chat', text: 'Usage: !sr <url> [title]' };
      }
      const url = args[0];
      const title = args.slice(1).join(' ') || null;
      const result = await addMediaRequest(channelId, userId, username, url, title);
      
      if (result.success) {
        return { 
          type: 'chat', 
          text: `@${username} Added "${result.request.title}" to queue (position ${result.position})` 
        };
      } else {
        return { type: 'chat', text: `@${username} ${result.error}` };
      }

    case 'queue':
      const queue = getQueue(channelId);
      if (!queue.current && queue.items.length === 0) {
        return { type: 'chat', text: 'Queue is empty' };
      }
      
      let queueText = '';
      if (queue.current) {
        queueText += `Now playing: "${queue.current.title}" (requested by ${queue.current.username})`;
      }
      if (queue.items.length > 0) {
        const next = queue.items.slice(0, 3).map((item, i) => 
          `${i + 1}. "${item.title}" (${item.username})`
        ).join(', ');
        queueText += queue.current ? ` | Next: ${next}` : `Queue: ${next}`;
        if (queue.items.length > 3) {
          queueText += ` (+${queue.items.length - 3} more)`;
        }
      }
      return { type: 'chat', text: queueText };

    case 'skip':
      const skipped = await skipCurrent(channelId);
      if (skipped) {
        return { type: 'chat', text: `Skipped to: "${skipped.title}" (requested by ${skipped.username})` };
      } else {
        return { type: 'chat', text: 'Queue is empty' };
      }

    case 'clearqueue':
      await clearQueue(channelId);
      return { type: 'chat', text: 'Queue cleared' };

    default:
      return null;
  }
}