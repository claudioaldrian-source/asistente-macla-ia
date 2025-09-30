require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { OpenAI } = require('openai');
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");
const { v4: uuidv4 } = require("uuid");
const { google } = require("googleapis");
const axios = require("axios");

// --- GOOGLE OAUTH CLIENT ---
function getOAuth2Client() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
    GOOGLE_REFRESH_TOKEN
  } = process.env;

  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

// --- CALENDAR HELPER ---
async function createCalendarEvent({ summary, description, startISO, endISO, attendeesEmails = [] }) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });

  const event = {
    summary: summary || "Evento",
    description: description || "",
    start: { dateTime: startISO },
    end: { dateTime: endISO },
    attendees: attendeesEmails.map(email => ({ email })),
    reminders: { useDefault: true }
  };

  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
  const res = await calendar.events.insert({ calendarId, requestBody: event });
  return res.data;
}

// --- INTENT PARSER ---
async function classifyAndExtractIntent(userText) {
  const sys = `Sos un parser. Tu única salida debe ser JSON válido sin explicación.
{
  "intent": "calendar_event" | "local_reminder" | "none",
  "summary": "string",
  "description": "string",
  "startISO": "YYYY-MM-DDTHH:mm:ssZ | ''",
  "endISO": "YYYY-MM-DDTHH:mm:ssZ | ''",
  "attendees": ["correo@ej.com", "..."]
}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userText }
    ],
    max_tokens: 300
  });

  let data = { intent: "none", summary: "", description: "", startISO: "", endISO: "", attendees: [] };
  try {
    data = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
  } catch (_) {}
  return data;
}

// --- MEMORIA SIMPLE ---
const DB_PATH = path.join(__dirname, 'memory.json');
let db = { users: {}, reminders: [] };
if (fs.existsSync(DB_PATH)) {
  try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (e) { console.error('No pude leer memory.json', e); }
}
const saveDB = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

// --- CONVERSACIÓN CON MEMORIA ---
class ConversationEngine {
  constructor() { this.conversations = new Map(); }
  async processMessage(conversationId, message) {
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, {
        messages: [
          { role: "system", content: "Eres un asistente argentino, amable, natural y cercano." }
        ]
      });
    }
    const conversation = this.conversations.get(conversationId);
    conversation.messages.push({ role: "user", content: message });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: conversation.messages,
      max_tokens: 250,
      temperature: 0.9
    });

    const assistantMessage = response.choices[0].message.content;
    conversation.messages.push({ role: "assistant", content: assistantMessage });
    return { message: assistantMessage, timestamp: new Date() };
  }
}
const conversationEngine = new ConversationEngine();

// --- APP & SERVER ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- ENDPOINTS ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Calendar test
app.get("/dev/calendar/test", async (req, res) => {
  try {
    const start = new Date(Date.now() + 15 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const ev = await createCalendarEvent({
      summary: "Test MACLA-IA",
      description: "Evento de prueba",
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      attendeesEmails: []
    });
    res.json({ ok: true, event: ev.htmlLink || ev.id });
  } catch (e) {
    console.error("Calendar test error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Clima
app.get('/api/weather', async (req, res) => {
  try {
    const key = process.env.OPENWEATHER_API_KEY;
    if (!key) return res.status(500).json({ error: 'Falta OPENWEATHER_API_KEY' });
    const { city } = req.query;
    if (!city) return res.status(400).json({ error: 'Falta parámetro city' });
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric&lang=es`;
    const r = await fetch(url);
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar clima' });
  }
});

// Voice (Twilio calls)
app.post("/process_voice", express.urlencoded({ extended: false }), async (req, res) => {
  const userText = req.body.TranscriptionText || "No entendí bien.";
  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Sos un asistente breve para llamadas." },
      { role: "user", content: userText }
    ],
    max_tokens: 80
  });
  const reply = aiResponse.choices[0].message.content;

  const mp3 = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: reply
  });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  const filename = `${uuidv4()}.mp3`;
  const filepath = path.join(__dirname, "public", "tts", filename);
  fs.mkdirSync(path.join(__dirname, "public", "tts"), { recursive: true });
  fs.writeFileSync(filepath, buffer);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.play(`${req.protocol}://${req.get("host")}/tts/${filename}`);
  twiml.record({ action: "/process_voice", transcribe: true, maxLength: 10, playBeep: true });
  res.type("text/xml").send(twiml.toString());
});

