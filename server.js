require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { BitlyClient } = require('bitly');
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- OpenAI Setup ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


// --- Bitly Setup ---
const bitly = new BitlyClient(process.env.BITLY_TOKEN);

// --- YouTube API Setup ---
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// --- Google Sheets Setup (asynchronous authentication assumed) ---
let sheet = null, trackedSheet = null;
async function setupGoogleSheets() {
    const auth = new google.auth.GoogleAuth({
        keyFile: 'amazon-sales-bot-6e8b310afc02.json',
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    sheet = sheets.spreadsheets.values;
    trackedSheet = sheets.spreadsheets.values;
}
setupGoogleSheets();

// --- Utilities ---
async function shortenUrl(url) {
    try {
        const result = await bitly.shorten(url);
        return result.link;
    } catch (e) {
        return url;
    }
}

function extractVideoId(urlOrId) {
    const patterns = [
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const pattern of patterns) {
        const match = urlOrId.match(pattern);
        if (match) return match[1];
    }
    return null;
}

function extractHashtags(text) {
    return text.match(/#\w+/g) || [];
}

function extractCtasAndLinks(text) {
    const links = [];
    const ctas = [];
    const ctaKeywords = ['subscribe', 'follow', 'like', 'share', 'check out', 'buy', 'visit'];
    text.split('\n').forEach(line => {
        (line.match(/https?:\/\/\S+/g) || []).forEach(url => links.push(url));
        if (ctaKeywords.some(word => line.toLowerCase().includes(word)))
            ctas.push(line.trim());
    });
    return [links, ctas];
}

// Fetch YouTube Comments
async function fetchComments(videoId, maxComments = 30) {
    try {
        const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=${Math.min(maxComments,100)}&textFormat=plainText&key=${YOUTUBE_API_KEY}`;
        const { data } = await axios.get(url);
        return data.items.map(item => item.snippet.topLevelComment.snippet.textDisplay);
    } catch (e) {
        return [];
    }
}

// --- API Endpoints ---
// Health check
app.get('/', (req, res) => res.json({ status: 'running' }));

// YouTube Analysis
app.post('/youtube', async (req, res) => {
    const { videoLink } = req.body;
    const videoId = extractVideoId(videoLink || '');
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or ID.' });

    try {
        // Fetch video metadata
        const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`;
        const { data } = await axios.get(videoUrl);
        const video = data.items?.[0];
        if (!video) return res.status(404).json({ error: 'Video not found.' });
        const { snippet, statistics, contentDetails } = video;

        // Duration (ISO 8601 to seconds)
        const iso8601duration = contentDetails.duration;
        // Convert ISO 8601 duration to seconds
        function iso8601toSeconds(iso) {
            try {
                // regex parse for PThHmMsS
                const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso)||[];
                let h = parseInt(m[1]||0), mm = parseInt(m[2]||0), s = parseInt(m[3]||0);
                return h*3600 + mm*60 + s;
            } catch(_) { return 0; }
        }
        const durationSec = iso8601toSeconds(iso8601duration);

        // Fetch comments
        const comments = await fetchComments(videoId);

        // Prepare prompt & call OpenAI
        const hashtagsTitle = extractHashtags(snippet.title);
        const hashtagsDesc = extractHashtags(snippet.description);
        const allHashtags = [...new Set([...hashtagsTitle, ...hashtagsDesc])];
        const [links, ctas] = extractCtasAndLinks(snippet.description);

        const prompt = `
You are a YouTube Shorts expert. Analyze the following video metadata and real audience comments. Provide structured, actionable feedback with the following sections:

1. Hook Strength – Is the intro engaging? Suggest improvements.
2. Pacing & Cuts – Is the pacing effective? Recommend changes.
3. Loop Potential – Could the video be structured to encourage replays?
4. Script/Title Optimization – Suggest 1-2 better titles.
5. Hashtag Use – Are the hashtags relevant and optimized?
6. CTAs & Links – Highlight any calls to action or promotional links.
7. Audience Feedback – Summarize recurring themes from comments.

Title: ${snippet.title}
Description: ${snippet.description.slice(0,300)}...
Duration: ${durationSec} seconds
Views: ${statistics.viewCount}
Likes: ${statistics.likeCount}
Comments: ${statistics.commentCount}
Hashtags: ${(allHashtags.length ? allHashtags.join(' ') : 'None')}
CTAs: ${(ctas.length ? ctas.join(', ') : 'None')}
Links: ${(links.length ? links.join(', ') : 'None')}

Sample Comments:
${comments.slice(0,10).join('\n')}
        `.trim();

        const gptRes = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{ role: 'system', content: prompt }],
            max_tokens: 600,
            temperature: 0.7
        });
        const aiSuggestions = gptRes.data.choices[0].message.content.trim();

        res.json({
            metadata: {
                title: snippet.title,
                publishedAt: snippet.publishedAt,
                description: snippet.description,
                durationSec,
                views: statistics.viewCount,
                likes: statistics.likeCount,
                comments: statistics.commentCount,
            },
            aiSuggestions
        });

    } catch (e) {
        res.status(500).json({ error: 'Failed to analyze video.', details: ''+e });
    }
});

// Amazon product search (stub - you need to integrate real Amazon PAAPI or third party SDK)
app.post('/search', async (req, res) => {
    const { query } = req.body;
    // -- Integrate Amazon PAAPI as needed --
    res.json({
        message: 'Amazon search integration to be implemented.',
        query
    });
});

// OpenAI ChatGPT assistant
app.post('/chat', async (req, res) => {
    try {
        console.log("================>",req.body)
        const { userMessage, chatHistory } = req.body;
        const systemPrompt = `
You are VPREME, a helpful, friendly, witty AI shopping assistant for Telegram. Greet users warmly and use emojis where appropriate. When asked for products, search Amazon and present the best options in a concise, upbeat way. If nothing is found, apologize politely and reassure the user their request is logged for improvement. If a user asks to track a product, confirm in a helpful, positive tone. Respond to gratitude with cheerfulness. If asked about affiliate links, be transparent and reassuring. Keep responses short, clear, and human-like. Always sound like a personal shopping assistant, not a generic bot.
`.trim();
        const messages = [{ role: 'system', content: systemPrompt }];
        if (chatHistory) messages.push(...chatHistory);
        messages.push({ role: 'user', content: userMessage });
        const gptRes = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages,
            max_tokens: 300,
            temperature: 0.8
        });
        res.json({ reply: gptRes.data.choices[0].message.content.trim() });
    } catch (e) {
        res.status(500).json({ error: "OpenAI error.", details: ''+e });
    }
});

// URL Shortener
app.post('/shorten', async (req, res) => {
    const { url } = req.body;
    res.json({ original: url, short: await shortenUrl(url) });
});

// Google Sheets logging (stub: implement production appends here)
app.post('/log', async (req, res) => {
    // Implement logging logic with sheet.append API as per your needs
    res.json({ message: 'Log feature placeholder.' });
});

// --- Start server ---
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
