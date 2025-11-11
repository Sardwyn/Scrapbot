import axios from 'axios';
export async function whoAmI(access_token) {
  const url = process.env.KICK_WHOAMI_URL; // set this when you know it
  if (!url) return null;
  const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${access_token}` } });
  return data;
}
