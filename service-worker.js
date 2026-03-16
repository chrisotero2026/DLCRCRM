const express = require('express');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

// Serve index.html from root (Railway deploys all files at root)
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ══════════════════════════════════════════════════════
//  /api/jarvis/claude  — Proxy to Anthropic (fixes CORS)
// ══════════════════════════════════════════════════════
app.post('/api/jarvis/claude', async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({
      error:   'ANTHROPIC_API_KEY not set',
      content: 'Falta configurar ANTHROPIC_API_KEY en Railway Variables.'
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
      content: 'Error conectando con Claude. Intenta de nuevo.'
    });
  }
});

// ── Health check ──
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', claude: !!process.env.ANTHROPIC_API_KEY ? 'connected' : 'missing_key' });
});

// ── Legacy endpoints ──
app.post('/api/chat',           (req, res) => res.json({ reply: 'Usa Jarvis AI para chatear.' }));
app.post('/api/jarvis/command', (req, res) => res.json({ raw: null }));
app.get('/api/memory',          (req, res) => res.json({ facts: [] }));

app.listen(PORT, () => {
  console.log('DLCR Jarvis running on port', PORT);
  console.log('Anthropic API Key:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING');
});
