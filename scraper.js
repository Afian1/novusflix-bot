const puppeteer = require('puppeteer');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://cinewave-site-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();

// ক্রমধারা: হোমপেজের Latest Releases সবার আগে থাকবে
const TARGET_SOURCES = [
  { name: 'Latest Releases', url: 'https://cinefreak.net/', category: 'অ্যাকশন', limit: 10 },
  { name: 'Netflix', url: 'https://cinefreak.net/ott/netflix/', category: 'নেটফ্লিক্স', limit: 10 },
  { name: 'Bongo BD', url: 'https://cinefreak.net/ott/bongo-bd/', category: 'বঙ্গ', limit: 10 },
  { name: 'Chorki', url: 'https://cinefreak.net/ott/chorki/', category: 'চরকি', limit: 10 },
  { name: 'Hoichoi', url: 'https://cinefreak.net/ott/hoichoi/', category: 'হইচই', limit: 10 }
];

async function runAutoBot() {
  let browser = null;
  try {
    console.log("ব্রাউজার চালু করা হচ্ছে...");
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    // ডাটাবেজের আগের তালিকা নেওয়া (ডুপ্লিকেট এড়াতে)
    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val() || {};
    const existingTitles = Object.values(existingMovies).map(m => (m && m.title ? m.title.trim().toLowerCase() : ''));

    const candidateMovies = [];
    const seenLinks = new Set();

    // ১. প্রতিটি ক্যাটাগরি থেকে ১০টি করে নতুন কনটেন্ট নেওয়া
    for (const source of TARGET_SOURCES) {
      console.log(`\nস্ক্যান করা হচ্ছে: ${source.name} (${source.url})...`);
      try {
        await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await new Promise(r => setTimeout(r, 2000));

        const pageMovies = await page.evaluate((exactCat, maxLimit) => {
          // Latest Releases বা ক্যাটাগরির কার্ড লিস্ট নেওয়া
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

        let addedCount = 0;
        for (const item of pageMovies) {
          if (!seenLinks.has(item.link)) {
            seenLinks.add(item.link);
            if (!existingTitles.includes(item.title.toLowerCase())) {
              candidateMovies.push(item);
              addedCount++;
            }
          }
        }
        console.log(`-> ${source.name} থেকে নতুন বাছাই করা হয়েছে: ${addedCount} টি`);
      } catch (err) {
        console.log(`${source.name} স্ক্যান ত্রুটি: ${err.message}`);
      }
    }

    console.log(`\nমোট নতুন সংগৃহীত কনটেন্ট: ${candidateMovies.length} টি`);

    if (candidateMovies.length === 0) {
      console.log("নতুন কোনো মুভি নেই। সবই আগে থেকে ডাটাবেজে আছে।");
      await browser.close();
      process.exit(0);
    }

    const readyToUpload = [];

    // ২. প্রতিটি মুভির পেজে ঢুকে প্লে বাটনে ক্লিক করে আসল Vidzer আইফ্রেম লিংক বের করা
    for (let i = 0; i < candidateMovies.length; i++) {
      const item = candidateMovies[i];
      console.log(`\n[${i + 1}/${candidateMovies.length}] পেজে ঢোকা হচ্ছে: ${item.title} [${item.category}]`);

      try {
        await page.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.evaluate(() => window.scrollBy(0, 350));
        await new Promise(r => setTimeout(r, 2000));

        // #cfClickPlay বাটনে ক্লিক
        await page.evaluate(() => {
          const playBtn = document.querySelector('#cfClickPlay') || document.querySelector('.cf-click-play');
          if (playBtn) playBtn.click();
        });

        await new Promise(r => setTimeout(r, 3500));

        // আইফ্রেমের সোর্স সংগ্রহ
        let streamUrl = await page.evaluate(() => {
          const iframe = document.querySelector('#appStreamPlayer');
          if (iframe && iframe.src && !iframe.src.includes('about:blank')) return iframe.src;
          const anyVidzer = document.querySelector('iframe[src*="vidzer.me"]');
          if (anyVidzer) return anyVidzer.src;
          return '';
        });

        console.log(`-> প্লেয়ার লিঙ্ক: ${streamUrl}`);

        if (streamUrl && streamUrl.includes('vidzer.me')) {
          readyToUpload.push({
            title: item.title,
            category: item.category,
            poster: item.poster || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400",
            link: streamUrl
          });
        }
      } catch (err) {
        console.log(`ত্রুটি: ${item.title} -> ${err.message}`);
      }
    }

    await browser.close();

    // ৩. সিরিয়াল ঠিক রেখে ফায়ারবেসে সেভ করা (সিনেফ্রিকের ১ নম্বর যাতে সবার উপরে থাকে)
    console.log(`\nডাটাবেজে যুক্ত করা হচ্ছে (মোট ${readyToUpload.length} টি)...`);
    const baseTime = Date.now();

    for (let i = 0; i < readyToUpload.length; i++) {
      const post = readyToUpload[i];
      // ১ নম্বরের আইটেম যাতে সবচেয়ে বড় আইডি পায় (তাহলে সে সবার উপরে থাকবে)
      const newId = baseTime + (readyToUpload.length - i) * 1000;

      const movieData = {
        id: newId,
        title: post.title,
        category: post.category,
        badge: "HD 1080p",
        rating: 4.9,
        views: "1.2k",
        likes: "600",
        poster: post.poster,
        desc: post.title + " - সরাসরি স্ট্রিমিং ও প্লেয়ার লিঙ্ক যুক্ত করা হয়েছে।",
        isFeatured: false,
        isPinned: false,
        isSeries: false,
        server1: post.link,
        server2: post.link,
        seasons: []
      };

      await db.ref('movies/' + newId).set(movieData);
      console.log(`[পজিশন ${i + 1}] যুক্ত হয়েছে: ${post.title} -> [${post.category}]`);
    }

    console.log("\nসবগুলো ক্যাটাগরি সফলভাবে সিরিয়াল অনুযায়ী আপলোড সম্পন্ন!");
    process.exit(0);

  } catch (error) {
    console.error("বট ত্রুটি: " + error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

runAutoBot();
