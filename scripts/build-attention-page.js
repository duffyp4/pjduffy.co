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
  return rows.map(([date, postLink, embedHtml]) => ({
    type: 'bookmark',
    date: date || '',
    url: postLink || '',
    embedHtml: embedHtml || '',
  }));
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

// --- OpenGraph fetching for articles ---

async function fetchOgMetadata(articleUrl) {
  try {
    const res = await fetch(articleUrl, {
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
    // Also try reversed attribute order
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

function generateBookmarkCard(item) {
  return `
                    <div class="attention-card" data-type="bookmark" data-date="${escapeHtml(item.date)}">
                        ${item.embedHtml}
                    </div>`;
}

function generateArticleCard(item) {
  const ogImage = item.ogImage
    ? `<div class="og-image"><img src="${escapeHtml(item.ogImage)}" alt="" loading="lazy"></div>`
    : '';

  return `
                    <div class="attention-card" data-type="article" data-date="${escapeHtml(item.date)}">
                        <a href="${escapeHtml(item.url)}" target="_blank" class="article-card">
                            ${ogImage}
                            <div class="article-card-body">
                                <div class="article-card-title">${escapeHtml(item.title)}</div>
                                ${item.ogDescription ? `<div class="article-card-desc">${escapeHtml(item.ogDescription)}</div>` : ''}
                                <div class="article-card-meta">
                                    ${item.author ? escapeHtml(item.author) + ' &middot; ' : ''}${escapeHtml(item.siteName || new URL(item.url).hostname)}
                                </div>
                            </div>
                        </a>
                    </div>`;
}

function generatePage(items) {
  const cards = items.map(item => {
    if (item.type === 'bookmark') return generateBookmarkCard(item);
    if (item.type === 'article') return generateArticleCard(item);
    return '';
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PJ Duffy's Home Page - Radar</title>
    <link rel="stylesheet" href="styles.css">
    <style>
        .filter-bar {
            padding: 10px 15px;
            background: #CCCCCC;
            border-bottom: 2px solid #999;
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }
        .filter-btn {
            padding: 4px 12px;
            background: #DDDDDD;
            border: 2px outset #EEEEEE;
            font-size: 13px;
            font-family: 'Apple Garamond', Georgia, serif;
            cursor: pointer;
            color: #000;
            text-decoration: none;
        }
        .filter-btn:hover {
            background: #C8C8C8;
        }
        .filter-btn.active {
            background: #333;
            color: white;
            border: 2px inset #666;
        }
        .attention-feed {
            padding: 15px;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        .attention-card {
            background: white;
        }
        .article-card {
            display: block;
            border: 1px solid #ccc;
            overflow: hidden;
            text-decoration: none;
            color: inherit;
            box-shadow: 1px 1px 0 #999;
        }
        .article-card:hover {
            box-shadow: 2px 2px 0 #666;
        }
        .og-image img {
            width: 100%;
            height: 180px;
            object-fit: cover;
            display: block;
        }
        .article-card-body {
            padding: 10px 12px;
        }
        .article-card-title {
            font-size: 15px;
            font-weight: bold;
            color: #000;
            margin-bottom: 4px;
        }
        .article-card-desc {
            font-size: 13px;
            color: #444;
            line-height: 1.4;
            margin-bottom: 6px;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }
        .article-card-meta {
            font-size: 12px;
            color: #888;
        }
        .date-separator {
            font-size: 11px;
            color: #888;
            text-transform: uppercase;
            letter-spacing: 1px;
            padding-bottom: 4px;
            border-bottom: 1px solid #ccc;
            font-family: 'Apple Garamond', Georgia, serif;
        }
        .pagination {
            padding: 12px 15px;
            background: #CCCCCC;
            border-top: 2px solid #999;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 6px;
            font-family: 'Apple Garamond', Georgia, serif;
            font-size: 13px;
        }
        .page-btn {
            padding: 3px 10px;
            background: #DDDDDD;
            border: 2px outset #EEEEEE;
            font-size: 12px;
            cursor: pointer;
            font-family: 'Apple Garamond', Georgia, serif;
        }
        .page-btn.active {
            background: #333;
            color: white;
            border: 2px inset #666;
        }
        .page-info {
            color: #444;
        }
        .hidden { display: none !important; }
    </style>
</head>
<body>
    <div id="page-container">
        <header id="main-header">
            <div class="logo-area">
                <img src="images/logo.png" alt="PJ Duffy Logo">
            </div>
            <div class="title-area">
                <h1>PJ Duffy's Home on the World Wide Web</h1>
            </div>
        </header>

        <div class="content-wrapper">
            <aside class="sidebar">
                <div class="sidebar-section main-nav">
                    <nav>
                        <ul>
                            <li><a href="/">Home</a></li>
                            <li><a href="/photos">Photos</a></li>
                            <li><a href="/quotes">Cool Quotes</a></li>
                            <li><a href="/reading-list">Books</a></li>
                            <li><a href="/thoughts">Thoughts</a></li>
                            <li><a href="/radar" class="active">Radar</a></li>
                        </ul>
                    </nav>
                </div>
            </aside>

            <main>
                <h2 class="page-title">Radar</h2>

                <div class="filter-bar">
                    <button class="filter-btn active" data-filter="all">All</button>
                    <button class="filter-btn" data-filter="article">Articles</button>
                    <button class="filter-btn" data-filter="bookmark">X Bookmarks</button>
                </div>

                <div class="attention-feed" id="attention-feed">
${cards}
                </div>

                <div class="pagination" id="pagination"></div>
            </main>
        </div>

        <div class="button-bar">
            <a href="https://letshum.com" target="_blank">PJ's Internet Services</a>
            <a href="mailto:pj.duffy4@gmail.com">Contact Me</a>
        </div>

        <footer id="main-footer">
            <p>&copy; 1994-2026 PJ Duffy - Best viewed with Netscape Navigator 4.0</p>
        </footer>
    </div>

    <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>
    <script>
    (function() {
        var ITEMS_PER_PAGE = ${ITEMS_PER_PAGE};
        var cards = Array.from(document.querySelectorAll('.attention-card'));
        var filterBtns = document.querySelectorAll('.filter-btn');
        var pagination = document.getElementById('pagination');
        var currentFilter = 'all';
        var currentPage = 1;

        function getFiltered() {
            if (currentFilter === 'all') return cards;
            return cards.filter(function(c) { return c.dataset.type === currentFilter; });
        }

        function render() {
            var filtered = getFiltered();
            var totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
            if (currentPage > totalPages) currentPage = totalPages;

            var start = (currentPage - 1) * ITEMS_PER_PAGE;
            var end = start + ITEMS_PER_PAGE;

            cards.forEach(function(c) { c.classList.add('hidden'); });
            filtered.slice(start, end).forEach(function(c) { c.classList.remove('hidden'); });

            while (pagination.firstChild) pagination.removeChild(pagination.firstChild);
            if (totalPages > 1) {
                var prevBtn = document.createElement('button');
                prevBtn.className = 'page-btn';
                prevBtn.textContent = '\u2190 Prev';
                prevBtn.disabled = currentPage === 1;
                prevBtn.onclick = function() { if (currentPage > 1) { currentPage--; render(); window.scrollTo(0, 0); } };
                pagination.appendChild(prevBtn);

                var info = document.createElement('span');
                info.className = 'page-info';
                info.textContent = 'Page ' + currentPage + ' of ' + totalPages;
                pagination.appendChild(info);

                var nextBtn = document.createElement('button');
                nextBtn.className = 'page-btn';
                nextBtn.textContent = 'Next \u2192';
                nextBtn.disabled = currentPage === totalPages;
                nextBtn.onclick = function() { if (currentPage < totalPages) { currentPage++; render(); window.scrollTo(0, 0); } };
                pagination.appendChild(nextBtn);
            }

            if (window.twttr && window.twttr.widgets) {
                window.twttr.widgets.load();
            }
        }

        filterBtns.forEach(function(btn) {
            btn.addEventListener('click', function() {
                filterBtns.forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                currentFilter = btn.dataset.filter;
                currentPage = 1;
                render();
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
  const bookmarks = await fetchXBookmarks();
  console.log('  ' + bookmarks.length + ' bookmarks');

  console.log('Fetching articles from Kindle worker...');
  const articles = await fetchArticles();
  console.log('  ' + articles.length + ' articles');

  // Sync articles to Google Sheet
  console.log('Syncing articles to Google Sheet...');
  await syncArticlesToSheet(articles);

  // Merge and sort by date descending
  var allItems = [...bookmarks, ...articles].sort(function(a, b) { return b.date.localeCompare(a.date); });
  console.log('Total items: ' + allItems.length);

  // Fetch OG metadata for articles
  console.log('Fetching OpenGraph metadata for articles...');
  for (const item of allItems) {
    if (item.type === 'article' && item.url) {
      const og = await fetchOgMetadata(item.url);
      item.ogImage = og.image || '';
      item.ogDescription = og.description || '';
      if (!item.title && og.title) item.title = og.title;
      if (!item.siteName && og.site_name) item.siteName = og.site_name;
    }
  }

  // Generate HTML
  console.log('Generating attention.html...');
  const html = generatePage(allItems);
  writeFileSync(OUTPUT_PATH, html);
  console.log('Written to ' + OUTPUT_PATH + ' (' + allItems.length + ' items)');
}

main().catch(function(err) {
  console.error('Build failed:', err);
  process.exit(1);
});
