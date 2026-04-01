const express = require('express');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const NodeCache = require("node-cache"); 

const app = express();
const myCache = new NodeCache({ stdTTL: 120 }); // ความจำเสื่อมใน 2 นาที
const IMAP_HOST = 'imap.smtp.dev';

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
            resetIdleTimer(user, existingClient); // รีเซ็ตเวลา
            return existingClient;
        } else {
            activeClients.delete(user); // ถ้าสายพัง ให้ลบทิ้ง
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

    // เคลียร์ทิ้งถ้าสายหลุดหรือพังจากเซิร์ฟเวอร์
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
        // ให้ต่อ IMAP แล้วเก็บค้างไว้เลย พอกดเข้าหน้าปุ๊บจะได้ดึงข้อมูลไวๆ
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
        // ใช้ Connection ที่เปิดค้างไว้
        const client = await getImapClient(user, pass);
        let folders = await client.list();
        // ❌ ไม่ต้อง logout ทิ้งแล้ว! ปล่อยค้างไว้รอคำสั่งต่อไปเลย
        
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
        const client = await getImapClient(user, pass);
        let lock = await client.getMailboxLock(folderPath); // ล็อคโฟลเดอร์เพื่ออ่าน
        try {
            const mailbox = client.mailbox;
            if (mailbox.exists === 0) return res.json({ success: true, data: [] });

            let emails = [];
            let start = Math.max(1, mailbox.exists - 14); 
            for await (let msg of client.fetch(`${start}:*`, { envelope: true })) {
                emails.push({
                    uid: msg.uid,
                    subject: msg.envelope.subject || '(No Subject)',
                    from: msg.envelope.from?.[0]?.address || 'Unknown',
                    date: msg.envelope.date
                });
            }
            
            const responseData = { success: true, data: emails.reverse() };
            myCache.set(cacheKey, responseData);
            res.json(responseData);
        } finally { 
            lock.release(); // คืนกุญแจล็อคโฟลเดอร์
            // ❌ ไม่ต้อง logout!
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
            // ❌ ไม่ต้อง logout!
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🦄 UniPony Backend ready on port ${PORT}`);
    console.log(`🚀 Caching & Connection Pooling activated!`);
});