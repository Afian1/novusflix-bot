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

// ১. সিনেফ্রিক সোর্সসমূহ (এগুলো সবার শীর্ষে থাকবে)
const CINEFREAK_SOURCES = [
  { name: 'CineFreak Latest', url: 'https://cinefreak.net/', category: 'অ্যাকশন', limit: 10 },
  { name: 'CineFreak Netflix', url: 'https://cinefreak.net/ott/netflix/', category: 'নেটফ্লিক্স', limit: 10 },
  { name: 'CineFreak Bongo', url: 'https://cinefreak.net/ott/bongo-bd/', category: 'বঙ্গ', limit: 10 },
  { name: 'CineFreak Chorki', url: 'https://cinefreak.net/ott/chorki/', category: 'চরকি', limit: 10 },
  { name: 'CineFreak Hoichoi', url: 'https://cinefreak.net/ott/hoichoi/', category: 'হইচই', limit: 10 }
];

// ২. বিটবক্স প্রোভাইডার সোর্সসমূহ (এগুলো নেটফ্লিক্স ক্যাটাগরিতে যাবে এবং হোমপেজের শেষে থাকবে)
const VIDBOX_PROVIDERS = [
  { name: 'VidBox Netflix', url: 'https://vidbox.vc/provider/netflix', category: 'নেটফ্লিক্স', limit: 50 },
  { name: 'VidBox Hulu', url: 'https://vidbox.vc/provider/hulu', category: 'নেটফ্লিক্স', limit: 50 },
  { name: 'VidBox Prime Video', url: 'https://vidbox.vc/provider/amazon-prime-video', category: 'নেটফ্লিক্স', limit: 50 },
  { name: 'VidBox Disney Plus', url: 'https://vidbox.vc/provider/disney-plus', category: 'নেটফ্লিক্স', limit: 50 }
];

