import fs from 'node:fs/promises';

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN;
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;
const REDDIT_ACTOR_ID = process.env.APIFY_REDDIT_ACTOR_ID || '9sHOY9RzPYGjmTHo8';
const GOOGLE_ACTOR_ID = process.env.APIFY_GOOGLE_ACTOR_ID || 'apify~google-search-scraper';

const REQUIRED = { APIFY_TOKEN, OPENAI_API_KEY, NETLIFY_AUTH_TOKEN, NETLIFY_SITE_ID };
for (const [name, value] of Object.entries(REQUIRED)) {
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function apifyRun(actorId, input) {
  const start = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
  const startText = await start.text();
  if (!start.ok) throw new Error(`Apify start failed for ${actorId}: ${start.status} ${startText}`);
  const run = JSON.parse(startText).data;

  for (;;) {
    const res = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${APIFY_TOKEN}`);
    const text = await res.text();
    if (!res.ok) throw new Error(`Apify poll failed: ${res.status} ${text}`);
    const data = JSON.parse(text).data;
    if (data.status === 'SUCCEEDED') {
      const ds = await fetch(`https://api.apify.com/v2/datasets/${data.defaultDatasetId}/items?clean=true&token=${APIFY_TOKEN}`);
      const dsText = await ds.text();
      if (!ds.ok) throw new Error(`Apify dataset failed: ${ds.status} ${dsText}`);
      return JSON.parse(dsText);
    }
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(data.status)) {
      throw new Error(`Apify run ${data.id} ended with ${data.status}`);
    }
    await sleep(8000);
  }
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function extractUrl(item) {
  return item.url || item.postUrl || item.permalink || item.link || item.href || item.shareUrl || item.commentsUrl || '';
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url.startsWith('http') ? url : `https://www.reddit.com${url}`);
    u.search = '';
    return u.toString().replace(/\/$/, '/');
  } catch {
    return url;
  }
}

function textOf(item) {
  return [item.title, item.text, item.body, item.selftext, item.description, item.snippet, item.subreddit, extractUrl(item)].filter(Boolean).join('\n');
}

function detectVendors(text, config) {
  const found = [];
  const lower = text.toLowerCase();
  for (const [vendor, terms] of Object.entries(config.vendors || {})) {
    if (terms.some(t => lower.includes(String(t).toLowerCase()))) found.push(vendor);
  }
  return found;
}

function detectTopics(text, config) {
  const found = [];
  const lower = text.toLowerCase();
  for (const [topic, terms] of Object.entries(config.topics || {})) {
    if (terms.some(t => lower.includes(String(t).toLowerCase()))) found.push(topic);
  }
  return found;
}

function scoreCandidate(item, config) {
  const text = textOf(item);
  const lower = text.toLowerCase();
  const vendors = detectVendors(text, config);
  const topics = detectTopics(text, config);
  const signals = [];
  let score = 0;

  if (vendors.length) { score += 25 * vendors.length; signals.push('vendor'); }
  if (topics.length) { score += 20 * topics.length; signals.push('topic'); }
  if (/\b(vs|versus|compare|comparison|alternative|alternatives|better|choose|shortlist)\b/i.test(text)) { score += 25; signals.push('comparison'); }
  if (/\b(price|pricing|cost|quote|budget|expensive|cheap|license|renewal)\b/i.test(text)) { score += 25; signals.push('pricing'); }
  if (/\b(evaluate|buy|buying|select|selecting|poc|demo|vendor|recommend|recommendation)\b/i.test(text)) { score += 25; signals.push('buying'); }
  if (/\b(problem|issue|hate|worst|bad|pain|complaint|ripoff|avoid|broken)\b/i.test(text)) { score += 20; signals.push('complaint'); }
  if (/\b(ot|ics|scada|industrial|cybersecurity|security|network|asset|vulnerability|segmentation)\b/i.test(text)) { score += 15; signals.push('security_context'); }

  const ambiguous = ['guardian', 'vantage', 'arc', 'ctd', 'centrix'];
  const onlyAmbiguous = vendors.length && ambiguous.some(a => lower.includes(a)) && !/\b(ot|ics|scada|industrial|cybersecurity|security|claroty|nozomi|armis|dragos)\b/i.test(text);
  if (onlyAmbiguous) score -= 100;

  return { score, vendors, topics, signals: uniq(signals) };
}

