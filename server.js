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

// --- WebSocket ---
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  socket.on('send_message', async (data) => {
    try {
      const text = data.message.toLowerCase();
      const id = socket.data.identity || `anon-${socket.id}`;
      db.users[id] = db.users[id] || { prefs: {} };

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

// --- Webhook para WhatsApp ---
app.post("/webhook/whatsapp", express.urlencoded({ extended: false }), (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const userMessage = req.body.Body || "";

  console.log("📩 WhatsApp dice:", userMessage);

  // Respuesta simple de prueba
  twiml.message(`👋 Hola! Recibí tu mensaje: "${userMessage}"`);

  res.type("text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Asistente en http://localhost:${PORT}`);
});
