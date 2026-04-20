// ═══════════════════════════════════════════════════════════
// JARVIS DLCR — server.js v2.0
// ElevenLabs + Twilio + Claude AI + Lead Management + Agent Network
// Number: +1 571-444-8780
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const twilio  = require('twilio');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const port = process.env.PORT || 3000;

// ── Credentials ──────────────────────────────────────────
const ELEVENLABS_API_KEY   = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID  = process.env.ELEVENLABS_VOICE_ID || 'qHkrJuifPpn95wK3rm2A';
const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER  = process.env.TWILIO_PHONE_NUMBER || '+15714448780';
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const CRM_API_KEY          = process.env.CRM_API_KEY || 'dlcr-autopilot-2026';

const anthropic    = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ═══════════════════════════════════════════════════════════
// IN-MEMORY DATA STORE
// (Production: replace with PostgreSQL/MongoDB on Railway)
// ═══════════════════════════════════════════════════════════
const dataStore = {
  leads: [],       // { id, type, name, phone, email, address, city, state, zip, budget, timeline, score, status, source, assignedTo, notes, createdAt, updatedAt }
  agents: [],      // { id, name, license, phone, email, zones[], experience, splitPercent, status, leadsAssigned, leadsClosed, totalRevenue, createdAt }
  assignments: [], // { id, leadId, agentId, status, assignedAt, acceptedAt, closedAt, notes }
  deals: [],       // { id, leadId, agentId, salePrice, commissionPercent, totalCommission, dlcrSplit, agentSplit, status, closedAt }
  smsLog: []       // { id, from, to, body, direction, leadId, agentId, timestamp }
};

let nextId = { lead: 1, agent: 1, assignment: 1, deal: 1, sms: 1 };

// ── Helper: Simple API key auth for LocalAI ────────────────
function authCheck(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key && key === CRM_API_KEY) return next();
  // Allow requests from landing pages (no auth for lead submission)
  if (req.path === '/api/leads' && req.method === 'POST') return next();
  if (req.path === '/api/buyer-leads' && req.method === 'POST') return next();
  if (req.path === '/api/agents' && req.method === 'POST') return next();
  // Allow Twilio webhooks
  if (req.path.startsWith('/api/sms/') || req.path.startsWith('/api/call/')) return next();
  // Require key for everything else
  if (!key) return res.status(401).json({ error: 'API key required. Set x-api-key header.' });
  return res.status(403).json({ error: 'Invalid API key' });
}

// Apply auth to /api routes only
app.use('/api/leads', (req, res, next) => {
  if (req.method === 'POST') return next(); // Public: anyone can submit a lead
  return authCheck(req, res, next);          // Protected: GET requires key
});
app.use('/api/buyer-leads', (req, res, next) => {
  if (req.method === 'POST') return next();
  return authCheck(req, res, next);
});
app.use('/api/agents', (req, res, next) => {
  if (req.method === 'POST') return next(); // Public: agents can sign up
  return authCheck(req, res, next);
});
app.use('/api/assign', authCheck);
app.use('/api/deals', authCheck);
app.use('/api/report', authCheck);


