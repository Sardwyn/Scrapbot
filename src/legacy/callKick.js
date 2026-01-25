import axios from 'axios';
import { refreshIfNeeded } from './refreshKick.js';

export async function callKickProtected(method, endpoint, options = {}) {
  console.log("Debug: callKickProtected invoked with:");
  console.log("  method:", method);
  console.log("  endpoint:", endpoint);
  console.log("  ownerId:", options.ownerId);

  const tokens = await refreshIfNeeded(options.ownerId);

  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${tokens.access_token}`
  };

  const resp = await axios.request({
    method,
    url: `https://kick.com/api/v1/${endpoint}`,
    headers,
    data: options.data,
    params: options.params,
    timeout: options.timeout || 15000
  });

  return { success: true, data: resp.data };
}
