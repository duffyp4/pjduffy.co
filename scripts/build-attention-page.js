/**
 * Build the "Paying Attention To" page.
 *
 * Data sources:
 *   1. X Bookmarks — Google Sheet "Learning Log" → "X Bookmarks" tab
 *   2. Articles — Kindle Cleaner worker KV → GET /articles
 *
 * Pipeline:
 *   Fetch data → merge → Gemini Flash filter (remove entertainment) → fetch OG metadata for articles → generate HTML
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'radar.html');

const SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const KINDLE_WORKER_URL = process.env.KINDLE_WORKER_URL;
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const ITEMS_PER_PAGE = 20;

// --- Google Service Account Auth ---

async function getGoogleAccessToken() {
  if (!SA_EMAIL || !SA_KEY) return null;

  const crypto = await import('crypto');

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claim = Buffer.from(JSON.stringify({
    iss: SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');

  const signingInput = header + '.' + claim;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(SA_KEY, 'base64url');
  const jwt = signingInput + '.' + signature;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt
  });

  const data = await res.json();
  if (!res.ok) throw new Error('Google token exchange failed: ' + JSON.stringify(data));
  return data.access_token;
}

// --- Sync articles from KV to Sheet ---

async function syncArticlesToSheet(articles) {
  const token = await getGoogleAccessToken();
  if (!token) {
    console.log('  No service account credentials, skipping sheet sync');
    return;
  }

  // Read existing URLs from Sheet
  const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/Articles!C:C`;
  const readRes = await fetch(readUrl, { headers: { 'Authorization': 'Bearer ' + token } });
  const readData = await readRes.json();
  const existingUrls = new Set((readData.values || []).flat());

  // Find new articles not yet in Sheet
  const newArticles = articles.filter(a => !existingUrls.has(a.url));
  if (newArticles.length === 0) {
    console.log('  No new articles to sync to sheet');
    return;
  }

  // Append new rows
  const rows = newArticles.map(a => [a.date, a.title, a.url, a.author, a.siteName]);
  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/Articles!A:E:append?valueInputOption=RAW`;
  const appendRes = await fetch(appendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ values: rows })
  });

  if (appendRes.ok) {
    console.log('  Synced ' + newArticles.length + ' new articles to sheet');
  } else {
    console.warn('  Sheet sync failed:', appendRes.status, await appendRes.text());
  }
}

// --- Data fetching ---

async function fetchXBookmarks() {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/X%20Bookmarks!A:C?key=${GOOGLE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const rows = (data.values || []).slice(1); // skip header
  return rows.map(([date, postLink]) => ({
    type: 'bookmark',
    date: date || '',
    url: postLink || '',
    tweetText: '',
    tweetAuthor: '',
    tweetAuthorHandle: '',
  }));
}

async function fetchOembedData(tweetUrl) {
  try {
    const res = await fetch(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=true&dnt=true`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    // Extract text from the blockquote HTML
    const textMatch = data.html.match(/<p[^>]*>(.*?)<\/p>/s);
    const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').replace(/&mdash;.*$/, '').trim() : '';
    return {
      text,
      authorName: data.author_name || '',
      authorHandle: data.author_url ? data.author_url.split('/').pop() : '',
    };
  } catch {
    return null;
  }
}

async function enrichBookmarksWithOembed(bookmarks) {
  console.log('Fetching oEmbed data for ' + bookmarks.length + ' tweets...');
  let fetched = 0;
  // Process in batches of 10 to avoid hammering the API
  for (let i = 0; i < bookmarks.length; i += 10) {
    const batch = bookmarks.slice(i, i + 10);
    const results = await Promise.all(batch.map(b => fetchOembedData(b.url)));
    results.forEach((data, j) => {
      if (data) {
        bookmarks[i + j].tweetText = data.text;
        bookmarks[i + j].tweetAuthor = data.authorName;
        bookmarks[i + j].tweetAuthorHandle = data.authorHandle;
        fetched++;
      }
    });
    if (i % 100 === 0 && i > 0) console.log('  ' + i + '/' + bookmarks.length + ' processed...');
  }
  console.log('  Fetched oEmbed for ' + fetched + '/' + bookmarks.length + ' tweets');
  return bookmarks;
}

async function fetchArticles() {
  const res = await fetch(`${KINDLE_WORKER_URL}/articles`);
  if (!res.ok) throw new Error(`Worker articles error: ${res.status}`);
  const data = await res.json();
  return (data.articles || []).map(a => ({
    type: 'article',
    date: a.date || '',
    url: a.url || '',
    title: a.title || '',
    author: a.author || '',
    siteName: a.siteName || '',
  }));
}

// --- Archive URL resolution ---

function isArchiveUrl(url) {
  return /^https?:\/\/(archive\.(is|org|ph|today|li|vn|fo|md)|web\.archive\.org)/.test(url);
}

async function resolveArchiveUrl(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AttentionPageBot/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // archive.is embeds the original URL in the favicon link's domain param
    const faviconMatch = html.match(/google\.com\/s2\/favicons\?domain=([^"&]+)/);
    if (faviconMatch) {
      // Find the actual full URL from the page content
      const domain = faviconMatch[1];
      const fullUrlMatch = html.match(new RegExp('https?://' + domain.replace(/\./g, '\\.') + '/[^"\'\\s<]+'));
      if (fullUrlMatch) return fullUrlMatch[0];
    }
    return null;
  } catch {
    return null;
  }
}

// --- OpenGraph fetching for articles ---

async function fetchOgMetadata(articleUrl) {
  try {
    var fetchUrl = articleUrl;
    if (isArchiveUrl(articleUrl)) {
      var original = await resolveArchiveUrl(articleUrl);
      if (original) {
        console.log('  Resolved archive URL: ' + articleUrl + ' -> ' + original);
        fetchUrl = original;
      }
    }

    const res = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AttentionPageBot/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return {};

    const html = await res.text();
    const og = {};
    const metaRegex = /<meta\s+(?:property|name)=["']og:(\w+)["']\s+content=["']([^"']*)["']/gi;
    let match;
    while ((match = metaRegex.exec(html)) !== null) {
      og[match[1]] = match[2];
    }
    const metaRegex2 = /<meta\s+content=["']([^"']*)["']\s+(?:property|name)=["']og:(\w+)["']/gi;
    while ((match = metaRegex2.exec(html)) !== null) {
      og[match[2]] = match[1];
    }
    return og;
  } catch {
    return {};
  }
}

// --- HTML generation ---

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generatePage(items) {
  // Serialize items as JSON for client-side rendering (only needed fields)
  // No embedHtml in JSON — it contains HTML that breaks script tags.
  const itemsJson = JSON.stringify(items.map(item => ({
    type: item.type,
    date: item.date,
    url: item.url,
    title: item.title || '',
    author: item.author || '',
    siteName: item.siteName || '',
    ogImage: item.ogImage || '',
    ogDescription: item.ogDescription || '',
    tweetText: item.tweetText || '',
    tweetAuthor: item.tweetAuthor || '',
    tweetAuthorHandle: item.tweetAuthorHandle || '',
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PJ Duffy's Home Page - Radar</title>
    <link rel="icon" type="image/png" href="/images/logo.png">
    <link rel="stylesheet" href="styles.css">
    <style>
        .filter-bar { padding: 10px 15px; background: #CCCCCC; border-bottom: 2px solid #999; display: flex; gap: 6px; flex-wrap: wrap; }
        .filter-btn { padding: 4px 12px; background: #DDDDDD; border: 2px outset #EEEEEE; font-size: 13px; font-family: 'Apple Garamond', Georgia, serif; cursor: pointer; color: #000; }
        .filter-btn:hover { background: #C8C8C8; }
        .filter-btn.active { background: #333; color: white; border: 2px inset #666; }
        .attention-feed { padding: 15px; display: flex; flex-direction: column; gap: 15px; }
        .article-card { display: block; border: 1px solid #ccc; overflow: hidden; text-decoration: none; color: inherit; box-shadow: 1px 1px 0 #999; }
        .article-card:hover { box-shadow: 2px 2px 0 #666; }
        .og-image img { width: 100%; height: 180px; object-fit: cover; display: block; }
        .article-card-body { padding: 10px 12px; }
        .article-card-title { font-size: 15px; font-weight: bold; color: #000; margin-bottom: 4px; }
        .article-card-desc { font-size: 13px; color: #444; line-height: 1.4; margin-bottom: 6px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .article-card-meta { font-size: 12px; color: #888; }
        .pagination { padding: 12px 15px; background: #CCCCCC; border-top: 2px solid #999; display: flex; justify-content: center; align-items: center; gap: 6px; font-family: 'Apple Garamond', Georgia, serif; font-size: 13px; }
        .page-btn { padding: 3px 10px; background: #DDDDDD; border: 2px outset #EEEEEE; font-size: 12px; cursor: pointer; font-family: 'Apple Garamond', Georgia, serif; }
        .page-btn.active { background: #333; color: white; border: 2px inset #666; }
        .page-info { color: #444; }
        .tweet-card { display: block; border: 1px solid #e1e8ed; border-radius: 12px; padding: 16px; text-decoration: none; color: inherit; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: white; }
        .tweet-card:hover { background: #f8f9fa; }
        .tweet-author { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .tweet-author-name { font-size: 14px; font-weight: bold; color: #0f1419; }
        .tweet-author-handle { font-size: 13px; color: #536471; }
        .tweet-text { font-size: 15px; color: #0f1419; line-height: 1.4; margin-bottom: 8px; }
        .tweet-date { font-size: 13px; color: #536471; }
    </style>
</head>
<body>
    <div id="page-container">
        <header id="main-header">
            <div class="logo-area"><img src="images/logo.png" alt="PJ Duffy Logo"></div>
            <div class="title-area"><h1>PJ Duffy's Home on the World Wide Web</h1></div>
        </header>
        <div class="content-wrapper">
            <aside class="sidebar">
                <div class="sidebar-section main-nav">
                    <nav><ul>
                        <li><a href="/">Home</a></li>
                        <li><a href="/photos">Photos</a></li>
                        <li><a href="/quotes">Cool Quotes</a></li>
                        <li><a href="/reading-list">Books</a></li>
                        <li><a href="/thoughts">Thoughts</a></li>
                        <li><a href="/radar" class="active">Radar</a></li>
                    </ul></nav>
                </div>
            </aside>
            <main>
                <h2 class="page-title">What's On My Radar</h2>
                <div class="filter-bar">
                    <button class="filter-btn active" data-filter="all">All</button>
                    <button class="filter-btn" data-filter="article">Articles</button>
                    <button class="filter-btn" data-filter="bookmark">X Bookmarks</button>
                </div>
                <div class="attention-feed" id="feed"></div>
                <div class="pagination" id="pagination"></div>
            </main>
        </div>
        <div class="button-bar">
            <a href="https://letshum.com" target="_blank">PJ's Internet Services</a>
            <a href="mailto:pj.duffy4@gmail.com">Contact Me</a>
        </div>
        <footer id="main-footer"><p>&copy; 1994-2026 PJ Duffy - Best viewed with Netscape Navigator 4.0</p></footer>
    </div>
    <script>var RADAR_DATA = ${itemsJson};</script>
    <script>
    (function() {
        var PER_PAGE = ${ITEMS_PER_PAGE};
        var items = RADAR_DATA;
        var feed = document.getElementById('feed');
        var pag = document.getElementById('pagination');
        var filter = 'all', page = 1;

        function filtered() {
            return filter === 'all' ? items : items.filter(function(i) { return i.type === filter; });
        }

        function renderTweetCard(item, container) {
            var a = document.createElement('a');
            a.href = item.url; a.target = '_blank'; a.className = 'tweet-card';
            var authorDiv = document.createElement('div'); authorDiv.className = 'tweet-author';
            var name = document.createElement('span'); name.className = 'tweet-author-name';
            name.textContent = item.tweetAuthor || 'Unknown';
            var handle = document.createElement('span'); handle.className = 'tweet-author-handle';
            handle.textContent = item.tweetAuthorHandle ? '@' + item.tweetAuthorHandle : '';
            authorDiv.appendChild(name); authorDiv.appendChild(handle);
            a.appendChild(authorDiv);
            if (item.tweetText) {
                var text = document.createElement('div'); text.className = 'tweet-text';
                text.textContent = item.tweetText;
                a.appendChild(text);
            }
            var date = document.createElement('div'); date.className = 'tweet-date';
            date.textContent = item.date;
            a.appendChild(date);
            container.appendChild(a);
        }

        function renderArticleCard(item, container) {
            var a = document.createElement('a');
            a.href = item.url; a.target = '_blank'; a.className = 'article-card';
            if (item.ogImage) {
                var imgDiv = document.createElement('div'); imgDiv.className = 'og-image';
                var img = document.createElement('img'); img.src = item.ogImage; img.alt = ''; img.loading = 'lazy';
                imgDiv.appendChild(img); a.appendChild(imgDiv);
            }
            var body = document.createElement('div'); body.className = 'article-card-body';
            var title = document.createElement('div'); title.className = 'article-card-title'; title.textContent = item.title;
            body.appendChild(title);
            if (item.ogDescription) {
                var desc = document.createElement('div'); desc.className = 'article-card-desc'; desc.textContent = item.ogDescription;
                body.appendChild(desc);
            }
            var meta = document.createElement('div'); meta.className = 'article-card-meta';
            var host = ''; try { host = new URL(item.url).hostname; } catch(e) {}
            meta.textContent = (item.author ? item.author + ' \u00b7 ' : '') + (item.siteName || host);
            body.appendChild(meta);
            a.appendChild(body);
            container.appendChild(a);
        }

        function render() {
            var f = filtered();
            var pages = Math.max(1, Math.ceil(f.length / PER_PAGE));
            if (page > pages) page = pages;
            var slice = f.slice((page - 1) * PER_PAGE, page * PER_PAGE);

            while (feed.firstChild) feed.removeChild(feed.firstChild);

            slice.forEach(function(item) {
                if (item.type === 'bookmark') {
                    renderTweetCard(item, feed);
                } else {
                    renderArticleCard(item, feed);
                }
            });

            while (pag.firstChild) pag.removeChild(pag.firstChild);
            if (pages > 1) {
                var prev = document.createElement('button');
                prev.className = 'page-btn'; prev.textContent = '\u2190 Prev'; prev.disabled = page === 1;
                prev.onclick = function() { page--; render(); window.scrollTo(0,0); };
                pag.appendChild(prev);
                var info = document.createElement('span');
                info.className = 'page-info'; info.textContent = 'Page ' + page + ' of ' + pages;
                pag.appendChild(info);
                var next = document.createElement('button');
                next.className = 'page-btn'; next.textContent = 'Next \u2192'; next.disabled = page === pages;
                next.onclick = function() { page++; render(); window.scrollTo(0,0); };
                pag.appendChild(next);
            }
        }

        document.querySelectorAll('.filter-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                filter = btn.dataset.filter; page = 1; render();
            });
        });

        render();
    })();
    </script>
</body>
</html>`;
}

// --- Main ---

async function main() {
  console.log('Fetching X bookmarks from Google Sheet...');
  var bookmarks = await fetchXBookmarks();
  console.log('  ' + bookmarks.length + ' bookmarks');

  // Enrich bookmarks with tweet text via oEmbed
  bookmarks = await enrichBookmarksWithOembed(bookmarks);

  console.log('Fetching articles from Kindle worker...');
  const articles = await fetchArticles();
  console.log('  ' + articles.length + ' articles');

  console.log('Syncing articles to Google Sheet...');
  await syncArticlesToSheet(articles);

  var allItems = [...bookmarks, ...articles].sort(function(a, b) { return b.date.localeCompare(a.date); });
  console.log('Total items: ' + allItems.length);

  console.log('Fetching OpenGraph metadata for articles...');
  for (const item of allItems) {
    if (item.type === 'article' && item.url) {
      const og = await fetchOgMetadata(item.url);
      item.ogImage = og.image || '';
      item.ogDescription = og.description || '';
      if (!item.title && og.title) item.title = og.title;
      if (og.site_name && (!item.siteName || isArchiveUrl(item.url))) item.siteName = og.site_name;
      if (og.author && (!item.author || isArchiveUrl(item.url))) item.author = og.author;
    }
  }

  console.log('Generating radar.html...');
  const html = generatePage(allItems);
  writeFileSync(OUTPUT_PATH, html);
  console.log('Written to ' + OUTPUT_PATH + ' (' + allItems.length + ' items)');
}

main().catch(function(err) {
  console.error('Build failed:', err);
  process.exit(1);
});