async function runAutoBot() {
  let browser = null;
  try {
    console.log("রিমোট ব্রাউজার চালু করা হচ্ছে...");
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    // ফায়ারবেসের বিদ্যমান কনটেন্ট নেওয়া (ডুপ্লিকেট এড়ানোর জন্য)
    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val() || {};
    const existingTitles = Object.values(existingMovies).map(m => (m && m.title ? m.title.trim().toLowerCase() : ''));

    const seenLinks = new Set();
    const cinefreakCandidates = [];
    const vidboxCandidates = [];

    // ==========================================
    // ধাপ ১: সিনেফ্রিক পর্যবেক্ষণ (Priority Top)
    // ==========================================
    console.log("\n--- [ধাপ ১] CineFreak পর্যবেক্ষণ শুরু হচ্ছে ---");
    for (const source of CINEFREAK_SOURCES) {
      console.log(`স্ক্যান হচ্ছে: ${source.name} (${source.url})...`);
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
    // ধাপ ২: বিটবক্স পর্যবেক্ষণ (VidBox Bottom)
    // ==========================================
    console.log("\n--- [ধাপ ২] VidBox প্রোভাইডার্স পর্যবেক্ষণ শুরু হচ্ছে ---");
    for (const source of VIDBOX_PROVIDERS) {
      console.log(`স্ক্যান হচ্ছে: ${source.name} (${source.url})...`);
      try {
        await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
        await new Promise(r => setTimeout(r, 2500));

        // ৫০টি করে কনটেন্ট লোড নিশ্চিত করতে হালকা স্ক্রোল
        await page.evaluate(() => window.scrollBy(0, 1500));
        await new Promise(r => setTimeout(r, 2000));

        const items = await page.evaluate((exactCat, maxLimit) => {
          // VidBox মুভি কার্ড সিলেক্টর
          const cards = document.querySelectorAll('a[href*="/watch/"], a[href*="/movie/"], a[href*="/tv/"]');
          const list = [];
          const localSeen = new Set();

          for (let card of cards) {
            let link = card.href;
            if (!link || localSeen.has(link)) continue;

            let title = '';
            const tEl = card.querySelector('.title, h3, h2, span.name');
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

    // ==========================================
    // ধাপ ৩: প্লেয়ার স্ট্রিমিং লিঙ্ক সংগ্রহ
    // ==========================================
    const readyCinefreak = [];
    const readyVidbox = [];

    // ৩.১ CineFreak প্লেয়ার লিঙ্ক বের করা
    console.log(`\nCineFreak মুভি পেজে ঢুকে প্লেয়ার লিঙ্ক সংগ্রহ করা হচ্ছে (মোট ${cinefreakCandidates.length} টি)...`);
    for (let i = 0; i < cinefreakCandidates.length; i++) {
      const item = cinefreakCandidates[i];
      try {
        await page.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.evaluate(() => window.scrollBy(0, 350));
        await new Promise(r => setTimeout(r, 2000));

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
          console.log(`[CineFreak OK] ${item.title}`);
        }
      } catch (err) {
        console.log(`CineFreak পেজ স্কিপ: ${item.title} -> ${err.message}`);
      }
    }

    // ৩.২ VidBox প্লেয়ার লিঙ্ক বের করা
    console.log(`\nVidBox মুভি পেজে ঢুকে প্লেয়ার লিঙ্ক সংগ্রহ করা হচ্ছে (মোট ${vidboxCandidates.length} টি)...`);
    for (let i = 0; i < vidboxCandidates.length; i++) {
      const item = vidboxCandidates[i];
      try {
        await page.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await new Promise(r => setTimeout(r, 3000));

        let streamUrl = await page.evaluate(() => {
          const iframe = document.querySelector('iframe');
          if (iframe && iframe.src) return iframe.src;
          return '';
        });

        if (!streamUrl) {
          // ডিরেক্ট ওয়াচ লিঙ্ক ব্যাকআপ
          streamUrl = item.link;
        }

        readyVidbox.push({
          title: item.title,
          category: item.category,
          poster: item.poster || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400",
          link: streamUrl
        });
        console.log(`[VidBox OK] ${item.title}`);
      } catch (err) {
        console.log(`VidBox পেজ স্কিপ: ${item.title} -> ${err.message}`);
      }
    }

    await browser.close();

    // ==========================================
    // ধাপ ৪: আইডি ও ক্রম সাজিয়ে ডাটাবেজে সংরক্ষণ
    // ==========================================
    console.log("\n--- ডাটাবেজে সিরিয়াল অনুযায়ী পুশ করা হচ্ছে ---");
    const currentTime = Date.now();

    // ১. CineFreak কনটেন্ট: বড় আইডি পাবে (তাই হোমপেজের শুরুতে থাকবে)
    for (let i = 0; i < readyCinefreak.length; i++) {
      const post = readyCinefreak[i];
      // সিনেফ্রিকের ১ নম্বর যাতে সবচেয়ে বড় আইডি পায়
      const newId = currentTime + (readyCinefreak.length - i) * 10000;

      const movieData = {
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
      };

      await db.ref('movies/' + newId).set(movieData);
      console.log(`[TOP] CineFreak: ${post.title} -> [${post.category}]`);
    }

    // ২. VidBox কনটেন্ট: ছোট আইডি পাবে (তাই হোমপেজের সব ভিডিওর একদম শেষে থাকবে)
    for (let i = 0; i < readyVidbox.length; i++) {
      const post = readyVidbox[i];
      // আইডি ছোট করার জন্য বিয়োগ করা হচ্ছে, ফলে এগুলো সবার নিচে জমা হবে
      const newId = currentTime - (1000000 + i * 1000);

      const movieData = {
        id: newId,
        title: post.title,
        category: post.category, // 'নেটফ্লিক্স'
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
      };

      await db.ref('movies/' + newId).set(movieData);
      console.log(`[BOTTOM] VidBox: ${post.title} -> [নেটফ্লিক্স]`);
    }

    console.log("\nস্বয়ংক্রিয় স্ক্র্যাপিং ও সাজানো সফলভাবে সম্পন্ন!");
    process.exit(0);

  } catch (error) {
    console.error("বট ত্রুটি: " + error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

runAutoBot();
