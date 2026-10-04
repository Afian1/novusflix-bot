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

async function extractPlayerLink(postUrl) {
  try {
    const res = await axios.get(postUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    
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
  console.log("Cinefreak চেক করা হচ্ছে...");
  try {
    const res = await axios.get('https://cinefreak.net/', {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    const newItems = [];

    // পোস্ট খোঁজার জন্য ব্রড সিলেক্টর
    const foundElements = $('article, .post, .item, a[href*="/movie/"], a[href*="/series/"]');
    console.log("Cinefreak থেকে সম্ভাব্য মোট উপাদান পাওয়া গেছে: " + foundElements.length);

    $('article, .post-item, .entry-card, .post').slice(0, 8).each((i, el) => {
      const title = $(el).find('h1, h2, h3, .entry-title, .title').first().text().trim();
      let link = $(el).find('a').attr('href');
      let poster = $(el).find('img').attr('src');
      if (!poster) {
        poster = $(el).find('img').attr('data-src');
      }

      console.log(`[Cinefreak Item ${i + 1}] Title: ${title || 'Not found'} | Link: ${link || 'Not found'}`);

      if (title && link) {
        const isDuplicate = existingTitles.includes(title.toLowerCase());
        if (!isDuplicate) {
          newItems.push({ title: title, link: link, poster: poster, category: "এনিমে" });
        } else {
          console.log(`ডুপ্লিকেট স্কিপ করা হয়েছে: ${title}`);
        }
      }
    });

    for (let item of newItems) {
      console.log("ভিডিও প্লেয়ার লিঙ্ক খোঁজা হচ্ছে: " + item.title);
      item.link = await extractPlayerLink(item.link);
    }

    return newItems;
  } catch (err) {
    console.log("Cinefreak error: " + err.message);
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

    const foundElements = $('.item, article, .post, .movies-list .ml-item');
    console.log("HDMovie2 থেকে সম্ভাব্য মোট উপাদান পাওয়া গেছে: " + foundElements.length);

    $('.item, article, .post, .ml-item').slice(0, 8).each((i, el) => {
      const title = $(el).find('.title, h2, h3, .mli-info h2').first().text().trim();
      let link = $(el).find('a').attr('href');
      let poster = $(el).find('img').attr('src');
      if (!poster) {
        poster = $(el).find('img').attr('data-src');
      }

      console.log(`[HDMovie2 Item ${i + 1}] Title: ${title || 'Not found'} | Link: ${link || 'Not found'}`);

      if (title && link) {
        const isDuplicate = existingTitles.includes(title.toLowerCase());
        if (!isDuplicate) {
          newItems.push({ title: title, link: link, poster: poster, category: "অ্যাকশন" });
        } else {
          console.log(`ডুপ্লিকেট স্কিপ করা হয়েছে: ${title}`);
        }
      }
    });

    for (let item of newItems) {
      console.log("ভিডিও প্লেয়ার লিঙ্ক খোঁজা হচ্ছে: " + item.title);
      item.link = await extractPlayerLink(item.link);
    }

    return newItems;
  } catch (err) {
    console.log("HDMovie2 error: " + err.message);
    return [];
  }
}

async function runAutoScraper() {
  try {
    let selectedSource = process.env.SOURCE_CHOICE || 'both';
    console.log("বট চালু হয়েছে। সিলেক্টেড সোর্স: " + selectedSource);

    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val() || {};
    const existingTitles = Object.values(existingMovies).map(m => {
      if (m && m.title) {
        return m.title.trim().toLowerCase();
      }
      return '';
    });

    console.log(`ডাটাবেজে বর্তমানে মোট মুভি আছে: ${existingTitles.length} টি`);

    let allNewPosts = [];

    if (['cinefreak', 'both'].includes(selectedSource)) {
      const cinefreakPosts = await syncCinefreak(existingTitles);
      allNewPosts.push(...cinefreakPosts);
    }

    if (['hdmovie2', 'both'].includes(selectedSource)) {
      const hdmovie2Posts = await syncHDMovie2(existingTitles);
      allNewPosts.push(...hdmovie2Posts);
    }

    if (allNewPosts.length === 0) {
      console.log("এই মুহূর্তে কোনো নতুন কনটেন্ট পাওয়া যায়নি।");
      process.exit(0);
    }

    console.log(`মোট ${allNewPosts.length} টি নতুন কনটেন্ট যুক্ত করা হচ্ছে...`);

    for (const post of allNewPosts) {
      const newId = Date.now() + Math.floor(Math.random() * 1000);
      let finalPoster = post.poster || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400";

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
      console.log(`সফলভাবে ডাটাবেজে সেভ হয়েছে: ${post.title}`);
    }

    console.log("ডাটাবেজ আপডেট সম্পন্ন!");
    process.exit(0);
  } catch (error) {
    console.error("Scraper Error: " + error.message);
    process.exit(1);
  }
}

runAutoScraper();
