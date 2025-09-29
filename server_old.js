const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Motor de conversación básico
class ConversationEngine {
  constructor() {
    this.conversations = new Map();
  }

  processMessage(conversationId, message) {
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, {
        messages: [],
        userInfo: {}
      });
    }

    const conversation = this.conversations.get(conversationId);
    conversation.messages.push({ role: 'user', content: message });

    const response = this.generateResponse(message, conversation);
    conversation.messages.push({ role: 'assistant', content: response });

    return {
      message: response,
      timestamp: new Date()
    };
  }

  generateResponse(message = "", conversation) {
    const lowerMessage = message.toString().toLowerCase();

    // Guardar información del usuario
    if (lowerMessage.includes('me llamo') || (lowerMessage.includes('soy') && !lowerMessage.includes('estoy'))) {
      const nameMatch = message.match(/(?:me llamo|soy)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ\s]+)/i);
      if (nameMatch) {
        conversation.userInfo.name = nameMatch[1].trim();
        return `¡Hola ${conversation.userInfo.name}! Qué gusto conocerte. Soy tu asistente y puedo hablar de cualquier tema: cocina, deportes, tecnología, entretenimiento, lo que se te ocurra. ¿De qué te gustaría conversar?`;
      }
    }

    // COCINA
    if (lowerMessage.includes('cocina') || lowerMessage.includes('receta') || lowerMessage.includes('comida') || lowerMessage.includes('plato')) {
      if (lowerMessage.includes('pescado')) {
        return `Para cocinar pescado te recomiendo estas opciones fáciles:
        
- **Al horno**: Con limón, sal y hierbas por 20 min a 180°C
- **A la plancha**: 4-5 min de cada lado con un poco de aceite
- **En papillote**: Envuelto en papel aluminio con verduras

¿Qué tipo de pescado tenés? ¿Salmón, merluza, dorado? Te puedo dar una receta específica.`;
      }

      return `Me encanta hablar de cocina 🍳. ¿Qué te gusta cocinar? ¿Querés que te dé alguna receta rápida?`;
    }

    // DEPORTES
    if (lowerMessage.includes('deporte') || lowerMessage.includes('ejercicio') || lowerMessage.includes('entrenar')) {
      return `¡Qué bueno que te interese el deporte! 🏀⚽🏋️ ¿Practicás algo actualmente o estás buscando empezar?`;
    }

    // TECNOLOGÍA
    if (lowerMessage.includes('tecnolog') || lowerMessage.includes('computador') || lowerMessage.includes('celular') || lowerMessage.includes('app')) {
      return `La tecnología está buenísima 🔧. ¿Querés que hablemos de apps, programación, inteligencia artificial o gadgets?`;
    }

    // ENTRETENIMIENTO
    if (lowerMessage.includes('película') || lowerMessage.includes('serie') || lowerMessage.includes('música') || lowerMessage.includes('libro')) {
      return `¡Me encanta ese tema! 🎬🎶📚 ¿Preferís que te recomiende películas, series, música o libros?`;
    }

    // VIAJES
    if (lowerMessage.includes('viaje') || lowerMessage.includes('destino') || lowerMessage.includes('turismo')) {
      return `✈️ ¿Estás planeando un viaje o solo soñando destinos? Te puedo recomendar lugares y tips prácticos.`;
    }

    // SALUD
    if (lowerMessage.includes('salud') || lowerMessage.includes('bienestar') || lowerMessage.includes('dormir') || lowerMessage.includes('estrés')) {
      return `La salud es súper importante 💙. ¿Querés hablar de alimentación, sueño, rutinas o manejo del estrés?`;
    }

    // TRABAJO
    if (lowerMessage.includes('trabajo') || lowerMessage.includes('productiv') || lowerMessage.includes('estudio') || lowerMessage.includes('carrera')) {
      return `Tema clave 💼. ¿Preferís consejos de organización, técnicas de estudio o desarrollo profesional?`;
    }

    // SALUDOS
    if (lowerMessage.includes('hola') || lowerMessage.includes('buenas')) {
      if (conversation.userInfo.name) {
        return `¡Hola de nuevo, ${conversation.userInfo.name}! ¿De qué hablamos hoy?`;
      }
      return `¡Hola! Soy tu asistente conversacional 🤖. Podemos charlar de cocina, deportes, tecnología, viajes, salud, entretenimiento... ¿Qué te interesa más?`;
    }

    // Estado de ánimo
    if (lowerMessage.includes('bien') || lowerMessage.includes('genial') || lowerMessage.includes('perfecto')) {
      const options = [
        `¡Qué bueno escuchar eso! 😀 ¿Qué planes tenés para hoy?`,
        `¡Excelente! Se nota que estás con buena energía.`,
        `¡Me contagias la buena onda! 🙌`
      ];
      return options[Math.floor(Math.random() * options.length)];
    }

    // Respuesta natural por defecto
    const fallback = [
      `Ah, interesante lo que me contás. ¿Y cómo te sentís con eso?`,
      `¡Qué bueno! Contame más...`,
      `Entiendo. ¿Y vos qué opinás?`,
      `¡Claro! ¿Te pasó algo parecido antes?`,
      `Me gusta que me compartas esto. ¿Querés seguir con el tema?`
    ];
    return fallback[Math.floor(Math.random() * fallback.length)];
  }
}

const conversationEngine = new ConversationEngine();

// WebSocket
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  socket.on('send_message', (data) => {
    try {
      const response = conversationEngine.processMessage(socket.id, data.message);
      socket.emit('message_response', response);
    } catch (error) {
      console.error("Error en procesamiento:", error);
      socket.emit('error', { message: 'Error procesando el mensaje' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

// Frontend básico
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Asistente en http://localhost:${PORT}`);
});