function buildSearchTerms(config) {
  const terms = [];
  for (const values of Object.values(config.vendors || {})) terms.push(...values.slice(0, 2));
  for (const values of Object.values(config.topics || {})) terms.push(...values.slice(0, 2));
  return uniq(terms).slice(0, 40);
}

function toCandidate(item, config) {
  const url = normalizeUrl(extractUrl(item));
  const scored = scoreCandidate(item, config);
  return {
    url,
    title: item.title || item.heading || item.name || '(untitled)',
    subreddit: item.subreddit || item.communityName || item.community || '',
    date: item.createdAt || item.createdUtc || item.date || item.timestamp || '',
    comments: item.numComments || item.commentsCount || item.commentCount || 0,
    score: item.score || item.upvotes || item.upVotes || 0,
    snippet: String(item.text || item.selftext || item.body || item.snippet || '').slice(0, 500),
    selectionScore: scored.score,
    vendors: scored.vendors,
    topics: scored.topics,
    signals: scored.signals,
    raw: item
  };
}

async function analyzeWithOpenAI(payload) {
  const prompt = `You are producing an Italian Reddit OT security intelligence report. Focus on single-vendor conversations and topic conversations first; competitive pairings second. Return strict JSON with: executiveSummary array, mainTakeaways array, vendorSections array, topicSections array, competitivePairings array, urlAnalyses array. Each urlAnalysis must include url,title,summary,mainTakeaways,buyerStage,vendors,topics,whyRelevant,evidenceSnippets.`;
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4.1',
      input: `${prompt}\n\nDATA:\n${JSON.stringify(payload).slice(0, 180000)}`,
      text: { format: { type: 'json_object' } }
    })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI failed: ${res.status} ${text}`);
  const data = JSON.parse(text);
  const out = data.output_text || data.output?.flatMap(o => o.content || []).map(c => c.text).join('\n') || '{}';
  return JSON.parse(out);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function list(items) {
  return `<ul>${(items || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

function sectionCards(items, titleKey = 'title') {
  return (items || []).map(item => `<article class="card"><h3>${esc(item[titleKey] || item.vendor || item.topic || item.pairing || 'Section')}</h3>${list(item.points || item.takeaways || item.mainTakeaways || item.summary || [])}</article>`).join('');
}

function renderHtml(report, selected, rejected) {
  const generatedAt = new Date().toISOString();
  const urlCards = (report.urlAnalyses || selected).map((u, i) => `<article class="url-card">
    <h3>${esc(u.title || selected[i]?.title || 'URL')}</h3>
    <p><a href="${esc(u.url || selected[i]?.url)}">${esc(u.url || selected[i]?.url)}</a></p>
    <p>${esc(u.summary || selected[i]?.snippet || '')}</p>
    <h4>Main takeaways</h4>${list(u.mainTakeaways || [])}
    <p><strong>Buyer stage:</strong> ${esc(u.buyerStage || 'unknown')}</p>
    <p><strong>Vendors:</strong> ${esc((u.vendors || selected[i]?.vendors || []).join(', '))}</p>
    <p><strong>Topics:</strong> ${esc((u.topics || selected[i]?.topics || []).join(', '))}</p>
    <p><strong>Why relevant:</strong> ${esc(u.whyRelevant || '')}</p>
    <h4>Evidence</h4>${list(u.evidenceSnippets || [])}
  </article>`).join('');

  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reddit OT Security Intelligence Report</title><style>
  body{font-family:Inter,Arial,sans-serif;margin:0;background:#f6f7fb;color:#151923}header{background:#101827;color:#fff;padding:32px}main{max-width:1180px;margin:auto;padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.card,.url-card{background:#fff;border:1px solid #e2e6ef;border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:0 1px 3px #0001}.url-card{border-left:5px solid #334155}h1,h2,h3{margin-top:0}.meta{color:#637083}.pill{display:inline-block;background:#e8eef8;border-radius:999px;padding:4px 10px;margin:2px}a{color:#174ea6}table{width:100%;border-collapse:collapse;background:white}td,th{border-bottom:1px solid #e2e6ef;padding:10px;text-align:left}th{background:#eef2f7}</style></head><body><header><h1>Reddit OT Security Intelligence Report</h1><p>Generated ${esc(generatedAt)} · Selected URLs ${selected.length} · Rejected candidates ${rejected.length}</p></header><main>
  <h2>Executive summary</h2>${list(report.executiveSummary || [])}
  <h2>Main takeaways</h2>${list(report.mainTakeaways || [])}
  <h2>Single-vendor conversations</h2><div class="grid">${sectionCards(report.vendorSections, 'vendor')}</div>
  <h2>Topic conversations</h2><div class="grid">${sectionCards(report.topicSections, 'topic')}</div>
  <h2>Competitive pairings</h2><div class="grid">${sectionCards(report.competitivePairings, 'pairing')}</div>
  <h2>Detailed URL analysis</h2>${urlCards}
  <h2>Selected URL table</h2><table><thead><tr><th>Score</th><th>Title</th><th>Subreddit</th><th>Signals</th><th>URL</th></tr></thead><tbody>${selected.map(c => `<tr><td>${c.selectionScore}</td><td>${esc(c.title)}</td><td>${esc(c.subreddit)}</td><td>${esc(c.signals.join(', '))}</td><td><a href="${esc(c.url)}">open</a></td></tr>`).join('')}</tbody></table>
  </main></body></html>`;
}

async function deployNetlify() {
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/deploys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${NETLIFY_AUTH_TOKEN}`, 'content-type': 'application/zip' },
    body: await fs.readFile('dist/site.zip').catch(() => null)
  });
  if (!res.ok) {
    console.log('Netlify direct zip deploy skipped/failed. Report files are still in dist/.');
    return null;
  }
  return await res.json();
}

