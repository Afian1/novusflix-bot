const axios = require('axios');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://cinewave-site-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// পেজের ভেতরে ঢুকে সরাসরি আসল প্লেয়ার আইফ্রেম লিঙ্ক বের করার ফাংশন
async function extractPlayerLink(postUrl) {
  try {
    const res = await axios.get(postUrl, {
      headers: { 
        'User-Agent': USER_AGENT,
        'Referer': 'https://cinefreak.net/'
      },
      timeout: 12000
    });
    const $ = cheerio.load(res.data);
    
    // appStreamPlayer অথবা সাধারণ iframe চেক
    let streamUrl = $('#appStreamPlayer').attr('src');
    if (!streamUrl) {
      streamUrl = $('iframe').attr('src');
    }
    
    if (streamUrl) {
      if (streamUrl.startsWith('//')) {
        streamUrl = 'https:' + streamUrl;
      }
      return streamUrl;
    }
    return postUrl;
  } catch (err) {
    return postUrl;
  }
}

async function syncCinefreak(existingTitles) {
  console.log("Cinefreak প্রথম পেজ স্ক্যান করা হচ্ছে...");
  try {
    const res = await axios.get('https://cinefreak.net/', {
      headers: { 
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 15000
    });
    const $ = cheerio.load(res.data);
    const newItems = [];

    // সিনেফ্রিকের কার্ড ও লিংক খোঁজা
    const movieCards = $('a[href*="-movie-download"], a[href*="-full-movie-download"], article, .post, .item');
    console.log("Cinefreak পেজে মোট উপাদান সনাক্ত হয়েছে: " + movieCards.length);

    const processedLinks = new Set();

    movieCards.each((i, el) => {
      let link = $(el).is('a') ? $(el).attr('href') :$(el).find('a').attr('href');
      
      // লিংক ভ্যালিডেশন
      if (!link || processedLinks.has(link)) return;
      if (!link.startsWith('http')) {
        link = 'https://cinefreak.net' + (link.startsWith('/') ? link : '/' + link);
      }

      // টাইটেল বের করা
      let title = $(el).find('h1, h2, h3, .title, .entry-title').text().trim();
      if (!title) {
        title = $(el).attr('title') \vert{}\vert{}$(el).find('img').attr('alt') || '';
      }
      title = title.replace(/\s+/g, ' ').trim();

      // পোস্টার ইমেজ বের করা
      let poster = $(el).find('img').attr('src');
      if (!poster) {
        poster = $(el).find('img').attr('data-src') \vert{}\vert{}$(el).find('img').attr('srcset');
      }
      if (poster && poster.includes(' ')) {
        poster = poster.split(' ')[0];
      }

      if (title && link) {
        processedLinks.add(link);
        const isDuplicate = existingTitles.includes(title.toLowerCase());
        if (!isDuplicate) {
          newItems.push({
            title: title,
            rawLink: link,
            poster: poster || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400",
            category: "সিনেমা"
          });
        }
      }
    });

    console.log(`Cinefreak থেকে নতুন মোট ${newItems.length} টি মুভি পাওয়া গেছে। প্লেয়ার লিঙ্ক সংগ্রহ শুরু হচ্ছে...`);

    // প্রতিটি মুভির ভেতরে ঢুকে প্লেয়ার লিংক সংগ্রহ
    for (let item of newItems) {
      console.log(`প্লেয়ার লিংক খোঁজা হচ্ছে: ${item.title}`);
      item.link = await extractPlayerLink(item.rawLink);
      // সার্ভার রেট লিমিট এড়াতে ছোট বিরতি
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return newItems;
  } catch (err) {
    console.log("Cinefreak ত্রুটি: " + err.message);
    return [];
  }
}

async function runAutoScraper() {
  try {
    console.log("বট কাজ শুরু করেছে...");

    // ফায়ারবেস থেকে আগের সংরক্ষিত মুভি তালিকা আনা
    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val() || {};
    const existingTitles = Object.values(existingMovies).map(m => {
      if (m && m.title) {
        return m.title.trim().toLowerCase();
      }
      return '';
    });

    console.log(`আপনার ডাটাবেজে বর্তমানে মোট মুভি আছে: ${existingTitles.length} টি`);

    // সিনেফ্রিক থেকে প্রথম পেজের সব কনটেন্ট আনা
    const allNewPosts = await syncCinefreak(existingTitles);

    if (allNewPosts.length === 0) {
      console.log("এই মুহূর্তে যোগ করার মতো কোনো নতুন কনটেন্ট নেই।");
      process.exit(0);
    }

    console.log(`মোট ${allNewPosts.length} টি নতুন মুভি ফায়ারবেসে যুক্ত করা হচ্ছে...`);

    for (const post of allNewPosts) {
      const newId = Date.now() + Math.floor(Math.random() * 1000);
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
      console.log(`সফলভাবে আপনার সাইটে যোগ হয়েছে: ${post.title}`);
    }

    console.log("প্রথম পেজের সব মুভি সফলভাবে সাইটে যুক্ত হয়েছে!");
    process.exit(0);
  } catch (error) {
    console.error("Scraper Error: " + error.message);
    process.exit(1);
  }
}

runAutoScraper();
