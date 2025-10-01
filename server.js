require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');
const axios = require('axios');

// --- Polyfill de fetch (por si el runtime no lo trae) ---
if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

// --- OpenAI ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  if (GOOGLE_REFRESH_TOKEN) {
    oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  }
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
    end: { dateTime: endISO || new Date(Date.parse(startISO) + 60 * 60 * 1000).toISOString() },
    attendees: (attendeesEmails || []).map(email => ({ email })),
    reminders: { useDefault: true }
  };

  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
  const res = await calendar.events.insert({ calendarId, requestBody: event });
  return res.data;
}

// --- INTENT: decidir si es recordatorio local o evento de calendario ---
async function classifyAndExtractIntent(userText) {
  const sys = `Sos un parser. Tu única salida debe ser JSON válido sin explicación.
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

  let data = { intent: "none", summary: "", description: "", startISO: "", endISO: "", attendees: [] };
  try { data = JSON.parse(completion.choices?.[0]?.message?.content || "{}"); } catch (_) {}
  return data;
}

// --- PERSISTENCIA LIGERA (JSON) ---
const DB_PATH = path.join(__dirname, 'memory.json');
let db = { users: {}, reminders: [] };
if (fs.existsSync(DB_PATH)) {
  try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (e) { console.error('No pude leer memory.json', e); }
}
const saveDB = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

// --- RECORDATORIOS RELATIVOS A EVENTOS ---
function scheduleReminder(eventId, eventSummary, startISO, minutesBefore, targetSocketOrFrom) {
  if (!startISO) return;
  const eventDate = new Date(startISO);
  const reminderTime = new Date(eventDate.getTime() - minutesBefore * 60 * 1000);
  const now = new Date();

  const delay = reminderTime.getTime() - now.getTime();
  if (delay <= 0) {
    console.log("⏰ La hora de recordatorio ya pasó");
    return;
  }

  setTimeout(() => {
    const msg = `⏰ Recordatorio: ${eventSummary} en ${minutesBefore} minutos.`;
    // Websocket
    if (typeof targetSocketOrFrom === "object" && targetSocketOrFrom.emit) {
      targetSocketOrFrom.emit("reminder:fire", { eventId, text: msg });
    }
    // WhatsApp
    if (typeof targetSocketOrFrom === "string") {
      const MessagingResponse = twilio.twiml.MessagingResponse;
      const twiml = new MessagingResponse();
      twiml.message(msg);
      // Podrías enviar con twilioClient.messages.create() si preferís push inmediato
      console.log(`Recordatorio WA → ${targetSocketOrFrom}: ${msg}`);
    }
  }, delay);

  console.log(`⏰ Recordatorio programado: ${eventSummary} (${minutesBefore} min antes)`);
}

// --- Conversación con memoria ---
class ConversationEngine {
  constructor() { this.conversations = new Map(); }
  async processMessage(conversationId, message) {
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, {
        messages: [
          { role: "system", content: "Eres un asistente argentino, amable, natural y cercano. Responde claro y útil." }
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

// --- HOME ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// --- CLIMA API ---
app.get('/api/weather', async (req, res) => {
  try {
    const key = process.env.OPENWEATHER_API_KEY;
    if (!key) return res.status(500).json({ error: 'Falta OPENWEATHER_API_KEY' });
    const { city } = req.query;
    if (!city) return res.status(400).json({ error: 'Falta parámetro city' });
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric&lang=es`;
    const r = await fetch(url);
    res.json(await r.json());
  } catch {
    res.status(500).json({ error: 'Error al consultar clima' });
  }
});

// --- TTS WEB: /speak (botón verde) ---
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
    console.error("Error en TTS /speak:", err.message);
    res.status(500).send("Error generando audio");
  }
});

// --- TWILIO VOICE: saludo + bucle ---
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: "alice", language: "es-ES" }, "Hola, soy tu asistente. Decime algo y te respondo.");
  twiml.record({ action: "/process_voice", transcribe: true, maxLength: 10, playBeep: true });
  res.type("text/xml").send(twiml.toString());
});

app.post("/process_voice", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const userText = req.body.TranscriptionText || "No entendí bien.";
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Sos un asistente amable y natural. Respondé breve porque es una llamada de voz." },
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
  } catch (e) {
    console.error("process_voice error:", e.message);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: "alice", language: "es-ES" }, "Tuvimos un problemita. Corto acá.");
    res.type("text/xml").send(twiml.toString());
  }
});

