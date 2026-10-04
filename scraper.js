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

// আসল প্লেয়ার লিঙ্ক খোঁজার ফাংশন
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

    // ১. data-src বা data-player অ্যাট্রিবিউট চেক
    $('iframe, #appStreamPlayer, div[data-src]').each((i, el) => {
      let s = $(el).attr('data-src') || $(el).attr('data-player') \vert{}\vert{}$(el).attr('src');
      if (s && !s.includes('about:blank') && s.length > 8) {
        streamUrl = s;
        return false;
      }
    });

    // ২. পেজের ভেতরের স্ক্রিপ্ট থেকে আসল স্ট্রিমিং লিঙ্ক বের করা
    if (!streamUrl) {
      const regexPatterns = [
        /https?:\/\/[^\s"'<>]*(?:vidzer|streamwish|filelions|dood|streamtape|embed|player)[^\s"'<>]+/gi,
        /(?:https?:)?\/\/[^\s"'<>]+\/xtream\?[^\s"'<>]+/gi
      ];

      for (let regex of regexPatterns) {
        const matches = html.match(regex);
        if (matches && matches.length > 0) {
          for (let m of matches) {
            if (!m.includes('facebook') && !m.includes('twitter') && !m.includes('wp-content')) {
              streamUrl = m;
              break;
            }
          }
        }
        if (streamUrl) break;
      }
    }

    if (!streamUrl || streamUrl.includes('about:blank')) {
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
    
    // পেজের প্রথম 'Latest Releases' গ্রিড সরাসরি টার্গেট করা
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

    console.log("হোমপেজে সনাক্তকৃত মোট কার্ড: " + releaseCards.length);

    for (let el of releaseCards) {
      let link = $(el).attr('href');
      if (!link) continue;

      if (!link.startsWith('http')) {
        link = 'https://cinefreak.net' + (link.startsWith('/') ? link : '/' + link);
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

    console.log("নতুন " + newItems.length + " টি কনটেন্ট পাওয়া গেছে। প্লেয়ার লিঙ্ক সংগ্রহ শুরু হচ্ছে...");

    for (let item of newItems) {
      console.log("লিঙ্ক খোঁজা হচ্ছে: " + item.title);
      item.link = await extractPlayerLink(item.rawLink);
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
      console.log("নতুন কোনো কনটেন্ট যোগ করার মতো পাওয়া যায়নি।");
      process.exit(0);
    }

    console.log("মোট " + allNewPosts.length + " টি নতুন মুভি সিরিয়াল অনুযায়ী সাজিয়ে সেভ করা হচ্ছে...");

    const baseTime = Date.now();

    // গুরুত্বপূর্ণ পরিবর্তন:
    // লুপটি এমনভাবে আইডি সেট করবে যাতে ১ নম্বর আইটেমটি (post[0])
    // সবার চেয়ে বড় আইডি পায়। ফলে সাইটে পিনের পরেই সবার প্রথমে ১ নম্বর মুভিটি বসবে!
    for (let i = 0; i < allNewPosts.length; i++) {
      const post = allNewPosts[i];
      
      // ক্রমিক মান যোগ করে ১ নম্বর মুভিকে সর্বোচ্চ আইডি দেওয়া হলো
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

    console.log("সিরিয়াল অনুযায়ী প্রথম পেজের সব মুভি সফলভাবে আপলোড সম্পন্ন!");
    process.exit(0);
  } catch (error) {
    console.error("Scraper Error: " + error.message);
    process.exit(1);
  }
}

runAutoScraper();