// ═══════════════════════════════════════════════════════════
// 1. JARVIS AI CHAT (existing — kept intact)
// ═══════════════════════════════════════════════════════════
app.post('/api/jarvis', async (req, res) => {
  try {
    const { messages, systemPrompt, memory } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }
    const sysContent = systemPrompt ||
      `You are Jarvis, the AI assistant for DLCR Real Estate & Loans. You speak both English and Spanish fluently. Always respond in the same language the user writes in. You help real estate agents manage clients, schedule calls, analyze leads, and close deals. Be professional, concise, and proactive.${memory ? `\n\nMemory: ${memory}` : ''}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: sysContent,
      messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    });
    res.json({ content: response.content, usage: response.usage });
  } catch (err) {
    console.error('Jarvis chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jarvis/claude', async (req, res) => {
  req.url = '/api/jarvis';
  return app._router.handle(req, res, () => {});
});


// ═══════════════════════════════════════════════════════════
// 2. TEXT-TO-SPEECH — ElevenLabs (existing — kept intact)
// ═══════════════════════════════════════════════════════════
app.post('/api/speak', async (req, res) => {
  try {
    const { text, voice_id } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const vid = voice_id || ELEVENLABS_VOICE_ID;
    const elevenRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${vid}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true }
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
// 3. SEND SMS — Twilio (existing — kept intact)
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
// 4. RECEIVE SMS WEBHOOK — with ACCEPT/PASS/CLOSED handling
// ═══════════════════════════════════════════════════════════
app.post('/api/sms/incoming', async (req, res) => {
  try {
    const { From, Body, To } = req.body;
    console.log(`[SMS] From ${From}: ${Body}`);

    // Log the SMS
    dataStore.smsLog.push({
      id: nextId.sms++,
      from: From,
      to: To,
      body: Body,
      direction: 'incoming',
      timestamp: new Date().toISOString()
    });

    const bodyUpper = (Body || '').trim().toUpperCase();

    // ── Agent response: ACCEPT ──
    if (bodyUpper === 'ACCEPT') {
      const assignment = dataStore.assignments.find(
        a => a.status === 'pending' && dataStore.agents.find(
          ag => ag.id === a.agentId && ag.phone === From
        )
      );
      if (assignment) {
        assignment.status = 'accepted';
        assignment.acceptedAt = new Date().toISOString();
        const lead = dataStore.leads.find(l => l.id === assignment.leadId);
        if (lead) {
          lead.status = 'working';
          lead.updatedAt = new Date().toISOString();
        }
        const agent = dataStore.agents.find(a => a.id === assignment.agentId);

        // Send lead details to agent
        if (lead && agent) {
          const details = `Detalles del referral:\nNombre: ${lead.name}\nTel: ${lead.phone}\nEmail: ${lead.email || 'N/A'}\nDireccion: ${lead.address || 'N/A'}\nCiudad: ${lead.city}, ${lead.state}\nTipo: ${lead.type}\nScore: ${lead.score}\nTimeline: ${lead.timeline || 'N/A'}\n\nContactelo dentro de 2 horas.`;
          try {
            await twilioClient.messages.create({ body: details, from: TWILIO_PHONE_NUMBER, to: agent.phone });
          } catch (e) { console.error('[SMS] Error sending details to agent:', e.message); }
        }

        // Notify lead
        if (lead && agent) {
          try {
            await twilioClient.messages.create({
              body: `Hola ${lead.name}! ${agent.name} de De Las Casas Realty le contactara hoy para ayudarle con su propiedad. Gracias!`,
              from: TWILIO_PHONE_NUMBER,
              to: lead.phone
            });
          } catch (e) { console.error('[SMS] Error notifying lead:', e.message); }
        }

        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(`Perfecto! Referral aceptado. Te envie los detalles del cliente. Contactalo dentro de 2 horas.`);
        res.type('text/xml');
        return res.send(twiml.toString());
      }
    }

    // ── Agent response: PASS ──
    if (bodyUpper === 'PASS') {
      const assignment = dataStore.assignments.find(
        a => (a.status === 'pending' || a.status === 'accepted') && dataStore.agents.find(
          ag => ag.id === a.agentId && ag.phone === From
        )
      );
      if (assignment) {
        assignment.status = 'passed';
        const lead = dataStore.leads.find(l => l.id === assignment.leadId);
        if (lead) {
          lead.status = 'unassigned';
          lead.assignedTo = null;
          lead.updatedAt = new Date().toISOString();
        }

        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message('Entendido. El lead sera reasignado a otro agente. Gracias!');
        res.type('text/xml');
        return res.send(twiml.toString());
      }
    }

    // ── Agent response: CLOSED [price] ──
    if (bodyUpper.startsWith('CLOSED')) {
      const priceMatch = Body.match(/\d[\d,.]*/);
      const price = priceMatch ? parseFloat(priceMatch[0].replace(/,/g, '')) : 0;

      const agent = dataStore.agents.find(a => a.phone === From);
      if (agent && price > 0) {
        const assignment = dataStore.assignments.find(
          a => a.agentId === agent.id && (a.status === 'accepted' || a.status === 'working')
        );
        if (assignment) {
          assignment.status = 'closed';
          assignment.closedAt = new Date().toISOString();

          const lead = dataStore.leads.find(l => l.id === assignment.leadId);
          if (lead) {
            lead.status = 'closed';
            lead.updatedAt = new Date().toISOString();
          }

          const commissionPercent = 3;
          const totalCommission = price * (commissionPercent / 100);
          const splitPercent = agent.splitPercent || 25;
          const dlcrSplit = totalCommission * (splitPercent / 100);
          const agentSplit = totalCommission - dlcrSplit;

          const deal = {
            id: nextId.deal++,
            leadId: assignment.leadId,
            agentId: agent.id,
            salePrice: price,
            commissionPercent,
            totalCommission,
            dlcrSplit,
            agentSplit,
            splitPercent,
            status: 'closed',
            closedAt: new Date().toISOString()
          };
          dataStore.deals.push(deal);

          // Update agent stats
          agent.leadsClosed = (agent.leadsClosed || 0) + 1;
          agent.totalRevenue = (agent.totalRevenue || 0) + agentSplit;

          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message(`Felicidades por el cierre! Venta: $${price.toLocaleString()}. Comision total: $${totalCommission.toLocaleString()}. Tu parte: $${agentSplit.toLocaleString()}. Referral fee DLCR: $${dlcrSplit.toLocaleString()}. Gracias!`);
          res.type('text/xml');
          return res.send(twiml.toString());
        }
      }
    }

    // ── Agent response: UPDATE [status] ──
    if (bodyUpper.startsWith('UPDATE')) {
      const statusText = Body.substring(6).trim();
      const agent = dataStore.agents.find(a => a.phone === From);
      if (agent) {
        const assignment = dataStore.assignments.find(
          a => a.agentId === agent.id && (a.status === 'accepted' || a.status === 'working')
        );
        if (assignment) {
          assignment.notes = (assignment.notes || '') + `\n[${new Date().toISOString()}] ${statusText}`;
          assignment.status = 'working';

          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message('Update registrado. Gracias por el reporte!');
          res.type('text/xml');
          return res.send(twiml.toString());
        }
      }
    }

    // ── Default: AI reply for unknown messages ──
    const aiReply = await getJarvisReply(From, Body, 'sms');
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiReply);
    res.type('text/xml');
    res.send(twiml.toString());

  } catch (err) {
    console.error('SMS incoming error:', err);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Hola! Soy Jarvis de DLCR. Un agente te contactara pronto.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});


// ═══════════════════════════════════════════════════════════
// 5. INBOUND CALL (existing — kept intact)
// ═══════════════════════════════════════════════════════════
app.post('/api/call/incoming', async (req, res) => {
  try {
    const { From, To } = req.body;
    console.log(`[CALL] Inbound from ${From}`);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.connect().stream({ url: `wss://${req.get('host')}/api/call/stream` });
    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    console.error('Inbound call error:', err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Lupe', language: 'es-US' }, 'Gracias por llamar a DLCR. Un agente te contactara pronto.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});


// ═══════════════════════════════════════════════════════════
// 6. OUTBOUND CALL (existing — kept intact)
// ═══════════════════════════════════════════════════════════
app.post('/api/call/outbound', async (req, res) => {
  try {
    const { to, message, agentName } = req.body;
    if (!to) return res.status(400).json({ error: 'to required' });

    const callMessage = message || `Hola, le llamo de parte de DLCR Real Estate and Loans. ${agentName ? `Mi nombre es ${agentName}.` : ''} Tiene un momento para hablar sobre bienes raices?`;

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
// 7. CALL GATHER + STATUS (existing — kept intact)
// ═══════════════════════════════════════════════════════════
app.post('/api/call/gather', async (req, res) => {
  const { Digits } = req.body;
  const twiml = new twilio.twiml.VoiceResponse();
  if (Digits === '1') {
    twiml.say({ voice: 'Polly.Lupe', language: 'es-US' }, 'Perfecto, conectandolo con un agente ahora mismo.');
    twiml.dial(TWILIO_PHONE_NUMBER);
  } else {
    twiml.say({ voice: 'Polly.Lupe', language: 'es-US' }, 'Gracias por su interes. Un agente le llamara pronto.');
    twiml.hangup();
  }
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/api/call/status', (req, res) => {
  const { CallSid, CallStatus, Duration } = req.body;
  console.log(`[CALL] ${CallSid} status: ${CallStatus} | Duration: ${Duration}s`);
  res.sendStatus(200);
});


// ═══════════════════════════════════════════════════════════
// 8. JARVIS AI HELPER (existing — kept intact)
// ═══════════════════════════════════════════════════════════
async function getJarvisReply(from, text, channel) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You are Jarvis, the AI assistant for DLCR Real Estate & Loans in Virginia. You respond via ${channel}. Keep replies SHORT (under 160 chars for SMS). Always respond in Spanish unless the person writes in English. Your goal: qualify leads, schedule appointments, answer real estate questions. DLCR phone: ${TWILIO_PHONE_NUMBER}`,
      messages: [{ role: 'user', content: `Message from ${from}: ${text}` }]
    });
    return response.content[0].text;
  } catch (err) {
    return 'Hola! Soy Jarvis de DLCR Real Estate. En que puedo ayudarte?';
  }
}


// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
//
//    NEW ENDPOINTS — LEAD & AGENT MANAGEMENT
//
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════
// 9. SELLER LEADS
// POST /api/leads — Submit a new seller lead (public)
// GET  /api/leads — List leads (protected, for LocalAI)
// ═══════════════════════════════════════════════════════════
app.post('/api/leads', async (req, res) => {
  try {
    const { name, phone, email, address, city, state, zip, propertyType, timeline, score, source, budget, notes } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'name and phone are required' });
    }

    const lead = {
      id: nextId.lead++,
      type: 'seller',
      name,
      phone,
      email: email || '',
      address: address || '',
      city: city || '',
      state: state || 'VA',
      zip: zip || '',
      propertyType: propertyType || '',
      budget: budget || '',
      timeline: timeline || '',
      score: score || 0,
      status: 'new',
      source: source || 'dlcrhv.com',
      assignedTo: null,
      notes: notes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    dataStore.leads.push(lead);
    console.log(`[LEAD] New seller lead #${lead.id}: ${name} (${city}, ${state}) Score: ${score}`);

    // Auto-send welcome SMS
    if (phone) {
      try {
        await twilioClient.messages.create({
          body: `Gracias por contactar De Las Casas Realty, ${name}! Un agente especializado en su area le contactara dentro de las proximas 2 horas. Si tiene preguntas, responda a este mensaje.`,
          from: TWILIO_PHONE_NUMBER,
          to: phone
        });
        console.log(`[SMS] Welcome SMS sent to ${phone}`);
      } catch (smsErr) {
        console.error('[SMS] Welcome SMS failed:', smsErr.message);
      }
    }

    res.status(201).json({ success: true, lead });

  } catch (err) {
    console.error('Lead creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads', (req, res) => {
  try {
    let results = [...dataStore.leads];

    // Filters
    if (req.query.status)  results = results.filter(l => l.status === req.query.status);
    if (req.query.type)    results = results.filter(l => l.type === req.query.type);
    if (req.query.zip)     results = results.filter(l => l.zip === req.query.zip);
    if (req.query.city)    results = results.filter(l => l.city.toLowerCase().includes(req.query.city.toLowerCase()));
    if (req.query.state)   results = results.filter(l => l.state === req.query.state);
    if (req.query.minScore) results = results.filter(l => l.score >= parseInt(req.query.minScore));

    // Sort by newest first
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Limit
    const limit = parseInt(req.query.limit) || 50;
    results = results.slice(0, limit);

    res.json({ success: true, count: results.length, total: dataStore.leads.length, leads: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id', (req, res) => {
  const lead = dataStore.leads.find(l => l.id === parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json({ success: true, lead });
});

app.put('/api/leads/:id', (req, res) => {
  const lead = dataStore.leads.find(l => l.id === parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const allowed = ['status', 'assignedTo', 'notes', 'score', 'city', 'state', 'zip'];
  allowed.forEach(field => {
    if (req.body[field] !== undefined) lead[field] = req.body[field];
  });
  lead.updatedAt = new Date().toISOString();

  res.json({ success: true, lead });
});


// ═══════════════════════════════════════════════════════════
// 10. BUYER LEADS
// POST /api/buyer-leads — Submit a new buyer lead (public)
// ═══════════════════════════════════════════════════════════
app.post('/api/buyer-leads', async (req, res) => {
  try {
    const { name, phone, email, area, city, state, zip, budget, timeline, preApproved, source, notes } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'name and phone are required' });
    }

    const lead = {
      id: nextId.lead++,
      type: 'buyer',
      name,
      phone,
      email: email || '',
      address: '',
      city: city || area || '',
      state: state || 'VA',
      zip: zip || '',
      propertyType: '',
      budget: budget || '',
      timeline: timeline || '',
      preApproved: preApproved || false,
      score: preApproved ? 80 : 50, // Pre-approved buyers score higher
      status: 'new',
      source: source || 'dlcrhb.com',
      assignedTo: null,
      notes: notes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    dataStore.leads.push(lead);
    console.log(`[LEAD] New buyer lead #${lead.id}: ${name} (${lead.city}, ${lead.state}) Budget: ${budget}`);

    // Auto-send welcome SMS
    if (phone) {
      try {
        await twilioClient.messages.create({
          body: `Gracias por contactar De Las Casas Realty, ${name}! Un agente de su zona le contactara pronto para ayudarle a encontrar su hogar ideal. Responda a este mensaje si tiene preguntas.`,
          from: TWILIO_PHONE_NUMBER,
          to: phone
        });
      } catch (smsErr) {
        console.error('[SMS] Welcome SMS failed:', smsErr.message);
      }
    }

    res.status(201).json({ success: true, lead });

  } catch (err) {
    console.error('Buyer lead creation error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════
// 11. AGENTS — Registration & Management
// POST /api/agents — Register new agent (public)
// GET  /api/agents — List agents (protected)
// PUT  /api/agents/:id — Update agent (protected)
// ═══════════════════════════════════════════════════════════
app.post('/api/agents', async (req, res) => {
  try {
    const { name, license, phone, email, zones, experience, splitPercent, languages } = req.body;

    if (!name || !phone || !license) {
      return res.status(400).json({ error: 'name, phone, and license are required' });
    }

    const agent = {
      id: nextId.agent++,
      name,
      license,
      phone,
      email: email || '',
      zones: zones || [],         // Array of ZIP codes or city names
      experience: experience || '',
      splitPercent: splitPercent || 25,  // DLCR takes 25% of commission by default
      languages: languages || ['es', 'en'],
      status: 'pending',          // pending -> active (Chris approves)
      leadsAssigned: 0,
      leadsClosed: 0,
      totalRevenue: 0,
      responseRate: 100,
      avgResponseTime: 0,
      createdAt: new Date().toISOString()
    };

    dataStore.agents.push(agent);
    console.log(`[AGENT] New agent registered #${agent.id}: ${name} (License: ${license})`);

    // Welcome SMS to agent
    if (phone) {
      try {
        await twilioClient.messages.create({
          body: `Bienvenido a De Las Casas Realty Referral Network, ${name}! Su solicitud esta siendo revisada. Le notificaremos cuando este aprobado para recibir referrals. $0 costo — solo split al cierre. Gracias!`,
          from: TWILIO_PHONE_NUMBER,
          to: phone
        });
      } catch (smsErr) {
        console.error('[SMS] Agent welcome SMS failed:', smsErr.message);
      }
    }

    res.status(201).json({ success: true, agent });

  } catch (err) {
    console.error('Agent registration error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents', (req, res) => {
  try {
    let results = [...dataStore.agents];

    if (req.query.status) results = results.filter(a => a.status === req.query.status);
    if (req.query.zone) {
      const zone = req.query.zone.toLowerCase();
      results = results.filter(a =>
        a.zones.some(z => z.toLowerCase().includes(zone))
      );
    }

    res.json({ success: true, count: results.length, agents: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:id', (req, res) => {
  const agent = dataStore.agents.find(a => a.id === parseInt(req.params.id));
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ success: true, agent });
});

app.put('/api/agents/:id', (req, res) => {
  const agent = dataStore.agents.find(a => a.id === parseInt(req.params.id));
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const allowed = ['status', 'zones', 'splitPercent', 'experience', 'phone', 'email'];
  allowed.forEach(field => {
    if (req.body[field] !== undefined) agent[field] = req.body[field];
  });

  // If activating agent, send notification
  if (req.body.status === 'active' && agent.phone) {
    twilioClient.messages.create({
      body: `${agent.name}, su cuenta en De Las Casas Realty Referral Network ha sido APROBADA! Ya puede recibir referrals. Cuando reciba un lead, responda ACCEPT o PASS. Al cerrar, envie CLOSED [precio]. Bienvenido!`,
      from: TWILIO_PHONE_NUMBER,
      to: agent.phone
    }).catch(e => console.error('[SMS] Agent activation SMS failed:', e.message));
  }

  res.json({ success: true, agent });
});


// ═══════════════════════════════════════════════════════════
// 12. ASSIGNMENTS — Assign leads to agents
// POST /api/assign — Create assignment
// GET  /api/assignments — List assignments
// ═══════════════════════════════════════════════════════════
app.post('/api/assign', async (req, res) => {
  try {
    const { leadId, agentId } = req.body;
    if (!leadId || !agentId) return res.status(400).json({ error: 'leadId and agentId required' });

    const lead = dataStore.leads.find(l => l.id === leadId);
    const agent = dataStore.agents.find(a => a.id === agentId);

    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (agent.status !== 'active') return res.status(400).json({ error: 'Agent is not active' });

    const assignment = {
      id: nextId.assignment++,
      leadId,
      agentId,
      status: 'pending',  // pending -> accepted -> working -> closed
      assignedAt: new Date().toISOString(),
      acceptedAt: null,
      closedAt: null,
      notes: ''
    };

    dataStore.assignments.push(assignment);

    // Update lead
    lead.status = 'assigned';
    lead.assignedTo = agentId;
    lead.updatedAt = new Date().toISOString();

    // Update agent stats
    agent.leadsAssigned = (agent.leadsAssigned || 0) + 1;

    // Notify agent via SMS
    try {
      await twilioClient.messages.create({
        body: `Nuevo referral! ${lead.type === 'seller' ? 'Vendedor' : 'Comprador'} en ${lead.city}, ${lead.state}. Contacto: ${lead.name}. Score: ${lead.score}. Reply ACCEPT o PASS (tienes 30 min).`,
        from: TWILIO_PHONE_NUMBER,
        to: agent.phone
      });
    } catch (smsErr) {
      console.error('[SMS] Assignment notification failed:', smsErr.message);
    }

    console.log(`[ASSIGN] Lead #${leadId} assigned to Agent #${agentId} (${agent.name})`);

    res.status(201).json({ success: true, assignment });

  } catch (err) {
    console.error('Assignment error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/assignments', (req, res) => {
  try {
    let results = [...dataStore.assignments];
    if (req.query.status)  results = results.filter(a => a.status === req.query.status);
    if (req.query.agentId) results = results.filter(a => a.agentId === parseInt(req.query.agentId));
    if (req.query.leadId)  results = results.filter(a => a.leadId === parseInt(req.query.leadId));

    res.json({ success: true, count: results.length, assignments: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════
// 13. DEALS — Track closings & commissions
// POST /api/deals — Register a deal (can also be done via SMS CLOSED)
// GET  /api/deals — List deals
// ═══════════════════════════════════════════════════════════
app.post('/api/deals', async (req, res) => {
  try {
    const { leadId, agentId, salePrice, commissionPercent } = req.body;
    if (!leadId || !agentId || !salePrice) {
      return res.status(400).json({ error: 'leadId, agentId, and salePrice required' });
    }

    const agent = dataStore.agents.find(a => a.id === agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const commPct = commissionPercent || 3;
    const totalCommission = salePrice * (commPct / 100);
    const splitPct = agent.splitPercent || 25;
    const dlcrSplit = totalCommission * (splitPct / 100);
    const agentSplit = totalCommission - dlcrSplit;

    const deal = {
      id: nextId.deal++,
      leadId,
      agentId,
      salePrice,
      commissionPercent: commPct,
      totalCommission,
      dlcrSplit,
      agentSplit,
      splitPercent: splitPct,
      status: 'closed',
      closedAt: new Date().toISOString()
    };

    dataStore.deals.push(deal);

    // Update lead status
    const lead = dataStore.leads.find(l => l.id === leadId);
    if (lead) { lead.status = 'closed'; lead.updatedAt = new Date().toISOString(); }

    // Update agent stats
    agent.leadsClosed = (agent.leadsClosed || 0) + 1;
    agent.totalRevenue = (agent.totalRevenue || 0) + agentSplit;

    // Update assignment
    const assignment = dataStore.assignments.find(a => a.leadId === leadId && a.agentId === agentId);
    if (assignment) { assignment.status = 'closed'; assignment.closedAt = deal.closedAt; }

    console.log(`[DEAL] Deal #${deal.id}: $${salePrice.toLocaleString()} | DLCR: $${dlcrSplit.toLocaleString()} | Agent: $${agentSplit.toLocaleString()}`);

    res.status(201).json({ success: true, deal });

  } catch (err) {
    console.error('Deal creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/deals', (req, res) => {
  try {
    let results = [...dataStore.deals];
    if (req.query.agentId) results = results.filter(d => d.agentId === parseInt(req.query.agentId));

    const totalRevenue = results.reduce((sum, d) => sum + d.dlcrSplit, 0);
    res.json({ success: true, count: results.length, totalDlcrRevenue: totalRevenue, deals: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════
// 14. WEEKLY REPORT — for LocalAI / Chris
// GET /api/report/weekly
// ═══════════════════════════════════════════════════════════
app.get('/api/report/weekly', (req, res) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const newLeads = dataStore.leads.filter(l => new Date(l.createdAt) >= weekAgo);
    const sellerLeads = newLeads.filter(l => l.type === 'seller');
    const buyerLeads = newLeads.filter(l => l.type === 'buyer');
    const assignedLeads = newLeads.filter(l => l.status !== 'new' && l.status !== 'unassigned');
    const unassignedLeads = dataStore.leads.filter(l => l.status === 'new' || l.status === 'unassigned');

    const weekDeals = dataStore.deals.filter(d => new Date(d.closedAt) >= weekAgo);
    const totalRevenue = weekDeals.reduce((sum, d) => sum + d.dlcrSplit, 0);

    const activeAgents = dataStore.agents.filter(a => a.status === 'active');
    const pendingAgents = dataStore.agents.filter(a => a.status === 'pending');

    const staleLeads = dataStore.leads.filter(l => {
      if (l.status === 'closed' || l.status === 'new') return false;
      const age = (now - new Date(l.updatedAt)) / (1000 * 60 * 60 * 24);
      return age > 14;
    });

    const report = {
      period: {
        from: weekAgo.toISOString().split('T')[0],
        to: now.toISOString().split('T')[0]
      },
      leads: {
        total: newLeads.length,
        sellers: sellerLeads.length,
        buyers: buyerLeads.length,
        assigned: assignedLeads.length,
        unassigned: unassignedLeads.length,
        stale: staleLeads.length
      },
      deals: {
        closed: weekDeals.length,
        totalSalesVolume: weekDeals.reduce((sum, d) => sum + d.salePrice, 0),
        totalCommissions: weekDeals.reduce((sum, d) => sum + d.totalCommission, 0),
        dlcrRevenue: totalRevenue,
        details: weekDeals.map(d => {
          const agent = dataStore.agents.find(a => a.id === d.agentId);
          const lead = dataStore.leads.find(l => l.id === d.leadId);
          return {
            agent: agent ? agent.name : 'Unknown',
            city: lead ? lead.city : 'Unknown',
            state: lead ? lead.state : '',
            salePrice: d.salePrice,
            dlcrSplit: d.dlcrSplit,
            agentSplit: d.agentSplit
          };
        })
      },
      agents: {
        active: activeAgents.length,
        pending: pendingAgents.length,
        pendingNames: pendingAgents.map(a => ({ id: a.id, name: a.name, license: a.license, zones: a.zones })),
        topPerformers: activeAgents
          .sort((a, b) => (b.leadsClosed || 0) - (a.leadsClosed || 0))
          .slice(0, 5)
          .map(a => ({ name: a.name, closed: a.leadsClosed, revenue: a.totalRevenue }))
      },
      actionItems: []
    };

    // Build action items
    if (unassignedLeads.length > 0) {
      report.actionItems.push(`${unassignedLeads.length} leads sin asignar — verificar si hay agentes en esas zonas`);
    }
    if (pendingAgents.length > 0) {
      report.actionItems.push(`${pendingAgents.length} agente(s) pendiente(s) de aprobacion: ${pendingAgents.map(a => a.name).join(', ')}`);
    }
    if (staleLeads.length > 0) {
      report.actionItems.push(`${staleLeads.length} lead(s) sin actualizacion en 14+ dias`);
    }

    const highValueLeads = newLeads.filter(l => l.score >= 80);
    if (highValueLeads.length > 0) {
      report.actionItems.push(`${highValueLeads.length} lead(s) de alto valor (score 80+) esta semana`);
    }

    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════
// 15. STATS — Quick dashboard data
// GET /api/stats
// ═══════════════════════════════════════════════════════════
app.get('/api/stats', (req, res) => {
  const totalLeads = dataStore.leads.length;
  const totalDeals = dataStore.deals.length;
  const totalRevenue = dataStore.deals.reduce((sum, d) => sum + d.dlcrSplit, 0);
  const activeAgents = dataStore.agents.filter(a => a.status === 'active').length;
  const pendingLeads = dataStore.leads.filter(l => l.status === 'new' || l.status === 'unassigned').length;

  res.json({
    success: true,
    stats: { totalLeads, totalDeals, totalRevenue, activeAgents, pendingLeads }
  });
});


// ═══════════════════════════════════════════════════════════
// STATIC FILES + ROOT
// ═══════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ status: 'DLCR CRM Server — Online', version: '2.0.0', endpoints: [
      'POST /api/leads', 'POST /api/buyer-leads', 'GET /api/leads',
      'POST /api/agents', 'GET /api/agents', 'PUT /api/agents/:id',
      'POST /api/assign', 'GET /api/assignments',
      'POST /api/deals', 'GET /api/deals',
      'GET /api/report/weekly', 'GET /api/stats',
      'POST /api/jarvis', 'POST /api/speak',
      'POST /api/sms/send', 'POST /api/sms/incoming',
      'POST /api/call/incoming', 'POST /api/call/outbound'
    ]});
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', version: '2.0.0', leads: dataStore.leads.length, agents: dataStore.agents.length, deals: dataStore.deals.length });
});


// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════
app.listen(port, () => {
  console.log(`[SERVER] DLCR CRM running on port ${port}`);
  console.log(`[SERVER] Twilio: ${TWILIO_PHONE_NUMBER}`);
  console.log(`[SERVER] Endpoints: leads, agents, assignments, deals, report, stats`);
  console.log(`[SERVER] Ready for autopilot mode`);
});