// --- WEBSOCKET: chat web con clima + intents (calendar/reminder) ---
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  socket.on('send_message', async (data) => {
    try {
      const textLower = (data.message || "").toLowerCase();
      const id = socket.data.identity || `anon-${socket.id}`;
      db.users[id] = db.users[id] || { prefs: {} };

      // 1) Intent (calendar vs reminder)
      const intent = await classifyAndExtractIntent(data.message);

      if (intent.intent === "calendar_event" && intent.startISO) {
        try {
          const event = await createCalendarEvent({
            summary: intent.summary || "Evento",
            description: intent.description || `Creado por MACLA-IA`,
            startISO: intent.startISO,
            endISO: intent.endISO,
            attendeesEmails: intent.attendees || []
          });
          
          // Programar recordatorio 60 minutos antes
          scheduleReminder(event.id, event.summary, intent.startISO, 60, socket);

          socket.emit('message_response', {
            message: `✅ Listo, agendé **${event.summary}** para el ${new Date(event.start.dateTime || event.start.date).toLocaleString()}.`,
            timestamp: new Date()
          });
          return;
        } catch (e) {
          console.error("Calendar error (web):", e.message);
          socket.emit('message_response', { message: "⚠️ No pude crear el evento. Probá con fecha y hora claras (ej: 'jueves 10:00').", timestamp: new Date() });
          return;
        }
      }

      if (intent.intent === "local_reminder" && !intent.startISO) {
        const r = { id: `r_${Date.now()}`, identity: id, text: intent.summary || data.message, dueAt: Date.now() + 30 * 60 * 1000, done: false };
        db.reminders.push(r);
        saveDB();
        socket.emit('message_response', { message: `📝 Listo, te lo guardé como recordatorio. Si querés hora exacta decime “recordame hoy a las 21 ...”.`, timestamp: new Date() });
        return;
      }

      // 2) Clima (web)
      if (textLower.includes("clima") || textLower.includes("tiempo")) {
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
        if (city.toLowerCase() === "ninguna" || !city) {
       // usar lo último que guardó, si no hay, probar con lo que escribió el usuario
       city = db.users[from]?.prefs?.city || userMessage;
        } else {
      // guardar nueva ciudad como preferida
      db.users[from] = db.users[from] || { prefs: {} };
       db.users[from].prefs.city = city;
        saveDB();
        }

        const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric&lang=es`;
        const r = await fetch(url);
        const weather = await r.json();

        let climaMsg;
        if (weather?.main) {
        const timezoneOffset = weather.timezone || 0;
        const utcNow = new Date();
        const localTime = new Date(utcNow.getTime() + timezoneOffset * 1000);
        const horaLocal = localTime.toLocaleTimeString("es-AR", {
        hour: "2-digit",
        minute: "2-digit"
         });
         climaMsg = `En ${weather.name} hay ${weather.main.temp}°C con ${weather.weather?.[0]?.description || "cielo variable"}. Hora local: ${horaLocal}.`;
        } else {
        climaMsg = `⚠️ No pude obtener el clima de "${city}".`;
        }

        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Sos un asistente natural, cercano y argentino. Si hay datos de clima, integralos en la respuesta de manera natural." },
            { role: "user", content: `Mensaje del usuario: "${data.message}". Datos de clima: "${climaMsg}".` }
          ],
          max_tokens: 250,
          temperature: 0.9
        });

        const finalReply = response.choices[0].message.content;
        socket.emit('message_response', { message: finalReply, timestamp: new Date() });
        return;
      }

      // 3) Conversación normal
      const response = await conversationEngine.processMessage(socket.id, data.message);
      socket.emit('message_response', response);

      // dividir en trozos de 1000–1200 caracteres
      const parts = [];
      for (let i = 0; i < reply.length; i += 1000) {
       parts.push(reply.slice(i, i + 1000));
      }

      // mandar cada parte al cliente web
      parts.forEach(part => {
      socket.emit('message_response', { message: part, timestamp: new Date() });
      });

      } catch (error) {
      console.error("Error en procesamiento (web):", error.message);
      socket.emit('error', { message: 'Error procesando el mensaje' });
     }
      });

     socket.on('disconnect', () => console.log(`Cliente desconectado: ${socket.id}`));

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

// --- Recordatorios recurrentes ---
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

// --- WhatsApp helpers ---
function splitForWhatsApp(text, maxLen = 1200) {
  const parts = [];
  let chunk = '';
  for (const line of String(text).split('\n')) {
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

// --- Webhook WhatsApp (texto + audios + clima + calendar) ---
app.post("/webhook/whatsapp", express.urlencoded({ extended: false }), async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  let userMessage = req.body.Body || "";
  const from = req.body.From || "wa-user";
  const numMedia = parseInt(req.body.NumMedia || "0", 10);

  // --- Detectar y guardar nombre del usuario ---
let nombre = db.users[from]?.prefs?.name || null;

// Regex para capturar frases como "me llamo X", "soy X", "mi nombre es X"
const match = userMessage.match(/\b(me llamo|soy|mi nombre es)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+)\b/i);
if (match) {
  nombre = match[2].trim();

  // Diccionario simple de apodos comunes
  const apodos = {
    "claudio": "Clau",
    "roberto": "Robert",
    "isabel": "Isa",
    "martina": "Martu",
    "alejandro": "Ale",
    "fernando": "Fer"
  };

  // Guardar en prefs
  db.users[from] = db.users[from] || { prefs: {} };
  db.users[from].prefs.name = nombre;
  db.users[from].prefs.nickname = apodos[nombre.toLowerCase()] || nombre;
  saveDB();

  twiml.message(`¡Encantado, ${db.users[from].prefs.nickname}! Voy a recordarlo.`);
  return res.type("text/xml").send(twiml.toString());
}
  
  // Si viene audio, lo bajo y lo transcribo
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
      } catch (e) {
        console.error("Transcripción WA error:", e.message);
      }
    }
  }

  // INTENTS (calendar / reminder)
  try {
    const intent = await classifyAndExtractIntent(userMessage);

    if (intent.intent === "calendar_event" && intent.startISO) {
      try {
        const event = await createCalendarEvent({
          summary: intent.summary || "Evento",
          description: intent.description || `Creado por MACLA-IA`,
          startISO: intent.startISO,
          endISO: intent.endISO,
          attendeesEmails: intent.attendees || []
        });

        // Programar recordatorio 60 minutos antes del evento
        scheduleReminder(event.id, event.summary, intent.startISO, 60, from);
       
        twiml.message(
     `✅ Agendado: *${event.summary}* el ${new Date(event.start.dateTime).toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
      })}`
      );

        return res.type("text/xml").send(twiml.toString());
        } catch (e) {
        console.error("Calendar error (WA):", e.message);
        twiml.message("⚠️ No pude crear el evento en Google Calendar. Probá con fecha y hora claras (ej: 'jueves 10:00').");
        return res.type("text/xml").send(twiml.toString());
      }
    }

    if (intent.intent === "local_reminder" && !intent.startISO) {
      const r = { id: `r_${Date.now()}`, identity: from, text: intent.summary || userMessage, dueAt: Date.now() + 30 * 60 * 1000, done: false };
      db.reminders.push(r); saveDB();
      twiml.message("📝 Listo, te lo guardé como recordatorio. Si querés hora exacta decime: 'recordame hoy a las 21 ...'.");
      return res.type("text/xml").send(twiml.toString());
    }
  } catch (e) { console.error("Intent WA error:", e.message); }

  // CLIMA (WA)
  const lower = userMessage.toLowerCase();
  if (lower.includes("clima") || lower.includes("tiempo")) {
    try {
      const extraction = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Sos un extractor. Respondé SOLO con el nombre de la ciudad o 'ninguna'." },
          { role: "user", content: userMessage }
        ],
        max_tokens: 20,
        temperature: 0
      });

      let city = (extraction.choices?.[0]?.message?.content || "").trim();
      if (city.toLowerCase() === "ninguna" || !city) {
  // usar lo último que guardó, si no hay, probar con lo que escribió el usuario
  city = db.users[from]?.prefs?.city || userMessage;
} else {
  // guardar nueva ciudad como preferida
  db.users[from] = db.users[from] || { prefs: {} };
  db.users[from].prefs.city = city;
  saveDB();
}

      const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric&lang=es`;
      const r = await fetch(url);
      const weather = await r.json();

      let climaMsg;
       if (weather?.main) {
      const timezoneOffset = weather.timezone || 0;
      const utcNow = new Date();
      const localTime = new Date(utcNow.getTime() + timezoneOffset * 1000);
      const horaLocal = localTime.toLocaleTimeString("es-AR", {
      hour: "2-digit",
      minute: "2-digit"
       });
      climaMsg = `En ${weather.name} hay ${weather.main.temp}°C con ${weather.weather?.[0]?.description || "cielo variable"}. Hora local: ${horaLocal}.`;
      } else {
  climaMsg = `⚠️ No pude obtener el clima de "${city}".`;
      }

      const ai = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Sos un asistente natural, cercano y argentino. Integrá los datos de clima como un consejo útil." },
          { role: "user", content: `Mensaje del usuario: "${userMessage}". Datos de clima: "${climaMsg}".` }
        ],
        max_tokens: 200,
        temperature: 0.7
      });

      twiml.message(ai.choices[0].message.content);
      return res.type("text/xml").send(twiml.toString());
    } catch (e) {
      console.error("Clima WA error:", e.message);
    }
  }

