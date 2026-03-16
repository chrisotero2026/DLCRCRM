const express = require('express');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Serve index.html ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════════════
//  /api/jarvis/claude  — Proxy to Anthropic (fixes CORS)
//  Jarvis uses this instead of calling Anthropic directly
// ══════════════════════════════════════════════════════
app.post('/api/jarvis/claude', async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({
      error:   'ANTHROPIC_API_KEY not set',
      content: '⚠️ Falta configurar ANTHROPIC_API_KEY en Railway. Ve a Variables y agrégala.'
    });
  }

  const { system, messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const payload = JSON.stringify({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system:     system || 'Eres Jarvis, asistente de DLCR Real Estate & Loans.',
    messages:   messages
  });

  const options = {
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length':    Buffer.byteLength(payload)
    }
  };

  try {
    const result = await new Promise((resolve, reject) => {
      const reqAnth = https.request(options, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.content && parsed.content[0]) {
              resolve({ content: parsed.content[0].text });
            } else if (parsed.error) {
              reject(new Error(parsed.error.message || 'Anthropic error'));
            } else {
              reject(new Error('Empty response from Anthropic'));
            }
          } catch (e) {
            reject(new Error('Parse error: ' + data.slice(0, 200)));
          }
        });
      });
      reqAnth.on('error', reject);
      reqAnth.setTimeout(40000, () => { reqAnth.destroy(); reject(new Error('Timeout')); });
      reqAnth.write(payload);
      reqAnth.end();
    });

    res.json(result);

  } catch (err) {
    console.error('[Jarvis/Claude]', err.message);
    res.status(500).json({
      error:   err.message,
      content: '⚠️ Error conectando con Claude. Intenta de nuevo.'
    });
  }
});

// ══════════════════════════════════════════════════════
//  /api/status — Health check
// ══════════════════════════════════════════════════════
app.get('/api/status', (req, res) => {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  res.json({
    status:    'ok',
    claude:    hasKey ? 'connected' : 'missing_key',
    timestamp: Date.now()
  });
});

// ── Legacy endpoints (keep for compatibility) ──
app.post('/api/chat', (req, res) => {
  res.json({ reply: 'Por favor actualiza la app para usar la nueva versión de Jarvis.', action: 'chat_reply' });
});

app.post('/api/jarvis/command', (req, res) => {
  res.json({ raw: null, reply: 'Endpoint legacy — usa /api/jarvis/claude' });
});

app.get('/api/memory',         (req, res) => res.json({ facts: [] }));
app.post('/api/memory/add',    (req, res) => res.json({ ok: true }));
app.post('/api/memory/clear',  (req, res) => res.json({ ok: true }));

// ── Start server ──
app.listen(PORT, () => {
  console.log(`✅ DLCR Jarvis server running on port ${PORT}`);
  console.log(`🔑 Anthropic API Key: ${process.env.ANTHROPIC_API_KEY ? 'SET ✅' : 'MISSING ⚠️'}`);
});
