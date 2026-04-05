const express = require('express');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const NodeCache = require("node-cache"); 

const app = express();
const myCache = new NodeCache({ stdTTL: 120 }); // ความจำเสื่อมใน 2 นาที (สำหรับโฟลเดอร์และเนื้อหาเมล)
const IMAP_HOST = 'imap.smtp.dev'; // 📌 โฮสต์ของเว็บที่ 1

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

// 🦄 1. สร้างโกดังเก็บ Connection ที่ต่อติดแล้ว
const activeClients = new Map();

// 🦄 2. ฟังก์ชันรีเซ็ตเวลา ถ้ามีการใช้งาน ให้ต่อเวลาไปอีก 5 นาที
function resetIdleTimer(user, client) {
    if (client.idleTimer) clearTimeout(client.idleTimer);
    
    client.idleTimer = setTimeout(async () => {
        try { await client.logout(); } catch (e) {}
        activeClients.delete(user);
        console.log(`💤 [System] ตัดการเชื่อมต่อของ ${user} เพราะไม่ได้ใช้งานเกิน 5 นาที`);
    }, 5 * 60 * 1000);
}

// 🦄 3. ฟังก์ชันเรียกใช้งาน IMAP (เปิดสายใหม่ หรือ เอาสายเก่ามาใช้)
async function getImapClient(user, pass) {
    if (!user || !pass) throw new Error('Missing Credentials');

    // ถ้ามี Connection เก่าอยู่ และยังใช้งานได้ เอามาใช้เลย!
    if (activeClients.has(user)) {
        const existingClient = activeClients.get(user);
        if (existingClient.usable) {
            resetIdleTimer(user, existingClient); 
            return existingClient;
        } else {
            activeClients.delete(user); 
        }
    }

    // ถ้าไม่มีสายเก่า ให้ต่อใหม่
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

// 🚨🚨 อัปเกรดความชัวร์: เลิกเชื่อยอดเมลเก่า บังคับ Search หาเมลใหม่ทุกครั้ง! 🚨🚨
app.get('/api/emails', async (req, res) => {
    const user = req.headers['x-imap-user'];
    const pass = req.headers['x-imap-pass'];
    const folderPath = req.query.folder || 'INBOX';
    const cacheKey = `emails_${user}_${folderPath}`; 

    // ✅ ถ้ามีข้อมูลใน 5 วินาทีที่แล้ว ให้ตอบกลับทันที
    if (myCache.has(cacheKey)) return res.json(myCache.get(cacheKey));

    try {
        // 🛠️ สร้าง Connection ใหม่สดๆ เพื่อบังคับให้เซิร์ฟเวอร์ตื่น
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
            // 🛠️ ท่าไม้ตาย: เลิกใช้ mailbox.exists สั่ง Search หา UID ของเมลทั้งหมดที่มีเลย!
            let uids = await freshClient.search({ all: true }); 

            // ถ้าค้นแล้วไม่เจออะไรเลย ค่อยตอบกลับว่าว่างเปล่า
            if (!uids || uids.length === 0) {
                return res.json({ success: true, data: [] });
            }

            let emails = [];
            // ตัดเอาแค่ 5 ฉบับล่าสุด (ท้ายแถว) มาดึงข้อมูล
            let latestUids = uids.slice(-5); 
            
            // สั่งดึงข้อมูลเฉพาะ UID ที่เราหั่นมา
            for await (let msg of freshClient.fetch(latestUids, { envelope: true })) {
                emails.push({
                    uid: msg.uid,
                    subject: msg.envelope.subject || '(No Subject)',
                    from: msg.envelope.from?.[0]?.address || 'Unknown',
                    date: msg.envelope.date
                });
            }
            
            const responseData = { success: true, data: emails.reverse() };
            // ✅ ตั้ง Cache ไว้แค่ 5 วินาที! 
            myCache.set(cacheKey, responseData, 5); 
            res.json(responseData);
        } finally { 
            lock.release(); 
            // 🛠️ ทิ้งสายเลย ไม่ต้องเก็บไว้
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
        // ดึงเนื้อหาเมล ใช้สายเก่าที่ค้างไว้ได้เลยเพราะเร็วกว่า
        const client = await getImapClient(user, pass);
        let lock = await client.getMailboxLock(folder || 'INBOX');
        try {
            let message = await client.fetchOne(uid, { source: true });
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
    console.log(`🚀 Caching activated! Force Search activated for /api/emails to bypass server lies.`);
});