// --- Construir prompt tomando en cuenta si ya tiene nombre guardado ---
const systemMsg = nombre
  ? `Sos un asistente argentino, amable y natural. El usuario se llama ${nombre}, pero podés tratarlo con confianza como "${db.users[from].prefs.nickname}".`
  : "Sos un asistente argentino, amable y natural.";

  // Conversación normal con OpenAI
  try {
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userMessage }
      ],
      max_tokens: 800,   // le subimos el límite para recetas largas
    temperature: 0.9
    });

    const reply = aiResponse.choices[0].message.content;

    // Enviar en partes si es largo
    const chunks = splitForWhatsApp(reply);
    chunks.forEach(c => twiml.message(c));

    // Adjuntar también audio (MP3) con TTS (opcional, activo)
    try {
      const mp3 = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: reply
      });
      const buffer = Buffer.from(await mp3.arrayBuffer());
      const filename = `wa-${Date.now()}.mp3`;
      const outDir = path.join(__dirname, "public", "tts");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, filename), buffer);
      const publicUrl = `${req.protocol}://${req.get("host")}/tts/${filename}`;
      const m = twiml.message(""); // mensaje vacío con media
      m.media(publicUrl);
    } catch (e) {
      console.warn("No se pudo adjuntar audio TTS en WA:", e.message);
    }

    // 👉 Enviar la respuesta completa a Twilio
    return res.type("text/xml").send(twiml.toString()); 
    
  } catch (error) {
    console.error("❌ Error en WhatsApp webhook:", error.message);
    twiml.message("⚠️ Lo siento, tuve un problema procesando tu mensaje.");
    res.type("text/xml").send(twiml.toString());
  }
});

