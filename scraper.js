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

// আপনার সাইটের সাইডবারের সাথে হুবহু মিল রেখে ক্যাটাগরি নাম
const TARGET_SOURCES = [
  { name: 'Hoichoi', url: 'https://cinefreak.net/ott/hoichoi/', category: 'হইচই' },
  { name: 'Chorki', url: 'https://cinefreak.net/ott/chorki/', category: 'চরকি' },
  { name: 'Bongo BD', url: 'https://cinefreak.net/ott/bongo-bd/', category: 'বঙ্গ' },
  { name: 'Netflix', url: 'https://cinefreak.net/ott/netflix/', category: 'নেটফ্লিক্স' },
  { name: 'Latest Releases', url: 'https://cinefreak.net/', category: 'অ্যাকশন' }
];

async function runAutoBot() {
  let browser = null;
  try {
    console.log("ব্রাউজার চালু হচ্ছে...");
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    // ডাটাবেজের আগের মুভি তালিকা নেওয়া
    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val() || {};
    const existingTitles = Object.values(existingMovies).map(m => (m && m.title ? m.title.trim().toLowerCase() : ''));

    const candidateMovies = [];
    const seenLinks = new Set();

    // ৫টি প্ল্যাটফর্ম থেকে কনটেন্ট ও সঠিক ক্যাটাগরি নেওয়া
    for (const source of TARGET_SOURCES) {
      console.log(`স্ক্যান করা হচ্ছে: ${source.name} (${source.category})...`);
      try {
        await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await new Promise(r => setTimeout(r, 2000));

        const pageMovies = await page.evaluate((exactCat) => {
          const cards = document.querySelectorAll('a[href*="-movie-download"], a[href*="-web-series"]');
          const list = [];

          for (let card of cards) {
            let link = card.href;
            if (!link) continue;

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
              list.push({
                title: title.replace(/\s+/g, ' ').trim(),
                link: link,
                poster: poster,
                category: exactCat // নির্দিষ্ট ক্যাটাগরি সেট করা
              });
            }
            if (list.length >= 4) break;
          }
          return list;
        }, source.category);

        for (const item of pageMovies) {
          if (!seenLinks.has(item.link)) {
            seenLinks.add(item.link);
            if (!existingTitles.includes(item.title.toLowerCase())) {
              candidateMovies.push(item);
            }
          }
        }
      } catch (err) {
        console.log(`${source.name} স্ক্যান এরর: ${err.message}`);
      }
    }

    const finalNewMovies = candidateMovies.slice(0, 10);
    console.log(`মোট নতুন মুভি পাওয়া গেছে: ${finalNewMovies.length} টি`);

    if (finalNewMovies.length === 0) {
      console.log("নতুন কোনো মুভি নেই।");
      await browser.close();
      process.exit(0);
    }

    const readyToUpload = [];

    // প্লে বাটনে ক্লিক করে আসল আইফ্রেম বের করা
    for (let i = 0; i < finalNewMovies.length; i++) {
      const item = finalNewMovies[i];
      console.log(`[${i + 1}/${finalNewMovies.length}] পেজে ঢোকা হচ্ছে: ${item.title} -> [${item.category}]`);

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
          readyToUpload.push({
            title: item.title,
            category: item.category, // সঠিক ক্যাটাগরি
            poster: item.poster || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400",
            link: streamUrl
          });
        }
      } catch (err) {
        console.log(`ত্রুটি: ${item.title} -> ${err.message}`);
      }
    }

    await browser.close();

    // ফায়ারবেসে সঠিক ক্যাটাগরি দিয়ে সেভ করা
    console.log("ডাটাবেজে যুক্ত করা হচ্ছে...");
    const baseTime = Date.now();

    for (let i = 0; i < readyToUpload.length; i++) {
      const post = readyToUpload[i];
      const newId = baseTime + (readyToUpload.length - i) * 1000;

      const movieData = {
        id: newId,
        title: post.title,
        category: post.category, // হইচই, চরকি, বঙ্গ, নেটফ্লিক্স বা অ্যাকশন
        badge: "HD 1080p",
        rating: 4.9,
        views: "1.2k",
        likes: "600",
        poster: post.poster,
        desc: post.title + " - সরাসরি স্ট্রিমিং লিঙ্ক যুক্ত করা হয়েছে।",
        isFeatured: false,
        isPinned: false,
        isSeries: false,
        server1: post.link,
        server2: post.link,
        seasons: []
      };

      await db.ref('movies/' + newId).set(movieData);
      console.log(`যুক্ত হয়েছে: ${post.title} -> [${post.category}]`);
    }

    console.log("সব সফলভাবে আপলোড সম্পন্ন!");
    process.exit(0);

  } catch (error) {
    console.error("বট ত্রুটি: " + error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

runAutoBot();
