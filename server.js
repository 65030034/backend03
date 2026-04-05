const express = require('express');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const NodeCache = require("node-cache"); 

const app = express();
const myCache = new NodeCache({ stdTTL: 120 }); 
const IMAP_HOST = 'mail.socialgrid.mom'; // 📌 โฮสต์ของเว็บที่ 1 (smtp.dev)

app.use(cors({
    origin: [
        'http://localhost:5173', 
        'http://127.0.0.1:5173',
        'https://unipony-03.netlify.app'
    ], 
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-imap-user', 'x-imap-pass'], 
    credentials: true
}));

app.use(express.json());

const activeClients = new Map();

function resetIdleTimer(user, client) {
    if (client.idleTimer) clearTimeout(client.idleTimer);
    
    client.idleTimer = setTimeout(async () => {
        try { await client.logout(); } catch (e) {}
        activeClients.delete(user);
    }, 5 * 60 * 1000);
}

async function getImapClient(user, pass) {
    if (!user || !pass) throw new Error('Missing Credentials');

    if (activeClients.has(user)) {
        const existingClient = activeClients.get(user);
        if (existingClient.usable) {
            resetIdleTimer(user, existingClient); 
            return existingClient;
        } else {
            activeClients.delete(user); 
        }
    }

    const client = new ImapFlow({ 
        host: IMAP_HOST, 
        port: 993, 
        secure: true, 
        auth: { user, pass }, 
        logger: false, 
        connectionTimeout: 15000 
    });

    await client.connect();
    activeClients.set(user, client);
    resetIdleTimer(user, client);

    client.on('close', () => activeClients.delete(user));
    client.on('error', () => activeClients.delete(user));

    return client;
}

// ----------------------------------------------------
// ROUTES
// ----------------------------------------------------

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        await getImapClient(email, password);
        res.json({ success: true });
    } catch (err) { 
        res.status(401).json({ success: false, error: err.message }); 
    }
});

app.get('/api/folders', async (req, res) => {
    const user = req.headers['x-imap-user'];
    const pass = req.headers['x-imap-pass'];
    const cacheKey = `folders_${user}`; 

    if (myCache.has(cacheKey)) return res.json(myCache.get(cacheKey));

    try {
        const client = await getImapClient(user, pass);
        let folders = await client.list();
        
        const responseData = { success: true, data: folders.map(f => ({ name: f.name, path: f.path })) };
        myCache.set(cacheKey, responseData);
        res.json(responseData);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/emails', async (req, res) => {
    const user = req.headers['x-imap-user'];
    const pass = req.headers['x-imap-pass'];
    const folderPath = req.query.folder || 'INBOX';
    const cacheKey = `emails_${user}_${folderPath}`; 

    if (myCache.has(cacheKey)) return res.json(myCache.get(cacheKey));

    try {
        const freshClient = new ImapFlow({ 
            host: IMAP_HOST, 
            port: 993, 
            secure: true, 
            auth: { user, pass }, 
            logger: false, 
            connectionTimeout: 15000 
        });

        await freshClient.connect();
        let lock = await freshClient.getMailboxLock(folderPath); 
        try {
            // 🚨 อัปเกรด: ค้นหาโดยบังคับขอ UID ตรงๆ เพื่อไม่ให้เซิร์ฟเวอร์คาย Sequence Number มาให้
            let searchResult = await freshClient.search({ all: true }, { uid: true }); 

            if (!searchResult || searchResult.length === 0) {
                return res.json({ success: true, data: [] });
            }

            let emails = [];
            // ดึง 15 ฉบับล่าสุดมาแสดง
            let latestUids = searchResult.slice(-15); 
            
            for await (let msg of freshClient.fetch(latestUids, { envelope: true, uid: true })) {
                emails.push({
                    uid: msg.uid,
                    subject: msg.envelope.subject || '(No Subject)',
                    from: msg.envelope.from?.[0]?.address || 'Unknown',
                    date: msg.envelope.date
                });
            }
            
            const responseData = { success: true, data: emails.reverse() };
            myCache.set(cacheKey, responseData, 5); 
            res.json(responseData);
        } finally { 
            lock.release(); 
            await freshClient.logout(); 
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/email-content', async (req, res) => {
    const user = req.headers['x-imap-user'];
    const pass = req.headers['x-imap-pass'];
    const { folder, uid } = req.query;
    const cacheKey = `content_${user}_${folder}_${uid}`; 

    if (myCache.has(cacheKey)) return res.json(myCache.get(cacheKey));

    try {
        const client = await getImapClient(user, pass);
        let lock = await client.getMailboxLock(folder || 'INBOX');
        try {
            let message = await client.fetchOne(uid, { source: true, uid: true });
            const parsed = await simpleParser(message.source);
            
            const responseData = { 
                success: true, 
                content: parsed.html || parsed.textAsHtml || parsed.text || "No Content" 
            };

            myCache.set(cacheKey, responseData);
            res.json(responseData);
        } finally { 
            lock.release(); 
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🦄 UniPony Backend ready on port ${PORT}`);
    console.log(`🚀 Fresh Connection Mode Activated! UID Mapping Fixed!`);
});
