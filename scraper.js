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
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function syncCinefreak(existingTitles) {
  console.log("Checking Cinefreak...");
  try {
    const res = await axios.get('https://cinefreak.net/', {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    const newItems = [];

    $('article, .post-item, .entry-card').slice(0, 5).each((i, el) => {
      const title = $(el).find('h2, .entry-title, .title').text().trim();
      const link = $(el).find('a').attr('href');
      let poster = $(el).find('img').attr('src');
      if (!poster) {
        poster = $(el).find('img').attr('data-src');
      }

      if (title && link && !existingTitles.includes(title.toLowerCase())) {
        newItems.push({ title, link, poster, category: "এনিমে" });
      }
    });

    return newItems;
  } catch (err) {
    console.log("Cinefreak error:", err.message);
    return [];
  }
}

async function syncHDMovie2(existingTitles) {
  console.log("Checking HDMovie2...");
  try {
    const res = await axios.get('https://www.hdmovie2facts.com/', {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    const newItems = [];

    $('.item, article, .post').slice(0, 5).each((i, el) => {
      const title = $(el).find('.title, h2, h3').text().trim();
      const link = $(el).find('a').attr('href');
      let poster = $(el).find('img').attr('src');
      if (!poster) {
        poster = $(el).find('img').attr('data-src');
      }

      if (title && link && !existingTitles.includes(title.toLowerCase())) {
        newItems.push({ title, link, poster, category: "অ্যাকশন" });
      }
    });

    return newItems;
  } catch (err) {
    console.log("HDMovie2 error:", err.message);
    return [];
  }
}

async function runAutoScraper() {
  try {
    console.log("Starting Auto Scraper...");

    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val() || {};
    const existingTitles = Object.values(existingMovies).map(m => (m.title || '').trim().toLowerCase());

    const cinefreakPosts = await syncCinefreak(existingTitles);
    const hdmovie2Posts = await syncHDMovie2(existingTitles);
    const allNewPosts = [...cinefreakPosts, ...hdmovie2Posts];

    if (allNewPosts.length === 0) {
      console.log("No new movies found right now.");
      process.exit(0);
    }

    console.log("Found " + allNewPosts.length + " new items. Adding to database...");

    for (const post of allNewPosts) {
      const newId = Date.now() + Math.floor(Math.random() * 1000);
      let finalPoster = post.poster;
      if (!finalPoster) {
        finalPoster = "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400";
      }

      const movieData = {
        id: newId,
        title: post.title,
        category: post.category,
        badge: "HD 1080p",
        rating: 4.9,
        views: "1.2k",
        likes: "600",
        poster: finalPoster,
        desc: post.title + " - সরাসরি স্ট্রিমিং ও প্লেয়ার লিংক যুক্ত করা হয়েছে।",
        isFeatured: false,
        isPinned: false,
        isSeries: false,
        server1: post.link,
        server2: post.link,
        seasons: []
      };

      await db.ref('movies/' + newId).set(movieData);
      console.log("Added: " + post.title);
    }

    console.log("Auto sync completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Scraper Error:", error.message);
    process.exit(1);
  }
}

runAutoScraper();
