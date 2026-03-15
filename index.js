import mqtt from 'mqtt';
import http from 'http';

// ─── Configuration (set these as Render environment variables) ───
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://120.77.232.76:1883';
const MQTT_USERNAME   = process.env.MQTT_USERNAME   || '';
const MQTT_PASSWORD   = process.env.MQTT_PASSWORD   || '';
const MQTT_CLIENT_ID  = process.env.MQTT_CLIENT_ID  || `bridge-${Date.now()}`;
const MQTT_TOPIC_SUB  = process.env.MQTT_TOPIC_SUB  || 'GwData';
const MQTT_TOPIC_PUB  = process.env.MQTT_TOPIC_PUB  || 'SrvData';

const SUPABASE_FUNCTION_URL = process.env.SUPABASE_FUNCTION_URL || '';
const SUPABASE_ANON_KEY     = process.env.SUPABASE_ANON_KEY     || '';
const GATEWAY_USER_ID       = process.env.GATEWAY_USER_ID       || '';

// Self-ping to keep Render free tier alive
const SELF_URL        = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '';
const PING_INTERVAL   = parseInt(process.env.PING_INTERVAL_MS || '240000'); // 4 minutes

const PORT = parseInt(process.env.PORT || '10000');

// ─── Health check HTTP server (required by Render) ───
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

// ─── Self-ping keep-alive ───
function startSelfPing() {
  if (!SELF_URL) {
    console.log('[Bridge] No SELF_URL set, skipping self-ping (set RENDER_EXTERNAL_URL)');
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

// ─── Parse gateway BLE data into readings ───
function parseGatewayPayload(raw) {
  // The HCBG01 sends various pkt_type messages.
  // We look for scan_report or stuff_card with device data.
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // If the gateway sends pre-formatted readings (custom firmware/config)
    if (data.readings && Array.isArray(data.readings)) {
      return { user_id: data.user_id || GATEWAY_USER_ID, readings: data.readings };
    }

    // HCBG01 stuff_card format: array of device reports
    if (data.pkt_type === 'stuff_card' && Array.isArray(data.devices)) {
      const readings = data.devices.map(dev => ({
        tag_mac: dev.mac || dev.addr || '',
        temperature: dev.temperature ?? dev.temp ?? 0,
        motion_state: dev.motion_state ?? dev.motion ?? 0,
        rssi: dev.rssi ?? 0,
        battery_mv: dev.battery_mv ?? dev.battery ?? dev.vbatt ?? 0,
      })).filter(r => r.tag_mac);

      return { user_id: GATEWAY_USER_ID, readings };
    }

    // HCBG01 scan_report format
    if (data.pkt_type === 'scan_report' && Array.isArray(data.devices)) {
      const readings = data.devices.map(dev => ({
        tag_mac: dev.mac || dev.addr || '',
        temperature: dev.temperature ?? 0,
        motion_state: dev.motion_state ?? 0,
        rssi: dev.rssi ?? 0,
        battery_mv: dev.battery_mv ?? 0,
      })).filter(r => r.tag_mac);

      return { user_id: GATEWAY_USER_ID, readings };
    }

    // Fallback: try to use the data as-is
    console.log('[Bridge] Unknown payload format:', JSON.stringify(data).slice(0, 200));
    return null;
  } catch (err) {
    console.error('[Bridge] Parse error:', err.message);
    return null;
  }
}

// ─── Forward to Supabase edge function ───
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

// ─── MQTT client ───
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
  console.log(`[Bridge] MQTT message on ${topic}: ${raw.slice(0, 300)}`);

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

// ─── Send heartbeat to gateway (keeps connection alive) ───
setInterval(() => {
  if (mqttConnected) {
    const heartbeat = JSON.stringify({ type: 'heartbeat', ts: Date.now() });
    client.publish(MQTT_TOPIC_PUB, heartbeat, { qos: 0 });
    console.log(`[Bridge] Heartbeat sent on ${MQTT_TOPIC_PUB}`);
  }
}, 60000); // every 60s

// Start self-ping
startSelfPing();

console.log('[Bridge] MQTT-to-HTTP bridge started.');
