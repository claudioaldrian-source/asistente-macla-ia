// get_token.js
require("dotenv").config();
const { google } = require("googleapis");

// 1. Crear cliente OAuth2
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// 2. Generar URL de autorización
const authUrl = oAuth2Client.generateAuthUrl({
  access_type: "offline",
  scope: ["https://www.googleapis.com/auth/calendar"],
  prompt: "consent"
});

console.log("👉 Abrí este link en tu navegador y aceptá permisos:\n", authUrl);
