import { readFileSync } from "node:fs";
import WebSocket from "ws";

function loadDotEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1].trim()] = value;
  }
  return env;
}

async function readResponse(response) {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function summarizeVoice(voice) {
  return {
    name: voice.name,
    voice_id: voice.voice_id,
    category: voice.category,
    labels: voice.labels,
    sharing: voice.sharing
      ? {
          status: voice.sharing.status,
          enabled_in_library: voice.sharing.enabled_in_library,
          original_voice_id: voice.sharing.original_voice_id
        }
      : undefined
  };
}

async function main() {
  const env = loadDotEnv(".env");
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is empty.");

  const headers = { "xi-api-key": apiKey };
  const subscriptionResponse = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers });
  const subscriptionPayload = await readResponse(subscriptionResponse);
  const subscription = subscriptionPayload.json || {};

  console.log(JSON.stringify({
    subscription: {
      httpStatus: subscriptionResponse.status,
      tier: subscription.tier,
      status: subscription.status,
      character_count: subscription.character_count,
      character_limit: subscription.character_limit,
      remaining: Number.isFinite(Number(subscription.character_limit)) && Number.isFinite(Number(subscription.character_count))
        ? Number(subscription.character_limit) - Number(subscription.character_count)
        : null,
      has_open_invoices: subscription.has_open_invoices,
      currency: subscription.currency
    }
  }, null, 2));

  const voiceQuery = env.ELEVENLABS_VOICE_NAME || "Mark - Casual, Relaxed and Light";
  const voiceUrl = new URL("https://api.elevenlabs.io/v2/voices");
  voiceUrl.searchParams.set("search", voiceQuery);
  voiceUrl.searchParams.set("page_size", "10");
  voiceUrl.searchParams.set("include_total_count", "false");
  const voiceResponse = await fetch(voiceUrl, { headers });
  const voicePayload = await readResponse(voiceResponse);
  const voices = Array.isArray(voicePayload.json?.voices) ? voicePayload.json.voices : [];

  console.log(JSON.stringify({
    voiceSearch: {
      httpStatus: voiceResponse.status,
      query: voiceQuery,
      count: voices.length,
      configuredVoiceId: env.ELEVENLABS_VOICE_ID || "",
      results: voices.slice(0, 5).map(summarizeVoice)
    }
  }, null, 2));

  const voiceId = env.ELEVENLABS_VOICE_ID || voices[0]?.voice_id;
  if (!voiceId) throw new Error("No voice id found for configured voice.");

  async function testTts(outputFormat) {
    const ttsUrl = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`);
    ttsUrl.searchParams.set("output_format", outputFormat);
    const response = await fetch(ttsUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Test.",
        model_id: env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5"
      })
    });
    const contentType = response.headers.get("content-type") || "";
    const responseText = contentType.includes("application/json") || !response.ok
      ? await response.text()
      : "<audio bytes>";
    let body = responseText;
    try {
      body = JSON.parse(responseText);
    } catch {
      body = responseText.slice(0, 500);
    }
    return {
      outputFormat,
      httpStatus: response.status,
      ok: response.ok,
      body
    };
  }

  console.log(JSON.stringify({
    ttsConfiguredFormat: await testTts(env.ELEVENLABS_OUTPUT_FORMAT || "ulaw_8000")
  }, null, 2));

  console.log(JSON.stringify({
    ttsDefaultMp3: await testTts("mp3_44100_128")
  }, null, 2));

  async function testRealtimeWebSocket({ label, initPayload }) {
    const wsUrl = new URL(`wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input`);
    wsUrl.searchParams.set("model_id", env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5");
    wsUrl.searchParams.set("output_format", env.ELEVENLABS_OUTPUT_FORMAT || "ulaw_8000");
    wsUrl.searchParams.set("inactivity_timeout", "60");

    return await new Promise((resolve) => {
      const messages = [];
      const socket = new WebSocket(wsUrl.toString(), {
        headers
      });
      const timeout = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // Ignore cleanup failures.
        }
        resolve({ label, ok: false, reason: "timeout", messages });
      }, 12000);

      socket.on("open", () => {
        socket.send(JSON.stringify(initPayload));
        socket.send(JSON.stringify({ text: "Test.", flush: true }));
      });

      socket.on("message", (raw) => {
        let message = raw.toString();
        try {
          const parsed = JSON.parse(message);
          message = {
            ...parsed,
            audio: parsed.audio ? `<audio ${parsed.audio.length} chars>` : parsed.audio
          };
        } catch {
          message = message.slice(0, 500);
        }
        messages.push(message);
        if (message.audio || message.error) {
          clearTimeout(timeout);
          try {
            socket.close();
          } catch {
            // Ignore cleanup failures.
          }
          resolve({ label, ok: Boolean(message.audio), messages });
        }
      });

      socket.on("error", (error) => {
        clearTimeout(timeout);
        resolve({ label, ok: false, reason: error.message, messages });
      });
    });
  }

  const baseVoiceSettings = {
    stability: 0.5,
    similarity_boost: 0.8
  };

  console.log(JSON.stringify({
    realtimeWebSocketSimple: await testRealtimeWebSocket({
      label: "simple",
      initPayload: {
        text: " ",
        voice_settings: baseVoiceSettings,
        generation_config: {
          chunk_length_schedule: [80, 120, 180, 240]
        }
      }
    })
  }, null, 2));

  console.log(JSON.stringify({
    realtimeWebSocketWithApiKeyInMessage: await testRealtimeWebSocket({
      label: "with xi_api_key in message",
      initPayload: {
        text: " ",
        xi_api_key: apiKey,
        voice_settings: {
          ...baseVoiceSettings,
          use_speaker_boost: true,
          speed: 1
        },
        generation_config: {
          chunk_length_schedule: [80, 120, 180, 240]
        }
      }
    })
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
