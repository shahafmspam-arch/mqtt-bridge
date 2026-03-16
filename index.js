import mqtt from 'mqtt';
import http from 'http';

// ─── Configuration ───────────────────────────────────────────────────────────
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://120.77.232.76:1883';
const MQTT_USERNAME   = process.env.MQTT_USERNAME   || '';
const MQTT_PASSWORD   = process.env.MQTT_PASSWORD   || '';
const MQTT_CLIENT_ID  = process.env.MQTT_CLIENT_ID  || `bridge-${Date.now()}`;
const MQTT_TOPIC_SUB  = process.env.MQTT_TOPIC_SUB  || 'GwData';
const MQTT_TOPIC_PUB  = process.env.MQTT_TOPIC_PUB  || 'SrvData';

const SUPABASE_FUNCTION_URL = process.env.SUPABASE_FUNCTION_URL || '';
const SUPABASE_ANON_KEY     = process.env.SUPABASE_ANON_KEY     || '';
const GATEWAY_USER_ID       = process.env.GATEWAY_USER_ID       || '';

const SELF_URL      = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '';
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL_MS || '240000');
const PORT          = parseInt(process.env.PORT || '10000');

// ─── Health server ───────────────────────────────────────────────────────────
let lastMqttMessage = null;
let mqttConnected = false;
let messagesForwarded = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      mqtt_connected: mqttConnected,
      messages_forwarded: messagesForwarded,
      last_message_at: lastMqttMessage,
      uptime_seconds: Math.floor(process.uptime()),
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`[Bridge] Health server listening on port ${PORT}`);
});

// ─── Self-ping keep-alive ─────────────────────────────────────────────────────
function startSelfPing() {
  if (!SELF_URL) {
    console.log('[Bridge] No SELF_URL set, skipping self-ping');
    return;
  }
  console.log(`[Bridge] Self-ping every ${PING_INTERVAL / 1000}s → ${SELF_URL}/health`);
  setInterval(async () => {
    try {
      const res = await fetch(`${SELF_URL}/health`);
      console.log(`[Ping] ${res.status} at ${new Date().toISOString()}`);
    } catch (err) {
      console.error('[Ping] Failed:', err.message);
    }
  }, PING_INTERVAL);
}

// ─── Decode temperature from tag adv_raw ─────────────────────────────────────
// mTnA tag adv_raw format (hex string):
// 02 01 06 15 16 4C AB 01 1E 64 00 [MAC 6 bytes] [temp_int] [temp_dec] ...
// Byte[18] = integer part, Byte[19] = decimal part
// e.g. 0x0F=15, 0x08=8 → 15.08°C
function parseAdvTemperature(advRaw) {
  try {
    if (!advRaw || advRaw.length < 40) return null;
    const bytes = [];
    for (let i = 0; i < advRaw.length; i += 2) {
      bytes.push(parseInt(advRaw.substr(i, 2), 16));
    }
    if (bytes.length < 20) return null;

    // Check for mTnA vendor prefix: AD type 0x16, UUID 0x4CAB
    if (bytes[4] === 0x16 && bytes[5] === 0x4C && bytes[6] === 0xAB) {
      const intPart = bytes[18];
      const decPart = bytes[19];
      const temp = intPart + decPart / 100;
      if (temp >= 0 && temp <= 50) return parseFloat(temp.toFixed(2));
    }

    return null;
  } catch (e) {
    return null;
  }
}

// ─── Parse gateway payload ────────────────────────────────────────────────────
function parseGatewayPayload(raw) {
  try {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (msg.readings && Array.isArray(msg.readings)) {
      return { user_id: msg.user_id || GATEWAY_USER_ID, readings: msg.readings };
    }

    if (msg.pkt_type === 'state') return null;

    // Only process messages from our gateway
    const ALLOWED_GATEWAYS = ['f1f829cf5e94'];
    if (msg.gw_addr && !ALLOWED_GATEWAYS.includes(msg.gw_addr.toLowerCase())) {
      return null;
    }

    if (msg.pkt_type === 'scan_report' || msg.pkt_type === 'stuff_card') {
      const devList = msg.data?.dev_infos ?? msg.data?.devices ?? msg.devices ?? [];
      if (!Array.isArray(devList) || devList.length === 0) return null;

      const readings = devList.map(dev => ({
        tag_mac:      dev.addr  || dev.mac  || '',
        rssi:         dev.rssi  ?? 0,
        temperature:  dev.temperature ?? dev.temp ?? parseAdvTemperature(dev.adv_raw) ?? 0,
        motion_state: dev.motion_state ?? dev.motion ?? 0,
        battery_mv:   dev.battery_mv ?? dev.battery ?? dev.vbatt ?? dev.batt ?? 0,
        name:         dev.name  || '',
      })).filter(r => r.tag_mac);

      if (readings.length === 0) return null;
      return { user_id: GATEWAY_USER_ID, gw_addr: msg.gw_addr, readings };
    }

    console.log('[Bridge] Unknown payload format:', JSON.stringify(msg).slice(0, 200));
    return null;
  } catch (err) {
    console.error('[Bridge] Parse error:', err.message);
    return null;
  }
}

// ─── Forward to Supabase ──────────────────────────────────────────────────────
async function forwardToSupabase(payload) {
  if (!SUPABASE_FUNCTION_URL) {
    console.error('[Bridge] SUPABASE_FUNCTION_URL not set!');
    return;
  }
  try {
    const res = await fetch(SUPABASE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    console.log(`[Bridge] → Supabase ${res.status}:`, JSON.stringify(result));
    messagesForwarded++;
  } catch (err) {
    console.error('[Bridge] Forward error:', err.message);
  }
}

// ─── MQTT client ──────────────────────────────────────────────────────────────
console.log(`[Bridge] Connecting to MQTT broker: ${MQTT_BROKER_URL}`);

const client = mqtt.connect(MQTT_BROKER_URL, {
  clientId: MQTT_CLIENT_ID,
  username: MQTT_USERNAME || undefined,
  password: MQTT_PASSWORD || undefined,
  reconnectPeriod: 5000,
  connectTimeout: 30000,
});

client.on('connect', () => {
  mqttConnected = true;
  console.log('[Bridge] MQTT connected!');
  client.subscribe(MQTT_TOPIC_SUB, { qos: 0 }, (err) => {
    if (err) console.error('[Bridge] Subscribe error:', err.message);
    else console.log(`[Bridge] Subscribed to topic: ${MQTT_TOPIC_SUB}`);
  });
});

client.on('message', async (topic, message) => {
  lastMqttMessage = new Date().toISOString();
  const raw = message.toString();
  console.log(`[Bridge] MQTT message on ${topic}: ${raw.slice(0, 500)}`);

  const payload = parseGatewayPayload(raw);
  if (payload && payload.readings?.length > 0) {
    await forwardToSupabase(payload);
  }
});

client.on('error', (err) => {
  console.error('[Bridge] MQTT error:', err.message);
});

client.on('close', () => {
  mqttConnected = false;
  console.log('[Bridge] MQTT disconnected, will reconnect...');
});

client.on('reconnect', () => {
  console.log('[Bridge] MQTT reconnecting...');
});

setInterval(() => {
  if (mqttConnected) {
    const heartbeat = JSON.stringify({ type: 'heartbeat', ts: Date.now() });
    client.publish(MQTT_TOPIC_PUB, heartbeat, { qos: 0 });
    console.log(`[Bridge] Heartbeat sent on ${MQTT_TOPIC_PUB}`);
  }
}, 60000);

startSelfPing();
console.log('[Bridge] MQTT-to-HTTP bridge started.');