// WhatsApp webhook
function splitForWhatsApp(text, maxLen = 1200) {
  const parts = [];
  let chunk = '';
  for (const line of text.split('\n')) {
    if ((chunk + '\n' + line).length > maxLen) {
      if (chunk) parts.push(chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) parts.push(chunk);
  return parts;
}

app.post("/webhook/whatsapp", express.urlencoded({ extended: false }), async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();
  let userMessage = req.body.Body || "";
  const numMedia = parseInt(req.body.NumMedia || "0", 10);

  if (numMedia > 0) {
    const mediaUrl = req.body.MediaUrl0;
    const contentType = req.body.MediaContentType0 || "";
    if (contentType.startsWith("audio")) {
      try {
        const mediaResp = await axios.get(mediaUrl, {
          responseType: "arraybuffer",
          auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
        });
        const tmpDir = path.join(__dirname, "tmp");
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpPath = path.join(tmpDir, `wa-${Date.now()}.ogg`);
        fs.writeFileSync(tmpPath, mediaResp.data);

        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpPath),
          model: "whisper-1",
          language: "es"
        });
        userMessage += " " + (transcription.text || "");
        fs.unlinkSync(tmpPath);
      } catch (e) { console.error("Transcripción WA error:", e.message); }
    }
  }

  try {
    const intent = await classifyAndExtractIntent(userMessage);
    if (intent.intent === "calendar_event" && intent.startISO) {
      const event = await createCalendarEvent(intent);
      twiml.message(`✅ Agendado: *${event.summary}* el ${new Date(event.start.dateTime).toLocaleString()}`);
      return res.type("text/xml").send(twiml.toString());
    }
    if (intent.intent === "local_reminder") {
      const r = { id: `r_${Date.now()}`, identity: req.body.From, text: intent.summary || userMessage, dueAt: Date.now() + 30 * 60 * 1000, done: false };
      db.reminders.push(r); saveDB();
      twiml.message("📝 Listo, te lo guardé como recordatorio.");
      return res.type("text/xml").send(twiml.toString());
    }
  } catch (e) { console.error("Intent WA error:", e); }

  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Sos un asistente argentino, amable y natural." },
      { role: "user", content: userMessage }
    ]
  });
  splitForWhatsApp(aiResponse.choices[0].message.content).forEach(c => twiml.message(c));
  res.type("text/xml").send(twiml.toString());
});

// --- RECORDATORIOS ---
setInterval(() => {
  const now = Date.now();
  const due = db.reminders.filter(r => !r.done && r.dueAt <= now);
  due.forEach(r => {
    const target = [...io.sockets.sockets.values()].find(s => s.data?.identity === r.identity);
    if (target) target.emit('reminder:fire', r);
    r.done = true;
  });
  if (due.length) saveDB();
}, 5000);

// --- Endpoint para generar link de autorización con Google Calendar ---
app.get("/get_token", (req, res) => {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
  });

  console.log("CLIENT_ID =", process.env.GOOGLE_CLIENT_ID);
  console.log("REDIRECT_URI =", process.env.GOOGLE_REDIRECT_URI);
  console.log("Auth URL generado =", authUrl);

  res.send(`
    <p>CLIENT_ID: ${process.env.GOOGLE_CLIENT_ID}</p>
    <p>REDIRECT_URI: ${process.env.GOOGLE_REDIRECT_URI}</p>
    <a href="${authUrl}" target="_blank">Haz clic aquí para autorizar con Google</a>
  `);
});

// --- SERVER START ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Asistente en http://localhost:${PORT}`));
