require('dotenv').config();
const { google } = require('googleapis');
const { URL } = require('url');

function must(k){ const v=process.env[k]; if(!v){console.error('Falta',k); process.exit(1)}; return v; }

const CLIENT_ID = must('GOOGLE_CLIENT_ID');
const CLIENT_SECRET = must('GOOGLE_CLIENT_SECRET');
const REDIRECT_URI = must('GOOGLE_REDIRECT_URI');

console.log('CLIENT_ID         =', CLIENT_ID);
console.log('GOOGLE_REDIRECT_URI =', REDIRECT_URI);

const oauth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const authUrl = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/calendar'],
});

console.log('\nAbrí este link:\n', authUrl, '\n');

const parsed = new URL(authUrl);
console.log('redirect_uri QUE LEE GOOGLE =', parsed.searchParams.get('redirect_uri'));
console.log('client_id   QUE LEE GOOGLE =', parsed.searchParams.get('client_id'));
console.log('\n→ Si alguno NO coincide EXACTO con lo configurado en el cliente OAuth, va a fallar.\n');
