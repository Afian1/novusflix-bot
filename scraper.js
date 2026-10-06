const puppeteer = require('puppeteer');
const admin = require('firebase-admin');

// গিটহাব সিক্রেটস থেকে ফায়ারবেস সার্ভিস অ্যাকাউন্ট কী লোড
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://cinewave-site-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();

// ১. সিনেফ্রিক সোর্সসমূহ (হোমপেজের শীর্ষে থাকবে)
const CINEFREAK_SOURCES = [
  { name: 'CineFreak Latest', url: 'https://cinefreak.net/', category: 'অ্যাকশন', limit: 10 },
  { name: 'CineFreak Netflix', url: 'https://cinefreak.net/ott/netflix/', category: 'নেটফ্লিক্স', limit: 10 },
  { name: 'CineFreak Bongo', url: 'https://cinefreak.net/ott/bongo-bd/', category: 'বঙ্গ', limit: 10 },
  { name: 'CineFreak Chorki', url: 'https://cinefreak.net/ott/chorki/', category: 'চরকি', limit: 10 },
  { name: 'CineFreak Hoichoi', url: 'https://cinefreak.net/ott/hoichoi/', category: 'হইচই', limit: 10 }
];

// ২. বিটবক্স প্রোভাইডার সোর্সসমূহ (হোমপেজের শেষে থাকবে, নেটফ্লিক্স ক্যাটাগরি)
const VIDBOX_PROVIDERS = [
  { name: 'VidBox Netflix', url: 'https://vidbox.vc/search?page=1&watch_provider=8', category: 'নেটফ্লিক্স', limit: 50 },
  { name: 'VidBox Amazon Prime', url: 'https://vidbox.vc/search?page=1&watch_provider=9', category: 'নেটফ্লিক্স', limit: 50 },
  { name: 'VidBox Hulu', url: 'https://vidbox.vc/search?page=1&watch_provider=15', category: 'নেটফ্লিক্স', limit: 50 },
  { name: 'VidBox Disney Plus', url: 'https://vidbox.vc/search?page=1&watch_provider=337', category: 'নেটফ্লিক্স', limit: 50 }
];

