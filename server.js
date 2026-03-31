const express = require('express');
const cors = require('cors');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser'); // 📌 เพิ่มบรรทัดนี้

const app = express();
app.use(cors());
app.use(express.json());

// ฟังก์ชันดึง Credential จาก Header
const getImapConfig = (req) => {
    const user = req.headers['x-imap-user'];
    const pass = req.headers['x-imap-pass'];
    if (!user || !pass) throw new Error('Missing Credentials');
    return {
        host: 'imap.rambler.ru',
        port: 993,
        secure: true,
        auth: { user, pass },
        logger: false,
        connectionTimeout: 15000
    };
};

// API: Login Check
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const client = new ImapFlow({
        host: 'imap.rambler.ru', port: 993, secure: true,
        auth: { user: email, pass: password }
    });
    try {
        await client.connect();
        await client.logout();
        res.json({ success: true });
    } catch (err) {
        res.status(401).json({ success: false, error: 'Login Failed' });
    }
});

// API: Get Folders
app.get('/api/folders', async (req, res) => {
    try {
        const client = new ImapFlow(getImapConfig(req));
        await client.connect();
        let folders = await client.list();
        await client.logout();
        res.json({ success: true, data: folders.map(f => ({ name: f.name, path: f.path })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get Email List
app.get('/api/emails', async (req, res) => {
    const folderPath = req.query.folder || 'INBOX';
    try {
        const client = new ImapFlow(getImapConfig(req));
        await client.connect();
        let lock = await client.getMailboxLock(folderPath);
        try {
            const mailbox = client.mailbox;
            if (mailbox.exists === 0) return res.json({ success: true, data: [] });
            let start = Math.max(1, mailbox.exists - 14); // ดึง 15 เมลล่าสุด
            let emails = [];
            for await (let msg of client.fetch(`${start}:*`, { envelope: true })) {
                emails.push({
                    uid: msg.uid,
                    subject: msg.envelope.subject || '(No Subject)',
                    from: msg.envelope.from[0]?.address || 'Unknown',
                    date: msg.envelope.date
                });
            }
            res.json({ success: true, data: emails.reverse() });
        } finally { lock.release(); await client.logout(); }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get Email Body (เนื้อหาเมล) - 📌 แก้ไขส่วนนี้ให้ใช้ mailparser
app.get('/api/email-content', async (req, res) => {
    const { folder, uid } = req.query;
    try {
        const client = new ImapFlow(getImapConfig(req));
        await client.connect();
        let lock = await client.getMailboxLock(folder || 'INBOX');
        try {
            // ดึง Source ของอีเมลมา
            let message = await client.fetchOne(uid, { source: true });
            
            // 📌 ใช้ simpleParser จาก mailparser แปลงร่างเนื้อหา
            let parsed = await simpleParser(message.source);
            
            // 📌 เลือกส่ง HTML เป็นหลัก ถ้าไม่มีให้ส่ง Text ธรรมดา
            let finalContent = parsed.html || parsed.text || "ไม่มีเนื้อหาในจดหมายฉบับนี้";
            
            res.json({ 
                success: true, 
                content: finalContent,
                isHtml: !!parsed.html
            });
        } finally { lock.release(); await client.logout(); }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend Live on Port ${PORT}`));