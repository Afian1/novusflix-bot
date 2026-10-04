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

async function runScraper() {
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

    console.log("Cinefreak হোমপেজে যাওয়া হচ্ছে...");
    await page.goto('https://cinefreak.net/', { waitUntil: 'networkidle2', timeout: 45000 });

    // ১. হোমপেজের লেটেস্ট রিলিজ থেকে মুভিগুলোর লিংক ও পোস্টার সংগ্রহ
    const movies = await page.evaluate(() => {
      const cards = document.querySelectorAll('a[href*="-movie-download"], a[href*="-web-series"]');
      const list = [];
      const seen = new Set();

      for (let card of cards) {
        let link = card.href;
        if (!link || seen.has(link)) continue;

        let title = '';
        const titleEl = card.querySelector('h2, h3, .title');
        if (titleEl) title = titleEl.innerText.trim();
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
          seen.add(link);
          list.push({ title: title.replace(/\s+/g, ' ').trim(), link, poster });
        }
        if (list.length >= 8) break; // প্রথম ৮টি মুভি
      }
      return list;
    });

    console.log("হোমপেজ থেকে মোট মুভি পাওয়া গেছে: " + movies.length + " টি");

    // ফায়ারবেস থেকে আগের সংরক্ষিত মুভি তালিকা আনা
    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val() || {};
    const existingTitles = Object.values(existingMovies).map(m => m && m.title ? m.title.trim().toLowerCase() : '');

    const newMoviesToProcess = movies.filter(m => !existingTitles.includes(m.title.toLowerCase()));

    if (newMoviesToProcess.length === 0) {
      console.log("নতুন কোনো মুভি পাওয়া যায়নি। সবই ডাটাবেজে ইতোমধ্যে বিদ্যমান।");
      await browser.close();
      process.exit(0);
    }

    console.log("নতুন " + newMoviesToProcess.length + " টি মুভিতে ঢুকে প্লেয়ার লিংক আনা হবে...");

    const finalResults = [];

    // ২. প্রতিটি মুভিতে ঢুকে #cfClickPlay বাটনে ক্লিক করে #appStreamPlayer এর src বের করা
    for (const item of newMoviesToProcess) {
      console.log("পেজে ঢোকা হচ্ছে: " + item.title);
      try {
        await page.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 35000 });

        // পেজ একটু স্ক্রল করা যাতে প্লেয়ার এলিমেন্ট রেন্ডার হয়
        await page.evaluate(() => window.scrollBy(0, 350));
        await new Promise(r => setTimeout(r, 2000));

        // আপনার ইনস্পেক্ট স্ক্রিনশটে পাওয়া #cfClickPlay বাটনে ক্লিক
        const isClicked = await page.evaluate(() => {
          const playBtn = document.querySelector('#cfClickPlay') || document.querySelector('.cf-click-play');
          if (playBtn) {
            playBtn.click();
            return true;
          }
          return false;
        });

        console.log("#cfClickPlay বাটনে ক্লিক হয়েছে? -> " + isClicked);

        // প্লেয়ারে আইফ্রেম লোড হওয়ার জন্য ৩ সেকেন্ড অপেক্ষা
        await new Promise(r => setTimeout(r, 3500));

        // #appStreamPlayer আইফ্রেম থেকে সরাসরি আসল ভিডিও লিংক নেওয়া
        let streamUrl = await page.evaluate(() => {
          const iframe = document.querySelector('#appStreamPlayer');
          if (iframe && iframe.src && !iframe.src.includes('about:blank')) {
            return iframe.src;
          }
          const anyIframe = document.querySelector('iframe[src*="vidzer.me"]');
          if (anyIframe) {
            return anyIframe.src;
          }
          return '';
        });

        console.log("উদ্ধারকৃত আসল ভিডিও প্লেয়ার লিঙ্ক: " + streamUrl);

        if (streamUrl && streamUrl.includes('vidzer.me')) {
          finalResults.push({
            title: item.title,
            poster: item.poster || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400",
            link: streamUrl
          });
        }
      } catch (err) {
        console.log("মুভি প্রক্রিয়াকরণে সমস্যা: " + item.title + " -> " + err.message);
      }
    }

    await browser.close();

    // ৩. ফায়ারবেসে ১ নম্বর মুভি সবার উপরে রেখে সেভ করা
    console.log("ডাটাবেজে মুভি সংরক্ষণ শুরু হচ্ছে...");
    const baseTime = Date.now();

    for (let i = 0; i < finalResults.length; i++) {
      const post = finalResults[i];
      const newId = baseTime + (finalResults.length - i) * 1000;

      const movieData = {
        id: newId,
        title: post.title,
        category: "সিনেমা",
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
      console.log(`[পজিশন ${i + 1}] ডাটাবেজে যুক্ত হয়েছে: ${post.title}`);
    }

    console.log("সবগুলো নতুন মুভি সফলভাবে আপনার সাইটে আপলোড সম্পন্ন!");
    process.exit(0);

  } catch (error) {
    console.error("Browser Scraper Error: " + error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

runScraper();
