// ═══════════════════════════════════════════════════════════
//  JARVIS DLCR — server.js
//  ElevenLabs + Twilio + Claude AI
//  Number: +1 571-444-8780
// ═══════════════════════════════════════════════════════════

const express    = require('express');
const cors       = require('cors');
const Anthropic  = require('@anthropic-ai/sdk');
const twilio     = require('twilio');

const app  = express();
const port = process.env.PORT || 3000;

// ── Credentials ──────────────────────────────────────────
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'qHkrJuifPpn95wK3rm2A';
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '+15714448780';
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;

const anthropic     = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const twilioClient  = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ═══════════════════════════════════════════════════════════
//  1. JARVIS AI CHAT  (existing endpoint — kept intact)
// ═══════════════════════════════════════════════════════════
app.post('/api/jarvis', async (req, res) => {
  try {
    const { messages, systemPrompt, memory } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const sysContent = systemPrompt || `You are Jarvis, the AI assistant for DLCR Real Estate & Loans. 
You speak both English and Spanish fluently. Always respond in the same language the user writes in.
You help real estate agents manage clients, schedule calls, analyze leads, and close deals.
Be professional, concise, and proactive.${memory ? `\n\nMemory: ${memory}` : ''}`;

    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system:     sysContent,
      messages,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search'
      }]
    });

    res.json({ content: response.content, usage: response.usage });
  } catch (err) {
    console.error('Jarvis chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  2. TEXT-TO-SPEECH  — ElevenLabs
//  POST /api/speak  { text: "Hello", voice_id: "..." }
// ═══════════════════════════════════════════════════════════
app.post('/api/speak', async (req, res) => {
  try {
    const { text, voice_id } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const vid = voice_id || ELEVENLABS_VOICE_ID;

    const elevenRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${vid}`,
      {
        method:  'POST',
        headers: {
          'xi-api-key':    ELEVENLABS_API_KEY,
          'Content-Type':  'application/json',
          'Accept':        'audio/mpeg'
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability:        0.5,
            similarity_boost: 0.8,
            style:            0.2,
            use_speaker_boost: true
          }
        })
      }
    );

    if (!elevenRes.ok) {
      const errText = await elevenRes.text();
      console.error('ElevenLabs error:', errText);
      return res.status(elevenRes.status).json({ error: errText });
    }

    const audioBuffer = Buffer.from(await elevenRes.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.send(audioBuffer);

  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  3. SEND SMS  — Twilio
//  POST /api/sms/send  { to: "+15551234567", body: "Hello" }
// ═══════════════════════════════════════════════════════════
app.post('/api/sms/send', async (req, res) => {
  try {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to and body required' });

    const message = await twilioClient.messages.create({
      body,
      from: TWILIO_PHONE_NUMBER,
      to
    });

    res.json({ success: true, sid: message.sid, status: message.status });
  } catch (err) {
    console.error('SMS send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  4. RECEIVE SMS WEBHOOK  — Twilio → Jarvis AI → Reply
//  POST /api/sms/incoming
// ═══════════════════════════════════════════════════════════
app.post('/api/sms/incoming', async (req, res) => {
  try {
    const { From, Body, To } = req.body;
    console.log(`📱 SMS from ${From}: ${Body}`);

    // Generate Jarvis AI reply
    const aiReply = await getJarvisReply(From, Body, 'sms');

    // Reply via Twilio TwiML
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiReply);

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    console.error('SMS incoming error:', err);
    // Always return valid TwiML even on error
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Hola! Soy Jarvis de DLCR. Un agente te contactará pronto.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// ═══════════════════════════════════════════════════════════
//  5. INBOUND CALL WEBHOOK  — Twilio → ElevenLabs Voice
//  POST /api/call/incoming
// ═══════════════════════════════════════════════════════════
app.post('/api/call/incoming', async (req, res) => {
  try {
    const { From, To } = req.body;
    console.log(`📞 Inbound call from ${From}`);

    const greeting = `Gracias por llamar a DLCR Real Estate and Loans. 
Soy Jarvis, el asistente virtual. 
¿En qué puedo ayudarte hoy? 
¿Estás interesado en comprar, vender, o refinanciar una propiedad?`;

    // Get ElevenLabs audio URL for greeting
    const twiml = new twilio.twiml.VoiceResponse();

    // Use ElevenLabs stream via <Connect> or fallback to <Say>
    twiml.connect().stream({
      url: `wss://${req.get('host')}/api/call/stream`
    });

    // Fallback: if streaming not available, use <Say>
    // twiml.say({ voice: 'Polly.Lupe', language: 'es-US' }, greeting);

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    console.error('Inbound call error:', err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Lupe', language: 'es-US' },
      'Gracias por llamar a DLCR. Un agente te contactará pronto.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// ═══════════════════════════════════════════════════════════
//  6. OUTBOUND CALL  — Initiate call from CRM
//  POST /api/call/outbound  { to: "+15551234567", message: "..." }
// ═══════════════════════════════════════════════════════════
app.post('/api/call/outbound', async (req, res) => {
  try {
    const { to, message, agentName } = req.body;
    if (!to) return res.status(400).json({ error: 'to required' });

    const callMessage = message ||
      `Hola, le llamo de parte de DLCR Real Estate and Loans. 
      ${agentName ? `Mi nombre es ${agentName}.` : ''} 
      ¿Tiene un momento para hablar sobre bienes raíces?`;

    const call = await twilioClient.calls.create({
      twiml: `<Response>
        <Say voice="Polly.Lupe" language="es-US">${callMessage}</Say>
        <Pause length="2"/>
        <Say voice="Polly.Lupe" language="es-US">Presione 1 para hablar con un agente, o cuelgue para recibir una llamada de vuelta.</Say>
        <Gather numDigits="1" action="/api/call/gather" method="POST"/>
      </Response>`,
      to,
      from: TWILIO_PHONE_NUMBER,
      statusCallback: `https://${req.get('host')}/api/call/status`,
      statusCallbackMethod: 'POST'
    });

    res.json({ success: true, callSid: call.sid, status: call.status });
  } catch (err) {
    console.error('Outbound call error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  7. CALL GATHER WEBHOOK  — Handle keypress
//  POST /api/call/gather
// ═══════════════════════════════════════════════════════════
app.post('/api/call/gather', async (req, res) => {
  const { Digits } = req.body;
  const twiml = new twilio.twiml.VoiceResponse();

  if (Digits === '1') {
    twiml.say({ voice: 'Polly.Lupe', language: 'es-US' },
      'Perfecto, conectándolo con un agente ahora mismo. Un momento por favor.');
    twiml.dial(TWILIO_PHONE_NUMBER);
  } else {
    twiml.say({ voice: 'Polly.Lupe', language: 'es-US' },
      'Gracias por su interés. Un agente le llamará pronto. ¡Que tenga un buen día!');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════
//  8. CALL STATUS WEBHOOK
//  POST /api/call/status
// ═══════════════════════════════════════════════════════════
app.post('/api/call/status', (req, res) => {
  const { CallSid, CallStatus, From, To, Duration } = req.body;
  console.log(`📞 Call ${CallSid} status: ${CallStatus} | Duration: ${Duration}s`);
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════
//  9. JARVIS AI HELPER
// ═══════════════════════════════════════════════════════════
async function getJarvisReply(from, text, channel) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You are Jarvis, the AI assistant for DLCR Real Estate & Loans in Virginia.
You respond via ${channel}. Keep replies SHORT (under 160 chars for SMS).
Always respond in Spanish unless the person writes in English.
Your goal: qualify leads, schedule appointments, answer real estate questions.
DLCR phone: ${TWILIO_PHONE_NUMBER}`,
      messages: [{ role: 'user', content: `Message from ${from}: ${text}` }]
    });
    return response.content[0].text;
  } catch (err) {
    return 'Hola! Soy Jarvis de DLCR Real Estate. ¿En qué puedo ayudarte?';
  }
}

// ═══════════════════════════════════════════════════════════
//  SERVE index.html  — CRM Frontend
// ═══════════════════════════════════════════════════════════
const path = require('path');
const fs   = require('fs');

// Serve static files from root directory
app.use(express.static(path.join(__dirname)));

// Root → serve the CRM
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ status: 'Jarvis DLCR Server — Online ✅', version: '2.0.0' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', version: '2.0.0' });
});

app.listen(port, () => {
  console.log(`🤖 Jarvis DLCR server running on port ${port}`);
  console.log(`📞 Twilio number: ${TWILIO_PHONE_NUMBER}`);
  console.log(`🎙️  ElevenLabs Voice: ${ELEVENLABS_VOICE_ID}`);
});