// --- OAuth2: generar link ---
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

  console.log("CLIENT_ID   =", process.env.GOOGLE_CLIENT_ID);
  console.log("REDIRECT_URI=", process.env.GOOGLE_REDIRECT_URI);
  console.log("Auth URL    =", authUrl);

  res.send(`
    <p>CLIENT_ID: ${process.env.GOOGLE_CLIENT_ID || "(vacío)"}</p>
    <p>REDIRECT_URI: ${process.env.GOOGLE_REDIRECT_URI || "(vacío)"}</p>
    <a href="${authUrl}" target="_blank">Haz clic aquí para autorizar con Google</a>
  `);
});

// --- OAuth2: callback para capturar refresh_token ---
app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("No code provided");
  try {
    const auth = getOAuth2Client();
    const { tokens } = await auth.getToken(code);
    res.send(`
      <h1>✅ Autorización exitosa</h1>
      <p>Copia este refresh token y agrégalo a Railway como GOOGLE_REFRESH_TOKEN:</p>
      <pre style="background:#f4f4f4;padding:20px;border-radius:5px;">${tokens.refresh_token || 'Ya existe un refresh token activo'}</pre>
    `);
  } catch (e) {
    res.send(`Error: ${e.message}`);
  }
});

// --- SERVER START ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Asistente en http://localhost:${PORT}`));
