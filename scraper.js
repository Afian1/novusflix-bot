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

// পেজের ভেতরে ঢুকে আসল প্লেয়ারের আইফ্রেম লিঙ্ক বের করার ফাংশন
async function extractPlayerLink(postUrl) {
  try {
    const res = await axios.get(postUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    
    // স্ক্রিনশটের iframe#appStreamPlayer অথবা সাধারণ iframe চেক
    let streamUrl = $('#appStreamPlayer').attr('src') \vert{}\vert{} $('iframe').attr('src');
    
    if (streamUrl) {
      if (streamUrl.startsWith('//')) {
        streamUrl = 'https:' + streamUrl;
      }
      return streamUrl;
    }
    return postUrl; // আইফ্রেম না পেলে পেজ লিঙ্ক
  } catch (err) {
    return postUrl;
  }
}

async function syncCinefreak(existingTitles) {
  console.log("Cinefreak চেক করা হচ্ছে...");
  try {
    const res = await axios.get('https://cinefreak.net/', {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    const newItems = [];

    const posts = $('article, .post-item, .entry-card').slice(0, 5).toArray();

    for (const el of posts) {
      const title = $(el).find('h2, .entry-title, .title').text().trim();
      const link = $(el).find('a').attr('href');
      let poster = $(el).find('img').attr('src');
      if (!poster) {
        poster = $(el).find('img').attr('data-src');
      }

      if (title && link && !existingTitles.includes(title.toLowerCase())) {
        console.log(`Cinefreak থেকে ভিডিও লিঙ্ক খোঁজা হচ্ছে: ${title}`);
        const streamLink = await extractPlayerLink(link);
        newItems.push({ title, link: streamLink, poster, category: "এনিমে" });
      }
    }

    return newItems;
  } catch (err) {
    console.log("Cinefreak error:", err.message);
    return [];
  }
}

async function syncHDMovie2(existingTitles) {
  console.log("HDMovie2 চেক করা হচ্ছে...");
  try {
    const res = await axios.get('https://www.hdmovie2facts.com/', {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    const newItems = [];

    const posts = $('.item, article, .post').slice(0, 5).toArray();

    for (const el of posts) {
      const title = $(el).find('.title, h2, h3').text().trim();
      const link = $(el).find('a').attr('href');
      let poster = $(el).find('img').attr('src');
      if (!poster) {
        poster = $(el).find('img').attr('data-src');
      }

      if (title && link && !existingTitles.includes(title.toLowerCase())) {
        console.log(`HDMovie2 থেকে ভিডিও লিঙ্ক খোঁজা হচ্ছে: ${title}`);
        const streamLink = await extractPlayerLink(link);
        newItems.push({ title, link: streamLink, poster, category: "অ্যাকশন" });
      }
    }

    return newItems;
  } catch (err) {
    console.log("HDMovie2 error:", err.message);
    return [];
  }
}

async function runAutoScraper() {
  try {
    // গিটহাব থেকে পাঠানো চয়েস (cinefreak, hdmovie2, অথবা both)
    const selectedSource = process.env.SOURCE_CHOICE || 'both';
    console.log(`বট চালু হয়েছে। সিলেক্টেড সোর্স: ${selectedSource}`);

    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val() || {};
    const existingTitles = Object.values(existingMovies).map(m => (m.title || '').trim().toLowerCase());

    let allNewPosts = [];

    if (selectedSource === 'cinefreak' || selectedSource === 'both') {
      const cinefreakPosts = await syncCinefreak(existingTitles);
      allNewPosts.push(...cinefreakPosts);
    }

    if (selectedSource === 'hdmovie2' || selectedSource === 'both') {
      const hdmovie2Posts = await syncHDMovie2(existingTitles);
      allNewPosts.push(...hdmovie2Posts);
    }

    if (allNewPosts.length === 0) {
      console.log("এই মুহূর্তে কোনো নতুন কনটেন্ট পাওয়া যায়নি।");
      process.exit(0);
    }

    console.log(`মোট ${allNewPosts.length} টি নতুন কনটেন্ট পাওয়া গেছে। ডাটাবেজে যুক্ত করা হচ্ছে...`);

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
      console.log(`সফলভাবে যোগ হয়েছে: ${post.title}`);
    }

    console.log("ডাটাবেজ আপডেট সম্পন্ন!");
    process.exit(0);
  } catch (error) {
    console.error("Scraper Error:", error.message);
    process.exit(1);
  }
}

runAutoScraper();
