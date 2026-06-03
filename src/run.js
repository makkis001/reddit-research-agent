import fs from 'node:fs/promises';

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const REDDIT_ACTOR_ID = process.env.APIFY_REDDIT_ACTOR_ID || '9sHOY9RzPYGjmTHo8';
const GOOGLE_ACTOR_ID = process.env.APIFY_GOOGLE_ACTOR_ID || 'apify~google-search-scraper';

if (!APIFY_TOKEN) {
  console.error('Missing APIFY_TOKEN');
  process.exit(1);
}

async function apifyGet(path) {
  const res = await fetch(`https://api.apify.com/v2/${path}${path.includes('?') ? '&' : '?'}token=${APIFY_TOKEN}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify GET ${path} failed: ${res.status} ${text}`);
  return JSON.parse(text).data;
}

async function tryReadActor(actorId) {
  const actor = await apifyGet(`acts/${actorId}`);
  let inputSchema = actor.inputSchema || actor.defaultRunOptions?.inputSchema || null;

  if (!inputSchema) {
    try {
      const build = await apifyGet(`acts/${actorId}/builds/default`);
      inputSchema = build.inputSchema || build.defaultRunOptions?.inputSchema || null;
    } catch (err) {
      inputSchema = null;
    }
  }

  return {
    id: actorId,
    name: actor.name,
    username: actor.username,
    title: actor.title,
    inputSchema
  };
}

async function main() {
  await fs.mkdir('dist', { recursive: true });

  const redditActor = await tryReadActor(REDDIT_ACTOR_ID);
  let googleActor = null;

  try {
    googleActor = await tryReadActor(GOOGLE_ACTOR_ID);
  } catch (err) {
    googleActor = {
      id: GOOGLE_ACTOR_ID,
      error: String(err.message || err)
    };
  }

  const out = { redditActor, googleActor };

  await fs.writeFile('dist/apify-actor-schemas.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));

  if (!redditActor.inputSchema) {
    console.log('Schema not exposed by actor metadata. Next step: inspect actor input manually from Apify Console or run with a known sample input. This run is intentionally marked successful so logs/artifact are preserved.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
