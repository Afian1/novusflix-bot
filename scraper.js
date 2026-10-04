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

// ভিডিওতে দেখানো vidzer.me/xtream প্লেয়ার লিঙ্ক তৈরি করার নিখুঁত ফাংশন
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
    let finalStreamUrl = '';

    // ১. সরাসরি vidzer.me সম্পূর্ণ লিঙ্ক খোঁজা
    const directVidzerMatch = html.match(/https?:\/\/vidzer\.me\/xtream\?[^"'\s<>]+/i);
    if (directVidzerMatch) {
      finalStreamUrl = directVidzerMatch[0].replace(/&amp;/g, '&');
    }

    // ২. stream-api.php লিঙ্ক বের করে vidzer ফরম্যাটে রূপান্তর করা
    if (!finalStreamUrl) {
      const streamApiMatch = html.match(/https?:\/\/[^"'\s<>]*(?:stream-api\.php\?video=[^"'\s<>]+)/i);
      if (streamApiMatch) {
        let streamApiUrl = streamApiMatch[0].replace(/&amp;/g, '&');
        finalStreamUrl = 'https://vidzer.me/xtream?url=' + encodeURIComponent(streamApiUrl) + '&autoplay=1';
      }
    }

    // ৩. data-src বা data-player অ্যাট্রিবিউট চেক
    if (!finalStreamUrl) {
      $('#appStreamPlayer, iframe, div[data-src]').each((i, el) => {
        let s = $(el).attr('data-src');
        if (!s) s = $(el).attr('data-player');
        if (!s) s = $(el).attr('src');

        if (s && !s.includes('about:blank') && s.length > 10) {
          if (s.includes('vidzer.me')) {
            finalStreamUrl = s;
            return false;
          } else if (s.includes('stream-api.php')) {
            finalStreamUrl = 'https://vidzer.me/xtream?url=' + encodeURIComponent(s) + '&autoplay=1';
            return false;
          }
        }
      });
    }

    // ৪. যদি কোনো কিছুই না পাওয়া যায়
    if (!finalStreamUrl) {
      finalStreamUrl = postUrl;
    }

    return finalStreamUrl;
  } catch (err) {
    return postUrl;
  }
}

async function syncCinefreak(existingTitles) {
  console.log("Cinefreak হোমপেজের 'Latest Releases' স্ক্যান করা হচ্ছে...");
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
    
    // পেজের মূল গ্রিডের কার্ডগুলো সনাক্ত করা
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

    console.log("Latest Releases থেকে মোট কার্ড সনাক্ত: " + releaseCards.length);

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
      if (poster && poster.includes(' ')) {
        poster = poster.split(' ')[0];
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

    console.log("হোমপেজ থেকে সেরা " + newItems.length + " টি নতুন মুভি নেওয়া হয়েছে। প্লেয়ার লিঙ্ক সংগ্রহ শুরু হচ্ছে...");

    for (let item of newItems) {
      console.log("প্লেয়ার লিঙ্ক এক্সট্র্যাক্ট করা হচ্ছে: " + item.title);
      item.link = await extractPlayerLink(item.rawLink);
      console.log("-> প্রাপ্ত লিঙ্ক: " + item.link);
      await new Promise(resolve => setTimeout(resolve, 800));
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
      console.log("নতুন কোনো মুভি ডাটাবেজে যুক্ত করার মতো নেই।");
      process.exit(0);
    }

    console.log("মোট " + allNewPosts.length + " টি নতুন মুভি ডাটাবেজে যুক্ত করা হচ্ছে...");

    const baseTime = Date.now();

    for (let i = 0; i < allNewPosts.length; i++) {
      const post = allNewPosts[i];
      // ১ নম্বর মুভি যেন পিনের ঠিক পরেই সবার প্রথমে থাকে
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

    console.log("সবগুলো মুভি সফলভাবে আপলোড সম্পন্ন!");
    process.exit(0);
  } catch (error) {
    console.error("Scraper Error: " + error.message);
    process.exit(1);
  }
}

runAutoScraper();
