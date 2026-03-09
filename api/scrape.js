export default async function handler(req, res) {
  // Allow requests from your Vercel app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, apiKey } = req.body;
  if (!username || !apiKey) return res.status(400).json({ error: 'Missing username or apiKey' });

  try {
    // 1. Start the Apify scraper run
    const startRes = await fetch(`https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usernames: [username],
        resultsLimit: 24,
        scrapeType: 'posts',
      })
    });

    if (startRes.status === 401) return res.status(401).json({ error: 'Invalid Apify API key' });
    if (startRes.status === 402) return res.status(402).json({ error: 'Apify account out of credits' });
    if (!startRes.ok) {
      const txt = await startRes.text();
      return res.status(500).json({ error: `Apify start error: ${txt.slice(0, 200)}` });
    }

    const runData = await startRes.json();
    const runId = runData.data.id;
    const datasetId = runData.data.defaultDatasetId;

    // 2. Poll until done (max 90 seconds)
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apiKey}`);
      const statusData = await statusRes.json();
      const status = statusData.data.status;
      if (status === 'SUCCEEDED') break;
      if (['FAILED','ABORTED','TIMED-OUT'].includes(status)) {
        return res.status(500).json({ error: `Scraper ${status}. Try again.` });
      }
    }

    // 3. Get results
    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${apiKey}&clean=true`);
    const items = await itemsRes.json();

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(404).json({ error: `No posts found for @${username}. Account may be private.` });
    }

    // 4. Normalize the data
    const posts = items.map((item, idx) => {
      const likes = item.likesCount || item.likes || 0;
      const comments = item.commentsCount || item.comments || 0;
      const views = item.videoViewCount || item.videoPlayCount || item.playCount || 0;
      const followers = item.ownerFollowersCount || 1000;
      return {
        id: item.id || item.shortCode || `${username}_${idx}`,
        platform: 'instagram',
        username,
        handle: '@' + username,
        avatar: item.ownerProfilePicUrl || '',
        type: item.type === 'Video' ? 'video' : item.type === 'Sidecar' ? 'carousel' : 'post',
        thumbnail: item.displayUrl || item.thumbnailUrl || '',
        caption: (item.caption || '').slice(0, 140),
        views,
        likes,
        comments,
        engagement: (likes + comments) / Math.max(followers, 1),
        date: item.timestamp ? new Date(item.timestamp).toLocaleDateString() : 'Unknown',
        url: item.url || (item.shortCode ? `https://instagram.com/p/${item.shortCode}` : '#'),
        saved: false
      };
    });

    return res.status(200).json({ posts });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