async function runAutoBot() {
  let browser = null;
  try {
    console.log("রিমোট ব্রাউজার চালু করা হচ্ছে...");
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    // ফায়ারবেসের বিদ্যমান কনটেন্ট নেওয়া
    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val() || {};
    const existingTitles = Object.values(existingMovies).map(m => (m && m.title ? m.title.trim().toLowerCase() : ''));

    const seenLinks = new Set();
    const cinefreakCandidates = [];
    const vidboxCandidates = [];

    // ==========================================
    // ধাপ ১: সিনেফ্রিক পর্যবেক্ষণ (CineFreak)
    // ==========================================
    console.log("\n--- [ধাপ ১] CineFreak পর্যবেক্ষণ শুরু হচ্ছে ---");
    for (const source of CINEFREAK_SOURCES) {
      console.log(`স্ক্যান হচ্ছে: ${source.name}...`);
      try {
        await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await new Promise(r => setTimeout(r, 2000));

        const items = await page.evaluate((exactCat, maxLimit) => {
          const cards = document.querySelectorAll('a[href*="-movie-download"], a[href*="-web-series"]');
          const list = [];
          const localSeen = new Set();

          for (let card of cards) {
            let link = card.href;
            if (!link || localSeen.has(link)) continue;

            let title = '';
            const tEl = card.querySelector('h2, h3, .title');
            if (tEl) title = tEl.innerText.trim();
            if (!title) title = card.getAttribute('title') || '';
            if (!title) {
              const img = card.querySelector('img');
              if (img) title = img.getAttribute('alt') || '';
            }

            let poster = '';
            const img = card.querySelector('img');
            if (img) {
              poster = img.src || img.getAttribute('data-src') || '';
            }

            if (title && link) {
              localSeen.add(link);
              list.push({
                title: title.replace(/\s+/g, ' ').trim(),
                link: link,
                poster: poster,
                category: exactCat
              });
            }
            if (list.length >= maxLimit) break;
          }
          return list;
        }, source.category, source.limit);

        let added = 0;
        for (const item of items) {
          if (!seenLinks.has(item.link)) {
            seenLinks.add(item.link);
            if (!existingTitles.includes(item.title.toLowerCase())) {
              cinefreakCandidates.push(item);
              added++;
            }
          }
        }
        console.log(`-> CineFreak থেকে নতুন পাওয়া গেছে: ${added} টি`);
      } catch (err) {
        console.log(`CineFreak এরর (${source.name}): ${err.message}`);
      }
    }

    // ==========================================
    // ধাপ ২: বিটবক্স পর্যবেক্ষণ (VidBox Exact HTML Parsed)
    // ==========================================
    console.log("\n--- [ধাপ ২] VidBox প্রোভাইডার্স পর্যবেক্ষণ শুরু হচ্ছে ---");
    for (const source of VIDBOX_PROVIDERS) {
      console.log(`স্ক্যান হচ্ছে: ${source.name}...`);
      try {
        await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 40000 });

        // বিটবক্সের কার্ড লোড হওয়া নিশ্চিত করা
        try {
          await page.waitForSelector('a[href^="/movie/"], a[href^="/tv/"]', { timeout: 8000 });
        } catch (e) {
          console.log("কার্ড লোড হতে বাড়তি সময় নিচ্ছে, স্ক্রোল ট্রাই করা হচ্ছে...");
        }

        await page.evaluate(() => window.scrollBy(0, 1000));
        await new Promise(r => setTimeout(r, 2000));

        // আপনার দেওয়া আসল HTML স্ট্রাকচার অনুযায়ী এক্সট্রাকশন
        const items = await page.evaluate((exactCat, maxLimit) => {
          const cards = document.querySelectorAll('a[href^="/movie/"], a[href^="/tv/"]');
          const list = [];
          const localSeen = new Set();

          for (let card of cards) {
            let link = card.href;
            if (!link || localSeen.has(link)) continue;

            const img = card.querySelector('img');
            let title = '';
            let poster = '';

            if (img) {
              title = img.getAttribute('alt') || '';
              let rawSrc = img.src || img.getAttribute('data-src') || '';
              
              // wsrv.nl ডিকোড করে মূল TMDB হাই রেজুলিউশন বের করা
              if (rawSrc.includes('wsrv.nl') && rawSrc.includes('url=')) {
                try {
                  const urlParam = rawSrc.split('url=')[1].split('&')[0];
                  poster = decodeURIComponent(urlParam).replace('/w342/', '/w500/');
                } catch (e) {
                  poster = rawSrc;
                }
              } else {
                poster = rawSrc;
              }
            }

            if (title && link) {
              localSeen.add(link);
              list.push({
                title: title.trim(),
                link: link,
                poster: poster,
                category: exactCat
              });
            }
            if (list.length >= maxLimit) break;
          }
          return list;
        }, source.category, source.limit);

        let added = 0;
        for (const item of items) {
          if (!seenLinks.has(item.link)) {
            seenLinks.add(item.link);
            if (!existingTitles.includes(item.title.toLowerCase())) {
              vidboxCandidates.push(item);
              added++;
            }
          }
        }
        console.log(`-> VidBox থেকে নতুন পাওয়া গেছে: ${added} টি`);
      } catch (err) {
        console.log(`VidBox এরর (${source.name}): ${err.message}`);
      }
    }

    const readyCinefreak = [];
    const readyVidbox = [];

    // ==========================================
    // ধাপ ৩.১: CineFreak প্লেয়ার আইফ্রেম
    // ==========================================
    if (cinefreakCandidates.length > 0) {
      console.log(`\nCineFreak প্লেয়ার লিঙ্ক সংগ্রহ করা হচ্ছে (মোট ${cinefreakCandidates.length} টি)...`);
      for (let i = 0; i < cinefreakCandidates.length; i++) {
        const item = cinefreakCandidates[i];
        try {
          await page.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 35000 });
          await new Promise(r => setTimeout(r, 1500));

          await page.evaluate(() => {
            const playBtn = document.querySelector('#cfClickPlay') || document.querySelector('.cf-click-play');
            if (playBtn) playBtn.click();
          });
          await new Promise(r => setTimeout(r, 3500));

          let streamUrl = await page.evaluate(() => {
            const iframe = document.querySelector('#appStreamPlayer');
            if (iframe && iframe.src && !iframe.src.includes('about:blank')) return iframe.src;
            const anyVidzer = document.querySelector('iframe[src*="vidzer.me"]');
            if (anyVidzer) return anyVidzer.src;
            return '';
          });

          if (streamUrl && streamUrl.includes('vidzer.me')) {
            readyCinefreak.push({
              title: item.title,
              category: item.category,
              poster: item.poster || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400",
              link: streamUrl
            });
            console.log(`[CineFreak OK] -> ${item.title}`);
          }
        } catch (err) {
          console.log(`CineFreak স্কিপ: ${item.title}`);
        }
      }
    }

    // ==========================================
    // ধাপ ৩.২: VidBox nxsha.space প্লেয়ার আইফ্রেম
    // ==========================================
    if (vidboxCandidates.length > 0) {
      console.log(`\nVidBox প্লেয়ার লিঙ্ক সংগ্রহ করা হচ্ছে (মোট ${vidboxCandidates.length} টি)...`);
      for (let i = 0; i < vidboxCandidates.length; i++) {
        const item = vidboxCandidates[i];
        try {
          await page.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 35000 });
          
          // আইফ্রেম লোড হওয়া পর্যন্ত ওয়েট
          try {
            await page.waitForSelector('iframe[src*="nxsha.space"], iframe', { timeout: 8000 });
          } catch(e) {}

          let streamUrl = await page.evaluate(() => {
            const nx = document.querySelector('iframe[src*="nxsha.space"]');
            if (nx && nx.src) return nx.src;
            const emb = document.querySelector('iframe[src*="/embed/"]');
            if (emb && emb.src) return emb.src;
            const anyIframe = document.querySelector('iframe');
            if (anyIframe && anyIframe.src && !anyIframe.src.includes('about:blank')) return anyIframe.src;
            return '';
          });

          if (!streamUrl) streamUrl = item.link;

          readyVidbox.push({
            title: item.title,
            category: item.category,
            poster: item.poster || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400",
            link: streamUrl
          });
          console.log(`[VidBox OK] -> ${item.title} (Stream: ${streamUrl})`);
        } catch (err) {
          console.log(`VidBox স্কিপ: ${item.title}`);
        }
      }
    }

    await browser.close();

    // ==========================================
    // ধাপ ৪: ডাটাবেজে সঠিক সিরিয়ালে পুশ
    // ==========================================
    console.log("\n--- ডাটাবেজে আপলোড করা হচ্ছে ---");
    const currentTime = Date.now();

    // ১. CineFreak -> শীর্ষে বসবে (বড় আইডি)
    for (let i = 0; i < readyCinefreak.length; i++) {
      const post = readyCinefreak[i];
      const newId = currentTime + (readyCinefreak.length - i) * 10000;

      await db.ref('movies/' + newId).set({
        id: newId,
        title: post.title,
        category: post.category,
        badge: "HD 1080p",
        rating: 4.9,
        views: "1.2k",
        likes: "600",
        poster: post.poster,
        desc: post.title + " - সরাসরি স্ট্রিমিং লিঙ্ক যুক্ত করা হয়েছে।",
        isFeatured: false,
        isPinned: false,
        isSeries: false,
        server1: post.link,
        server2: post.link,
        seasons: []
      });
      console.log(`[TOP] CineFreak: ${post.title}`);
    }

    // ২. VidBox -> শেষে বসবে (ছোট আইডি)
    for (let i = 0; i < readyVidbox.length; i++) {
      const post = readyVidbox[i];
      const newId = currentTime - (1000000 + i * 1000);

      await db.ref('movies/' + newId).set({
        id: newId,
        title: post.title,
        category: post.category,
        badge: "WEB-DL",
        rating: 4.8,
        views: "800",
        likes: "450",
        poster: post.poster,
        desc: post.title + " - VidBox স্ট্রিমিং কালেকশন।",
        isFeatured: false,
        isPinned: false,
        isSeries: false,
        server1: post.link,
        server2: post.link,
        seasons: []
      });
      console.log(`[BOTTOM] VidBox: ${post.title}`);
    }

    console.log("\nসবকিছু সফলভাবে সম্পন্ন হয়েছে!");
    process.exit(0);

  } catch (error) {
    console.error("বট ত্রুটি: " + error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

runAutoBot();
