const axios = require('axios');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

// ফায়ারবেস কানেকশন সেটআপ
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://cinewave-site-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function syncCinefreak(existingTitles) {
  console.log("--> Cinefreak চেক করা হচ্ছে...");
  try {
    const { data: html } = await axios.get('https://cinefreak.net/', {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(html);
    const newItems = [];

    $('article, .post-item, .entry-card').slice(0, 5).each((i, el) => {
      const title = $(el).find('h2, .entry-title, .title').text().trim();
      const link = $(el).find('a').attr('href');
      const poster = $(el).find('img').attr('src') \vert{}\vert{}$(el).find('img').attr('data-src');

      if (title && link && !existingTitles.includes(title.toLowerCase())) {
        newItems.push({ title, link, poster, category: "এনিমে" });
      }
    });

    return newItems;
  } catch (err) {
    console.log("Cinefreak ফেচ এরর:", err.message);
    return [];
  }
}

async function syncHDMovie2(existingTitles) {
  console.log("--> HDMovie2 চেক করা হচ্ছে...");
  try {
    const { data: html } = await axios.get('https://www.hdmovie2facts.com/', {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(html);
    const newItems = [];

    $('.item, article, .post').slice(0, 5).each((i, el) => {
      const title = $(el).find('.title, h2, h3').text().trim();
      const link = $(el).find('a').attr('href');
      const poster = $(el).find('img').attr('src') \vert{}\vert{}$(el).find('img').attr('data-src');

      if (title && link && !existingTitles.includes(title.toLowerCase())) {
        newItems.push({ title, link, poster, category: "অ্যাকশন" });
      }
    });

    return newItems;
  } catch (err) {
    console.log("HDMovie2 ফেচ এরর:", err.message);
    return [];
  }
}

async function runAutoScraper() {
  try {
    console.log("নতুন কনটেন্ট খোঁজা শুরু হচ্ছে...");

    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val() || {};
    const existingTitles = Object.values(existingMovies).map(m => (m.title || '').trim().toLowerCase());

    const cinefreakPosts = await syncCinefreak(existingTitles);
    const hdmovie2Posts = await syncHDMovie2(existingTitles);
    const allNewPosts = [...cinefreakPosts, ...hdmovie2Posts];

    if (allNewPosts.length === 0) {
      console.log("কোনো নতুন কনটেন্ট পাওয়া যায়নি।");
      process.exit(0);
    }

    console.log(`মোট ${allNewPosts.length} টি নতুন কনটেন্ট পাওয়া গেছে। ডাটাবেজে যোগ করা হচ্ছে...`);

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
        poster: post.poster || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400",
        desc: post.title + " - সরাসরি স্ট্রিমিং লিংক যুক্ত করা হয়েছে।",
        isFeatured: false,
        isPinned: false,
        isSeries: false,
        server1: post.link,
        server2: post.link,
        seasons: []
      };

      await db.ref('movies/' + newId).set(movieData);
      console.log(`যুক্ত হয়েছে: ${post.title}`);
    }

    console.log("ডাটাবেজ আপডেট সম্পন্ন।");
    process.exit(0);
  } catch (error) {
    console.error("প্রধান ত্রুটি:", error.message);
    process.exit(1);
  }
}

runAutoScraper();
