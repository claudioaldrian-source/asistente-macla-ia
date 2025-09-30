require('dotenv').config();
const { google } = require('googleapis');

// 1. Crear cliente OAuth2 con los datos de .env
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// 2. Leer el code que pegaste como argumento
const code = process.argv[2];
if (!code) {
  console.error("⚠️  Falta el code. Usá: node exchange_token.js <CODE>");
  process.exit(1);
}

// 3. Intercambiar el code por tokens
(async () => {
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log("✅ Tokens recibidos:");
    console.log(tokens);

    if (tokens.refresh_token) {
      console.log("\n🔑 COPIÁ este refresh_token a tu archivo .env:");
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    } else {
      console.log("\n⚠️ OJO: no vino refresh_token. Puede ser porque ya diste permiso antes.");
      console.log("En ese caso, borrá permisos en https://myaccount.google.com/permissions y generá uno nuevo.");
    }
  } catch (err) {
    console.error("❌ Error intercambiando code:", err.message);
  }
})();
