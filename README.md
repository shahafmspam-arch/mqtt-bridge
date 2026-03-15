# MQTT-to-HTTP Bridge for Calf Monitoring

Bridges BLE gateway MQTT messages to the Supabase edge function.

## Deploy to Render

1. Push this `mqtt-bridge/` folder to a separate GitHub repo
2. Go to https://dashboard.render.com → New → Web Service
3. Connect the repo, set:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
4. Add these **Environment Variables**:

| Variable | Value |
|---|---|
| `MQTT_BROKER_URL` | `mqtt://120.77.232.76:1883` |
| `MQTT_USERNAME` | `Shahaf` |
| `MQTT_PASSWORD` | *(your MQTT password)* |
| `MQTT_CLIENT_ID` | `render-bridge-001` |
| `MQTT_TOPIC_SUB` | `GwData` |
| `MQTT_TOPIC_PUB` | `SrvData` |
| `SUPABASE_FUNCTION_URL` | `https://yesuqnvmnuqawwhxmwfk.supabase.co/functions/v1/gateway-ingest` |
| `SUPABASE_ANON_KEY` | *(your Supabase anon key)* |
| `GATEWAY_USER_ID` | *(your user UUID from the app)* |

5. After deploy, copy the Render URL and add:
   - `SELF_URL` = `https://your-service.onrender.com`

## Architecture

```
BLE Tags → HCBG01 Gateway → MQTT Broker → [This Bridge on Render] → Supabase Edge Function → Database → Lovable App (Vercel)
```
