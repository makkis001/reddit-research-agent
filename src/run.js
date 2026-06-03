import fs from 'node:fs/promises';

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const REDDIT_ACTOR_ID = process.env.APIFY_REDDIT_ACTOR_ID || '9sHOY9RzPYGjmTHo8';
const GOOGLE_ACTOR_ID = process.env.APIFY_GOOGLE_ACTOR_ID || 'apify~google-search-scraper';

if (!APIFY_TOKEN) {
  console.error('Missing APIFY_TOKEN');
  process.exit(1);
}

async function getActor(actorId) {
  const res = await fetch(`https://api.apify.com/v2/acts/${actorId}?token=${APIFY_TOKEN}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`Cannot read actor ${actorId}: ${res.status} ${text}`);
  return JSON.parse(text).data;
}

async function main() {
  await fs.mkdir('dist', { recursive: true });

  const redditActor = await getActor(REDDIT_ACTOR_ID);
  const googleActor = await getActor(GOOGLE_ACTOR_ID);

  const out = {
    redditActor: {
      id: REDDIT_ACTOR_ID,
      name: redditActor.name,
      username: redditActor.username,
      title: redditActor.title,
      inputSchema: redditActor.inputSchema || redditActor.defaultRunOptions?.inputSchema || null
    },
    googleActor: {
      id: GOOGLE_ACTOR_ID,
      name: googleActor.name,
      username: googleActor.username,
      title: googleActor.title,
      inputSchema: googleActor.inputSchema || googleActor.defaultRunOptions?.inputSchema || null
    }
  };

  await fs.writeFile('dist/apify-actor-schemas.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));

  if (!out.redditActor.inputSchema) {
    throw new Error('Reddit actor schema not found in API response. Check actor access or actor ID.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
