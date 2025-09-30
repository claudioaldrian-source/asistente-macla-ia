require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { OpenAI } = require('openai'); // si rompe, cambiá por const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");
const { v4: uuidv4 } = require("uuid"); // para nombres únicos de archivos
const { google } = require("googleapis");
const axios = require("axios"); // si no lo tenés: npm i axios

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

// --- CALENDAR HELPERS ---
async function createCalendarEvent({ summary, description, startISO, endISO, attendeesEmails = [] }) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });

  const event = {
    summary: summary || "Evento",
    description: description || "",
    start: { dateTime: startISO },
    end:   { dateTime: endISO },
    attendees: attendeesEmails.map(email => ({ email })),
    reminders: { useDefault: true }
  };

  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
  const res = await calendar.events.insert({ calendarId, requestBody: event });
  return res.data;
}

// 🔧 TEST: crea un evento a 15 minutos de ahora (borralo luego)
app.get("/dev/calendar/test", async (req, res) => {
  try {
    const start = new Date(Date.now() + 15*60*1000);
    const end   = new Date(start.getTime() + 60*60*1000);

    const ev = await createCalendarEvent({
      summary: "Test MACLA-IA",
      description: "Evento de prueba creado por el bot",
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

// --- PERSISTENCIA LIGERA (JSON) ---
const DB_PATH = path.join(__dirname, 'memory.json');

let db = { users: {}, reminders: [] };
if (fs.existsSync(DB_PATH)) {
  try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (e) { console.error('No pude leer memory.json', e); }
}
const saveDB = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

// 👇 recién acá va tu app y server
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 👉 Esto sirve tu index.html aunque esté en la raíz
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 🔧 TEST: crea un evento a 15 minutos de ahora (borralo luego)
app.get("/dev/calendar/test", async (req, res) => {
  try {
    const start = new Date(Date.now() + 15*60*1000);
    const end   = new Date(start.getTime() + 60*60*1000);

    const ev = await createCalendarEvent({
      summary: "Test MACLA-IA",
      description: "Evento de prueba creado por el bot",
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      attendeesEmails: []
    });

// --- ENDPOINT DE CLIMA ---
app.get('/api/weather', async (req, res) => {
  try {
    const key = process.env.OPENWEATHER_API_KEY;
    if (!key) return res.status(500).json({ error: 'Falta OPENWEATHER_API_KEY' });

    const { city } = req.query;
    if (!city) return res.status(400).json({ error: 'Falta parámetro city' });

    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric&lang=es`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('Weather error', err);
    res.status(500).json({ error: 'Error al consultar clima' });
  }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/process_voice", express.urlencoded({ extended: false }), async (req, res) => {
  const userText = req.body.TranscriptionText || "No entendí bien.";

  // 1. Generamos respuesta con OpenAI
  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Sos un asistente amable y natural. Respondé breve porque es una llamada de voz." },
      { role: "user", content: userText }
    ],
    max_tokens: 80,
    temperature: 0.8
  });
  const reply = aiResponse.choices[0].message.content;

  // 2. Generamos audio con OpenAI TTS
  const mp3 = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy", // podés probar verse, etc.
    input: reply
  });

  const buffer = Buffer.from(await mp3.arrayBuffer());
  const filename = `${uuidv4()}.mp3`;
  const filepath = path.join(__dirname, "public", "tts", filename);

  // Guardamos archivo para que Twilio lo pueda reproducir
  fs.mkdirSync(path.join(__dirname, "public", "tts"), { recursive: true });
  fs.writeFileSync(filepath, buffer);

  // 3. Responder a Twilio con <Play> del archivo
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.play(`${req.protocol}://${req.get("host")}/tts/${filename}`);

  // volvemos a grabar para seguir conversando
  twiml.record({
    action: "/process_voice",
    transcribe: true,
    maxLength: 10,
    playBeep: true
  });

  res.type("text/xml");
  res.send(twiml.toString());
});


// --- Motor de conversación con memoria ---
class ConversationEngine {
  constructor() {
    this.conversations = new Map();
  }

  async processMessage(conversationId, message) {
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, {
        messages: [
          { role: "system", content: "Eres un asistente conversacional argentino, amable, natural y cercano. Recordá detalles del usuario y mantené coherencia en la charla." }
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

// --- INTENT: decidir si es recordatorio local o evento de calendario ---
async function classifyAndExtractIntent(userText) {
  // La IA devuelve JSON estricto.
  const sys = `Sos un parser. Tu única salida debe ser JSON válido sin explicación.
Tipo de salida:
{
  "intent": "calendar_event" | "local_reminder" | "none",
  "summary": "string",
  "description": "string",
  "startISO": "YYYY-MM-DDTHH:mm:ssZ | ''",
  "endISO": "YYYY-MM-DDTHH:mm:ssZ | ''",
  "attendees": ["correo@ej.com", "..."]
}

Reglas:
- Si el usuario pide "agendar", "reunión", "turno", "cita", o da fecha/hora concreta -> intent = "calendar_event".
- Si dice "recordame", "acordate", "guardame", sin fecha clara -> intent = "local_reminder".
- Si hay fecha/hora clara pero dice "recordame", interpretá como calendar_event.
- Cuando haya hora pero no duración, poné endISO = startISO + 60 minutos.
- startISO/endISO en formato ISO UTC (si no podés inferir, dejá '').`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userText }
    ],
    max_tokens: 300
  });

  let data = { intent:"none", summary:"", description:"", startISO:"", endISO:"", attendees:[] };
  try {
    data = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
  } catch (_) {}
  return data;
}

// --- WebSocket ---
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  socket.on('send_message', async (data) => {
    try {
      const text = data.message.toLowerCase();
      const id = socket.data.identity || `anon-${socket.id}`;
      db.users[id] = db.users[id] || { prefs: {} };
// --- IA decide si es calendario o recordatorio local ---
const intent = await classifyAndExtractIntent(data.message);

// 3.1) Si es EVENTO DE CALENDARIO
if (intent.intent === "calendar_event" && intent.startISO) {
  try {
    const event = await createCalendarEvent({
      summary: intent.summary || "Evento",
      description: intent.description || `Creado por MACLA-IA`,
      startISO: intent.startISO,
      endISO: intent.endISO || new Date(Date.parse(intent.startISO) + 60*60*1000).toISOString(),
      attendeesEmails: intent.attendees || []
    });

    socket.emit('message_response', {
      message: `✅ Listo, agendé **${event.summary}** para el ${new Date(event.start.dateTime || event.start.date).toLocaleString()}.`,
      timestamp: new Date()
    });
    return;
  } catch (e) {
    console.error("Calendar error:", e);
    socket.emit('message_response', {
      message: "⚠️ No pude crear el evento en Google Calendar. Probá con fecha y hora claras (ej: 'jueves 10:00').",
      timestamp: new Date()
    });
    return;
  }
}

// 3.2) Si es RECORDATORIO LOCAL (sin fecha clara)
if (intent.intent === "local_reminder" && !intent.startISO) {
  const id = socket.data.identity || `anon-${socket.id}`;
  const r = {
    id: `r_${Date.now()}`,
    identity: id,
    text: intent.summary || data.message,
    dueAt: Date.now() + 30*60*1000, // por defecto 30min; luego podemos preguntar hora
    done: false
  };
  db.reminders.push(r);
  saveDB();

  socket.emit('message_response', {
    message: `📝 Listo, te lo guardé como recordatorio. Si querés hora exacta decime “recordame hoy a las 21 ...”.`,
    timestamp: new Date()
  });
  return;
}

      // 🚨 Detectar pedido de clima
      if (text.includes("clima") || text.includes("tiempo")) {
        // 🔹 Usamos OpenAI para extraer la ciudad
        const extraction = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Sos un extractor. Respondé SOLO con el nombre de la ciudad o 'ninguna'." },
            { role: "user", content: data.message }
          ],
          max_tokens: 20,
          temperature: 0
        });
        
        let city = extraction.choices[0].message.content.trim();

        if (city.toLowerCase() === "ninguna") {
          city = db.users[id].prefs.city || "Avellaneda,AR";
        } else {
          db.users[id].prefs.city = city;
          saveDB();
        }

        const url = `http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric&lang=es`;
        const r = await fetch(url);
        const weather = await r.json();

        let reply;
        if (weather.main) {
          reply = `En ${weather.name} hay ${weather.main.temp}°C con ${weather.weather[0].description}`;
        } else {
          reply = `⚠️ No pude obtener el clima de "${city}". Probá con otra ciudad.`;
        }

       // En lugar de cortar, combinamos clima + modelo
const climaMsg = weather.main
  ? `En ${weather.name} hay ${weather.main.temp}°C con ${weather.weather[0].description}.`
  : `⚠️ No pude obtener el clima de "${city}".`;

// Ahora le pedimos a OpenAI que integre la respuesta de clima con el mensaje original
const response = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: "Sos un asistente natural, cercano y argentino. Si hay datos de clima, integralos en la respuesta de manera natural, como si conversaras con un amigo que quiere saber si puede salir." },
    { role: "user", content: `Mensaje del usuario: "${data.message}". Datos de clima: "${climaMsg}". Respondé de forma natural y útil.` }
  ],
  max_tokens: 250,
  temperature: 0.9
});

const finalReply = response.choices[0].message.content;
socket.emit('message_response', { message: finalReply, timestamp: new Date() });
return;

      }

      // ✅ Conversación normal
      const response = await conversationEngine.processMessage(socket.id, data.message);
      socket.emit('message_response', response);

    } catch (error) {
      console.error("Error en procesamiento:", error);
      socket.emit('error', { message: 'Error procesando el mensaje' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });

  // Identidad / memoria de usuario
  socket.on('whoami', (identity) => {
    socket.data.identity = identity || `anon-${socket.id}`;
    if (!db.users[socket.data.identity]) db.users[socket.data.identity] = { prefs: {} };
    saveDB();
  });

  socket.on('memory:update', (prefs) => {
    const id = socket.data.identity || `anon-${socket.id}`;
    db.users[id] = db.users[id] || { prefs: {} };
    db.users[id].prefs = { ...db.users[id].prefs, ...prefs };
    saveDB();
    socket.emit('memory:ok', db.users[id]);
  });

  // Recordatorios
  socket.on('reminder:create', ({ text, when }) => {
    const id = socket.data.identity || `anon-${socket.id}`;
    const dueAt = typeof when === 'number' ? when : Date.parse(when);
    const r = { id: `r_${Date.now()}`, identity: id, text, dueAt, done: false };
    db.reminders.push(r);
    saveDB();
    socket.emit('reminder:created', r);
  });

  socket.on('reminder:list', () => {
    const id = socket.data.identity || `anon-${socket.id}`;
    const list = db.reminders.filter(r => r.identity === id);
    socket.emit('reminder:list', list);
  });
});

// --- Ruta TTS ---
app.get("/speak", async (req, res) => {
  try {
    const text = req.query.text || "Hola, soy tu asistente con voz natural";

    const mp3 = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.set({ "Content-Type": "audio/mpeg", "Content-Length": buffer.length });
    res.send(buffer);
  } catch (err) {
    console.error("Error en TTS:", err);
    res.status(500).send("Error generando audio");
  }
});

// --- Recordatorios recurrentes ---
setInterval(() => {
  const now = Date.now();
  const due = db.reminders.filter(r => !r.done && r.dueAt <= now);
  due.forEach(r => {
    const target = [...io.sockets.sockets.values()]
      .find(s => s.data?.identity === r.identity);
    if (target) target.emit('reminder:fire', r);
    r.done = true;
  });
  if (due.length) saveDB();
}, 5000);

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

// --- Webhook para WhatsApp con OpenAI ---
app.post("/webhook/whatsapp", express.urlencoded({ extended: false }), async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();
  
  let userMessage = req.body.Body || "";
const numMedia = parseInt(req.body.NumMedia || "0", 10);

if (numMedia > 0) {
  const mediaUrl = req.body.MediaUrl0;
  const contentType = req.body.MediaContentType0 || "";

  // Solo procesamos audio (voice notes)
  if (contentType.startsWith("audio")) {
    try {
      // Descargar el archivo de Twilio con auth básica
      const mediaResp = await axios.get(mediaUrl, {
        responseType: "arraybuffer",
        auth: {
          username: process.env.TWILIO_ACCOUNT_SID,
          password: process.env.TWILIO_AUTH_TOKEN
        }
      });

      const tmpPath = path.join(__dirname, "tmp_voice.ogg");
      fs.writeFileSync(tmpPath, mediaResp.data);

      // Transcripción con OpenAI
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: "whisper-1",      // o "gpt-4o-mini-transcribe" si preferís
        language: "es"
      });

      userMessage = (userMessage ? userMessage + " " : "") + (transcription.text || "");
      fs.unlinkSync(tmpPath);  // limpiar
    } catch (e) {
      console.error("Transcripción audio WA error:", e.message);
    }
  }
}

try {
  const intent = await classifyAndExtractIntent(userMessage);

  if (intent.intent === "calendar_event" && intent.startISO) {
    try {
      const event = await createCalendarEvent({
        summary: intent.summary || "Evento",
        description: intent.description || `Creado por MACLA-IA`,
        startISO: intent.startISO,
        endISO: intent.endISO || new Date(Date.parse(intent.startISO) + 60*60*1000).toISOString(),
        attendeesEmails: intent.attendees || []
      });

      twiml.message(`✅ Agendado: *${event.summary}* el ${new Date(event.start.dateTime || event.start.date).toLocaleString()}.`);
      res.type("text/xml").send(twiml.toString());
      return;
    } catch (e) {
      console.error("Calendar error (WA):", e);
      twiml.message("⚠️ No pude crear el evento en Google Calendar. Probá con fecha y hora claras (ej: 'jueves 10:00').");
      res.type("text/xml").send(twiml.toString());
      return;
    }
  }

  if (intent.intent === "local_reminder" && !intent.startISO) {
    const from = req.body.From || "wa-user";
    const r = {
      id: `r_${Date.now()}`,
      identity: from,
      text: intent.summary || userMessage,
      dueAt: Date.now() + 30*60*1000,
      done: false
    };
    db.reminders.push(r);
    saveDB();

    twiml.message("📝 Listo, te lo guardé como recordatorio. Si querés hora exacta decime: 'recordame hoy a las 21 ...'.");
    res.type("text/xml").send(twiml.toString());
    return;
  }
} catch (e) {
  console.error("Intent error (WA):", e);
}

  console.log("📩 WhatsApp dice:", userMessage);

  try {
    // 🔹 Pedimos respuesta a OpenAI
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Sos un asistente conversacional argentino, amable, cercano y natural." },
        { role: "user", content: userMessage }
      ],
      max_tokens: 150,
      temperature: 0.9
    });

    const reply = aiResponse.choices[0].message.content;

      // 🔹 Enviamos la respuesta a WhatsApp en partes si es muy larga
    const chunks = splitForWhatsApp(reply);
    chunks.forEach(c => twiml.message(c));

     } catch (error) {
    console.error("❌ Error en WhatsApp webhook:", error);
    twiml.message("⚠️ Lo siento, tuve un problema procesando tu mensaje.");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// --- Webhook para llamadas de voz ---
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // 🔹 Saludo inicial
  twiml.say({ voice: "alice", language: "es-ES" }, "Hola, soy tu asistente inteligente. Decime algo y te respondo.");

  // 🔹 Graba la voz y la manda a /process_voice
  twiml.record({
    action: "/process_voice",
    transcribe: true,
    maxLength: 10,
    playBeep: true
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Asistente en http://localhost:${PORT}`);
});
