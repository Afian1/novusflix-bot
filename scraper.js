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

async function extractPlayerLink(postUrl) {
  try {
    const res = await axios.get(postUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://cinefreak.net/'
      },
      timeout: 15000
    });

    const html = res.data;
    const $ = cheerio.load(html);
    let streamUrl = '';

    // ৩৪ নম্বর লাইনের ফরম্যাটিং এড়াতে আলাদা আলাদা if দিয়ে চেক করা হয়েছে
    $('iframe, #appStreamPlayer, div[data-src]').each((i, el) => {
      let s = $(el).attr('data-src');
      if (!s) {
        s = $(el).attr('data-player');
      }
      if (!s) {
        s = $(el).attr('src');
      }

      if (s) {
        if (!s.includes('about:blank')) {
          if (s.length > 8) {
            streamUrl = s;
            return false;
          }
        }
      }
    });

    if (!streamUrl) {
      const match = html.match(/https?:\/\/[^\s"'<>]*(?:vidzer|streamwish|filelions|dood|streamtape|embed|player)[^\s"'<>]+/i);
      if (match) {
        streamUrl = match[0];
      }
    }

    if (!streamUrl) {
      streamUrl = postUrl;
    }

    if (streamUrl.startsWith('//')) {
      streamUrl = 'https:' + streamUrl;
    }

    return streamUrl;
  } catch (err) {
    return postUrl;
  }
}

async function syncCinefreak(existingTitles) {
  console.log("Cinefreak হোমপেজ স্ক্যান করা হচ্ছে...");
  try {
    const res = await axios.get('https://cinefreak.net/', {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 15000
    });

    const $ = cheerio.load(res.data);
    const newItems = [];
    const processedLinks = new Set();

    let releaseCards = [];

    $('section, div, main').each((i, section) => {
      const heading = $(section).find('h1, h2, h3, .heading').first().text().toLowerCase();
      if (heading.includes('latest') || heading.includes('release')) {
        const cards = $(section).find('a[href*="-movie-download"], a[href*="-web-series"]');
        if (cards.length > 0) {
          releaseCards = cards.toArray();
          return false;
        }
      }
    });

    if (releaseCards.length === 0) {
      releaseCards = $('a[href*="-movie-download"], a[href*="-web-series"]').slice(0, 16).toArray();
    }

    console.log("মোট কার্ড পাওয়া গেছে: " + releaseCards.length);

    for (let el of releaseCards) {
      let link = $(el).attr('href');
      if (!link) continue;

      if (!link.startsWith('http')) {
        if (link.startsWith('/')) {
          link = 'https://cinefreak.net' + link;
        } else {
          link = 'https://cinefreak.net/' + link;
        }
      }

      if (processedLinks.has(link)) continue;

      let title = $(el).find('h2, h3, .title').text().trim();
      if (!title) title = $(el).attr('title');
      if (!title) title = $(el).find('img').attr('alt');
      if (!title) continue;

      title = title.replace(/\s+/g, ' ').trim();

      let poster = $(el).find('img').attr('src');
      if (!poster) poster = $(el).find('img').attr('data-src');
      if (!poster) poster = $(el).find('img').attr('srcset');

      if (poster) {
        if (poster.includes(' ')) {
          poster = poster.split(' ')[0];
        }
      }

      if (!poster) {
        poster = "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=400";
      }

      processedLinks.add(link);

      const isDuplicate = existingTitles.includes(title.toLowerCase());
      if (!isDuplicate) {
        newItems.push({
          title: title,
          rawLink: link,
          poster: poster,
          category: "সিনেমা"
        });
      }

      if (newItems.length >= 12) break;
    }

    console.log("নতুন " + newItems.length + " টি আইটেম পাওয়া গেছে। প্লেয়ার লিঙ্ক নেওয়া হচ্ছে...");

    for (let item of newItems) {
      console.log("লিঙ্ক খোঁজা হচ্ছে: " + item.title);
      item.link = await extractPlayerLink(item.rawLink);
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    return newItems;
  } catch (err) {
    console.log("ত্রুটি: " + err.message);
    return [];
  }
}

async function runAutoScraper() {
  try {
    console.log("বট কাজ শুরু করেছে...");

    const snapshot = await db.ref('movies').once('value');
    const existingMovies = snapshot.val();
    let existingTitles = [];
    if (existingMovies) {
      existingTitles = Object.values(existingMovies).map(m => {
        if (m && m.title) {
          return m.title.trim().toLowerCase();
        }
        return '';
      });
    }

    const allNewPosts = await syncCinefreak(existingTitles);

    if (allNewPosts.length === 0) {
      console.log("নতুন কোনো মুভি পাওয়া যায়নি।");
      process.exit(0);
    }

    console.log("মোট " + allNewPosts.length + " টি মুভি ফায়ারবেসে যুক্ত করা হচ্ছে...");

    const baseTime = Date.now();

    for (let i = 0; i < allNewPosts.length; i++) {
      const post = allNewPosts[i];
      const newId = baseTime + (allNewPosts.length - i) * 1000;

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
      console.log(`[পজিশন ${i + 1}] যুক্ত হয়েছে: ${post.title}`);
    }

    console.log("আপলোড সফলভাবে শেষ হয়েছে!");
    process.exit(0);
  } catch (error) {
    console.error("Scraper Error: " + error.message);
    process.exit(1);
  }
}

runAutoScraper();