async function main() {
  await fs.mkdir('dist', { recursive: true });
  const config = await readJson('config/keywords.json', { vendors: {}, topics: {}, maxSelectedPosts: 20 });
  const selectionRules = await readJson('config/selection_rules.json', { minimumScoreForDeepFetch: 70, maxSelectedUrls: 20 });

  const searchTerms = buildSearchTerms(config);
  console.log(`Searching Reddit with ${searchTerms.length} terms`);
  const searchItems = await apifyRun(REDDIT_ACTOR_ID, {
    searchTerms,
    searchPosts: true,
    searchComments: false,
    searchCommunities: false,
    withinCommunity: '',
    searchSort: 'new',
    searchTime: 'year',
    startUrls: [],
    fastMode: true,
    crawlCommentsPerPost: false,
    includeNSFW: false,
    maxPostsCount: 300,
    maxCommentsCount: 0,
    maxCommentsPerPost: 0,
    maxCommunitiesCount: 0,
    proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
  });

  const byUrl = new Map();
  for (const item of searchItems) {
    const c = toCandidate(item, config);
    if (c.url && !byUrl.has(c.url)) byUrl.set(c.url, c);
  }
  const allCandidates = [...byUrl.values()].sort((a, b) => b.selectionScore - a.selectionScore);
  const minScore = selectionRules.minimumScoreForDeepFetch ?? 70;
  const maxSelected = selectionRules.maxSelectedUrls ?? config.maxSelectedPosts ?? 20;
  const selected = allCandidates.filter(c => c.selectionScore >= minScore).slice(0, maxSelected);
  const rejected = allCandidates.filter(c => !selected.includes(c)).slice(0, 100);

  console.log(`Candidates: ${allCandidates.length}; selected for deep fetch: ${selected.length}`);
  if (!selected.length) throw new Error('No selected Reddit URLs after filtering. Broaden keywords or lower threshold.');

  const deepItems = await apifyRun(REDDIT_ACTOR_ID, {
    searchTerms: [],
    startUrls: selected.map(c => ({ url: c.url })),
    crawlCommentsPerPost: true,
    maxCommentsPerPost: config.maxCommentsPerPost || 100,
    maxPostsCount: selected.length,
    includeNSFW: false,
    proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
  });

  const payload = { selected, deepItems };
  await fs.writeFile('dist/selected-candidates.json', JSON.stringify(selected, null, 2));
  await fs.writeFile('dist/deep-items.json', JSON.stringify(deepItems, null, 2));

  console.log('Analyzing with OpenAI');
  const report = await analyzeWithOpenAI(payload);
  await fs.writeFile('dist/report.json', JSON.stringify(report, null, 2));
  await fs.writeFile('dist/index.html', renderHtml(report, selected, rejected));

  console.log('Report generated at dist/index.html');
  console.log('Netlify deploy is not enabled in-code yet because direct deploy needs zipped file support. Use Netlify CLI step next if needed.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
