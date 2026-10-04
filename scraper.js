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

// আপনার পছন্দের ৫টি নির্দিষ্ট সোর্স ও সাইটের ক্যাটাগরি নাম
const TARGET_SOURCES = [
  { name: 'Latest Releases', url: 'https://cinefreak.net/', defaultCat: 'অ্যাকশন' },
  { name: 'Bongo BD', url: 'https://cinefreak.net/ott/bongo-bd/', defaultCat: 'বঙ্গ' },
  { name: 'Chorki', url: 'https://cinefreak.net/ott/chorki/', defaultCat: 'চরকি' },
  { name: 'Hoichoi', url: 'https://cinefreak.net/ott/hoichoi/', defaultCat: 'হইচই' },
  { name: 'Netflix', url: 'https://cinefreak.net/ott/netflix/', defaultCat: 'নেটফ্লিক্স' }
];

async function runAutoBot() {
  let browser = null;
  try {
    console.log("ক্রোম ব্রাউজার চালু করা হচ্ছে...");
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    // ১. ফায়ারবেস থেকে আগের থাকা সব মুভির নাম আনা (ডুপ্লিকেট এড়াতে)
    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val() || {};
    const existingTitles = Object.values(existingMovies).map(m => (m && m.title ? m.title.trim().toLowerCase() : ''));

    console.log(`ডাটাবেজে বর্তমানে মোট মুভি আছে: ${existingTitles.length} টি`);

    const candidateMovies = [];
    const seenLinks = new Set();

    // ২. নির্দিষ্ট ৫টি প্ল্যাটফর্ম থেকে কনটেন্ট সংগ্রহ
    for (const source of TARGET_SOURCES) {
      console.log(`\nস্ক্যান করা হচ্ছে: ${source.name} (${source.url})...`);
      try {
        await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await new Promise(r => setTimeout(r, 2000));

        const pageMovies = await page.evaluate((categoryName) => {
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
                category: categoryName
              });
            }
            if (list.length >= 6) break;
          }
          return list;
        }, source.defaultCat);

        for (const item of pageMovies) {
          if (!seenLinks.has(item.link)) {
            seenLinks.add(item.link);
            const isDuplicate = existingTitles.includes(item.title.toLowerCase());
            if (!isDuplicate) {
              candidateMovies.push(item);
            }
          }
        }
      } catch (err) {
        console.log(`${source.name} স্ক্যান করতে সমস্যা: ${err.message}`);
      }
    }

    // প্রথম ১০টি নতুন মুভি নির্বাচন
    const finalNewMovies = candidateMovies.slice(0, 10);
    console.log(`\n৫টি সোর্স মিলিয়ে মোট নতুন বাছাইকৃত কনটেন্ট: ${finalNewMovies.length} টি`);

    if (finalNewMovies.length === 0) {
      console.log("এই ৫টি প্ল্যাটফর্মে নতুন কোনো পোস্ট পাওয়া যায়নি (সবই ডাটাবেজে আগে থেকে আছে)।");
      await browser.close();
      process.exit(0);
    }

    const readyToUpload = [];

    // ৩. প্রতিটি মুভিতে ঢুকে প্লে বাটনে ক্লিক করে আসল আইফ্রেম লিংক নেওয়া
    for (let i = 0; i < finalNewMovies.length; i++) {
      const item = finalNewMovies[i];
      console.log(`\n[${i + 1}/${finalNewMovies.length}] পেজে ঢোকা হচ্ছে: ${item.title}`);

      try {
        await page.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.evaluate(() => window.scrollBy(0, 350));
        await new Promise(r => setTimeout(r, 2000));

        // #cfClickPlay বাটনে ক্লিক
        await page.evaluate(() => {
          const playBtn = document.querySelector('#cfClickPlay') || document.querySelector('.cf-click-play');
          if (playBtn) playBtn.click();
        });

        // প্লেয়ার লোড হওয়ার জন্য অপেক্ষা
        await new Promise(r => setTimeout(r, 3500));

        // #appStreamPlayer এর src সংগ্রহ
        let streamUrl = await page.evaluate(() => {
          const iframe = document.querySelector('#appStreamPlayer');
          if (iframe && iframe.src && !iframe.src.includes('about:blank')) {
            return iframe.src;
          }
          const anyVidzer = document.querySelector('iframe[src*="vidzer.me"]');
          if (anyVidzer) return anyVidzer.src;
          return '';
        });

        console.log(`-> উদ্ধারকৃত আসল ভিডিও লিঙ্ক: ${streamUrl}`);

        if (streamUrl && streamUrl.includes('vidzer.me')) {
          readyToUpload.push({
            title: item.title,
            category: item.category,
            poster: item.poster || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400",
            link: streamUrl
          });
        }
      } catch (err) {
        console.log(`লিঙ্ক সংগ্রহ করতে সমস্যা: ${item.title} -> ${err.message}`);
      }
    }

    await browser.close();

    // ৪. ফায়ারবেস ডাটাবেজে সিরিয়াল অনুযায়ী সেভ করা
    console.log(`\nমোট ${readyToUpload.length} টি মুভি ফায়ারবেসে যুক্ত করা হচ্ছে...`);
    const baseTime = Date.now();

    for (let i = 0; i < readyToUpload.length; i++) {
      const post = readyToUpload[i];
      // ১ নম্বর মুভি যেন পিন পোস্টের পরেই সবার উপরে থাকে
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
        desc: post.title + " - সরাসরি স্ট্রিমিং ও প্লেয়ার লিংক যুক্ত করা হয়েছে।",
        isFeatured: false,
        isPinned: false,
        isSeries: false,
        server1: post.link,
        server2: post.link,
        seasons: []
      };

      await db.ref('movies/' + newId).set(movieData);
      console.log(`[পজিশন ${i + 1}] যুক্ত হয়েছে: ${post.title} (${post.category})`);
    }

    console.log("\nসবগুলো কনটেন্ট সফলভাবে ডাটাবেজে যুক্ত সম্পন্ন হয়েছে!");
    process.exit(0);

  } catch (error) {
    console.error("Scraper Error: " + error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

runAutoBot();
