import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(appRoot, "public");
const dataDir = path.join(appRoot, "data");
const dataFile = path.join(dataDir, "campaign.json");
const testCsvFile = path.join(dataDir, "test-call-contact.csv");

loadDotEnv(path.join(appRoot, ".env"));

const port = Number(process.env.PORT || 8787);
const state = await loadState();
const sseClients = new Set();

const server = createServer(async (req, res) => {
  try {
    await routeHttp(req, res);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message || "Unexpected server error" });
  }
});

const mediaServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (reqUrl.pathname !== "/media") {
    socket.destroy();
    return;
  }

  mediaServer.handleUpgrade(req, socket, head, (twilioSocket) => {
    mediaServer.emit("connection", twilioSocket, req);
  });
});

mediaServer.on("connection", (twilioSocket, req) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const fallbackContactId = reqUrl.searchParams.get("contactId");

  void bridgeTwilioToOpenAI(twilioSocket, fallbackContactId).catch((error) => {
    console.error(error);
    try {
      twilioSocket.close();
    } catch {
      // Ignore close failures.
    }
  });
});

server.listen(port, () => {
  console.log(`Tailor Call Agent running at http://127.0.0.1:${port}`);
});

async function routeHttp(req, res) {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && reqUrl.pathname === "/api/state") {
    json(res, 200, snapshot());
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      port,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
      audioProvider: audioOutputProvider(),
      voice: activeVoiceLabel(),
      issues: configIssues()
    });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/events") {
    openEventStream(req, res);
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/contacts/import") {
    const body = await readJson(req);
    const imported = importContacts(body);
    await saveAndBroadcast();
    json(res, 200, { imported });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/contacts/import-test-csv") {
    const csv = await readFile(testCsvFile, "utf8");
    const imported = importContacts({
      csv,
      approved: true,
      resetExisting: true
    });
    await saveAndBroadcast();
    json(res, 200, { imported, source: "data/test-call-contact.csv" });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/contacts\/[^/]+\/update$/)) {
    const contact = requireContact(reqUrl.pathname.split("/")[3]);
    const body = await readJson(req);
    updateContact(contact, body);
    await saveAndBroadcast();
    json(res, 200, { contact });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/contacts\/[^/]+\/delete$/)) {
    const contactId = reqUrl.pathname.split("/")[3];
    const index = state.contacts.findIndex((contact) => contact.id === contactId);
    if (index === -1) {
      json(res, 404, { error: "Contact not found" });
      return;
    }
    state.contacts.splice(index, 1);
    await saveAndBroadcast();
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/contacts\/[^/]+\/reset$/)) {
    const contact = requireContact(reqUrl.pathname.split("/")[3]);
    Object.assign(contact, {
      status: "ready",
      attempts: 0,
      error: null,
      callSid: null,
      twilioStatus: null,
      streamSid: null,
      streamStatus: null,
      callStartedAt: null,
      callCompletedAt: null,
      durationSeconds: null,
      summary: "",
      updatedAt: nowIso()
    });
    await saveAndBroadcast();
    json(res, 200, { contact });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname.match(/^\/api\/contacts\/[^/]+\/call$/)) {
    const contact = requireContact(reqUrl.pathname.split("/")[3]);
    const body = await readJson(req);
    requireCallAcknowledgement(body);
    const result = await startCall(contact);
    await saveAndBroadcast();
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/batch/start") {
    const body = await readJson(req);
    requireCallAcknowledgement(body);
    const limit = clamp(Number(body.limit || 10), 1, 100);
    state.batch = {
      running: true,
      remaining: limit,
      startedAt: nowIso()
    };
    await saveAndBroadcast();
    void maybeStartNextBatchCall();
    json(res, 200, { batch: state.batch });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/batch/stop") {
    state.batch = { running: false, remaining: 0, startedAt: null };
    await saveAndBroadcast();
    json(res, 200, { batch: state.batch });
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && reqUrl.pathname === "/twiml/answer") {
    serveTwiml(reqUrl, res);
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/calls/status") {
    const form = await readForm(req);
    await handleTwilioStatus(reqUrl, form);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/streams/status") {
    const form = await readForm(req);
    await handleTwilioStreamStatus(reqUrl, form);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET") {
    await serveStatic(reqUrl.pathname, res);
    return;
  }

  json(res, 404, { error: "Not found" });
}

async function bridgeTwilioToOpenAI(twilioSocket, fallbackContactId) {
  let contact = null;
  let openaiSocket = null;
  let elevenLabsTts = null;
  let streamSid = null;
  let openaiReady = false;
  let pendingAudio = [];
  let assistantBuffer = "";
  let callerBuffer = "";
  let functionCall = null;
  let suppressAssistantSpeech = false;
  let ttsErrorHandled = false;
  const startedAt = Date.now();
  const maxCallMs = clamp(Number(process.env.MAX_CALL_SECONDS || 360), 60, 900) * 1000;
  let maxTimer = null;

  function sendTwilioMedia(payload) {
    if (!streamSid || twilioSocket.readyState !== WebSocket.OPEN) return;
    twilioSocket.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload }
    }));
  }

  function clearTwilioMedia() {
    if (!streamSid || twilioSocket.readyState !== WebSocket.OPEN) return;
    twilioSocket.send(JSON.stringify({
      event: "clear",
      streamSid
    }));
  }

  function handleTtsError(error) {
    console.error("ElevenLabs TTS error", error);
    if (!contact) return;
    if (ttsErrorHandled) return;
    ttsErrorHandled = true;
    contact.status = "failed";
    contact.error = normalizeElevenLabsError(error);
    contact.callCompletedAt = nowIso();
    contact.updatedAt = nowIso();
    try {
      if (elevenLabsTts) elevenLabsTts.close();
      if (openaiSocket) openaiSocket.close();
    } catch {
      // Ignore cleanup failures after the provider has already failed.
    }
    void finishCall(contact, `ElevenLabs TTS failed: ${contact.error}`);
  }

  async function startOpenAIForContact(startMessage) {
    const contactId = startMessage.start?.customParameters?.contactId || fallbackContactId;
    contact = state.contacts.find((item) => item.id === contactId);

    if (!contact) {
      twilioSocket.close(1008, "Unknown contact");
      return;
    }

    const apiKey = requiredEnv("OPENAI_API_KEY");
    const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
    const realtimeUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

    contact.status = "in_progress";
    contact.error = null;
    contact.callSid = startMessage.start?.callSid || contact.callSid;
    contact.callStartedAt = contact.callStartedAt || nowIso();
    contact.transcript ||= [];
    contact.events ||= [];
    contact.updatedAt = nowIso();
    await saveAndBroadcast();

    if (isElevenLabsOutput()) {
      const voiceId = await resolveElevenLabsVoiceId();
      elevenLabsTts = createElevenLabsTtsStream({
        voiceId,
        onAudio: sendTwilioMedia,
        onError: handleTtsError
      });
      await elevenLabsTts.open();
    }

    maxTimer = setTimeout(() => {
      if (!contact) return;
      addTranscript(contact, "system", "Maximum call duration reached; ending call.");
      void finishCall(contact, "Max call duration reached.");
    }, maxCallMs);

    openaiSocket = new WebSocket(realtimeUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Safety-Identifier": safetyIdentifier(contact)
      }
    });

    openaiSocket.on("open", () => {
      openaiReady = true;
      sendOpenAI(openaiSocket, {
        type: "session.update",
        session: buildRealtimeSession(contact)
      });
      for (const payload of pendingAudio) {
        sendOpenAI(openaiSocket, {
          type: "input_audio_buffer.append",
          audio: payload
        });
      }
      pendingAudio = [];
      sendOpenAI(openaiSocket, {
        type: "response.create",
        response: {
          instructions: "Hi how is it going?"
        }
      });
    });

    openaiSocket.on("message", (raw) => {
      const message = parseJson(raw.toString());
      if (!message || !contact) return;

      if (message.type === "response.created") {
        suppressAssistantSpeech = false;
        return;
      }

      if (message.type === "input_audio_buffer.speech_started") {
        suppressAssistantSpeech = true;
        assistantBuffer = "";
        if (elevenLabsTts) elevenLabsTts.interrupt();
        clearTwilioMedia();
        return;
      }

      if (message.type === "error") {
        console.error("OpenAI realtime error", message.error || message);
        contact.error = message.error?.message || "OpenAI realtime error";
        addTranscript(contact, "system", `OpenAI realtime error: ${contact.error}`);
        contact.updatedAt = nowIso();
        void saveAndBroadcast();
        return;
      }

      if ((message.type === "response.output_audio.delta" || message.type === "response.audio.delta") && message.delta) {
        sendTwilioMedia(message.delta);
        return;
      }

      if (message.type === "response.output_text.delta" && message.delta) {
        assistantBuffer += message.delta;
        if (elevenLabsTts && !suppressAssistantSpeech) {
          elevenLabsTts.pushText(message.delta);
        }
        return;
      }

      if (message.type === "response.output_text.done") {
        flushTranscript(contact, "assistant", message.text || assistantBuffer);
        assistantBuffer = "";
        if (elevenLabsTts && !suppressAssistantSpeech) {
          elevenLabsTts.flush();
        }
        void saveAndBroadcast();
        return;
      }

      if (message.type === "response.done" && isElevenLabsOutput() && assistantBuffer) {
        flushTranscript(contact, "assistant", assistantBuffer);
        assistantBuffer = "";
        if (elevenLabsTts && !suppressAssistantSpeech) {
          elevenLabsTts.flush();
        }
        void saveAndBroadcast();
        return;
      }

      if (message.type === "response.output_audio_transcript.delta" && message.delta) {
        assistantBuffer += message.delta;
        return;
      }

      if (message.type === "response.output_audio_transcript.done") {
        flushTranscript(contact, "assistant", assistantBuffer);
        assistantBuffer = "";
        void saveAndBroadcast();
        return;
      }

      if ((message.type === "conversation.item.input_audio_transcription.delta" || message.type === "conversation.item.audio_transcription.delta") && message.delta) {
        callerBuffer += message.delta;
        return;
      }

      if (
        message.type === "conversation.item.input_audio_transcription.completed" ||
        message.type === "conversation.item.input_audio_transcription.done" ||
        message.type === "conversation.item.audio_transcription.completed"
      ) {
        flushTranscript(contact, "tailor", message.transcript || callerBuffer);
        callerBuffer = "";
        void saveAndBroadcast();
        return;
      }

      if (message.type === "response.function_call_arguments.delta") {
        if (!functionCall || functionCall.callId !== message.call_id) {
          functionCall = {
            callId: message.call_id,
            name: message.name,
            argumentsText: ""
          };
        }
        functionCall.argumentsText += message.delta || "";
        return;
      }

      if (message.type === "response.function_call_arguments.done") {
        const name = message.name || functionCall?.name;
        const argsText = message.arguments || functionCall?.argumentsText || "{}";
        const args = parseJson(argsText) || {};
        void handleRealtimeTool(openaiSocket, contact, message.call_id || functionCall?.callId, name, args);
        functionCall = null;
      }
    });

    openaiSocket.on("close", () => {
      if (maxTimer) clearTimeout(maxTimer);
      if (elevenLabsTts) elevenLabsTts.close();
    });

    openaiSocket.on("error", (error) => {
      console.error("OpenAI WebSocket error", error);
      if (!contact) return;
      contact.error = error.message;
      addTranscript(contact, "system", `OpenAI WebSocket error: ${contact.error}`);
      contact.updatedAt = nowIso();
      void saveAndBroadcast();
    });
  }

  twilioSocket.on("message", (raw) => {
    const message = parseJson(raw.toString());
    if (!message) return;

    if (message.event === "start") {
      streamSid = message.start?.streamSid;
      void startOpenAIForContact(message).catch((error) => {
        console.error("Failed to start OpenAI bridge", error);
        if (contact) {
          contact.status = "failed";
          contact.error = error.message;
          contact.updatedAt = nowIso();
          void saveAndBroadcast();
        }
        twilioSocket.close(1011, "Failed to start OpenAI bridge");
      });
      return;
    }

    if (message.event === "media") {
      const payload = message.media?.payload;
      if (!payload) return;
      if (openaiReady && openaiSocket?.readyState === WebSocket.OPEN) {
        sendOpenAI(openaiSocket, {
          type: "input_audio_buffer.append",
          audio: payload
        });
      } else {
        pendingAudio.push(payload);
      }
      return;
    }

    if (message.event === "stop") {
      if (maxTimer) clearTimeout(maxTimer);
      if (contact) {
        contact.durationSeconds = Math.round((Date.now() - startedAt) / 1000);
        contact.updatedAt = nowIso();
        void saveAndBroadcast();
      }
      if (openaiSocket) openaiSocket.close();
      if (elevenLabsTts) elevenLabsTts.close();
    }
  });

  twilioSocket.on("close", () => {
    if (maxTimer) clearTimeout(maxTimer);
    try {
      if (openaiSocket) openaiSocket.close();
      if (elevenLabsTts) elevenLabsTts.close();
    } catch {
      // Ignore close failures.
    }
  });

  twilioSocket.on("error", (error) => {
    console.error("Twilio WebSocket error", error);
    if (!contact) return;
    contact.error = error.message;
    contact.updatedAt = nowIso();
    void saveAndBroadcast();
  });
}

function buildRealtimeSession(contact) {
  const session = {
    type: "realtime",
    instructions: buildAgentInstructions(contact),
    output_modalities: isElevenLabsOutput() ? ["text"] : ["audio"],
    audio: {
      input: {
        format: {
          type: "audio/pcmu"
        },
        transcription: {
          model: process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe"
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.45,
          prefix_padding_ms: 300,
          silence_duration_ms: 650,
          create_response: true,
          interrupt_response: true
        }
      }
    },
    tools: [
      {
        type: "function",
        name: "record_tailor_quote",
        description: "Record a concrete tailoring price, turnaround time, rush availability, or related operational fact learned from the business.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            service: {
              type: "string",
              description: "Suit alteration service, such as jacket shoulder adjustment, chest taken in, waist taken in, pants tapering, pants waist/seat taken in, or rush order."
            },
            price_text: {
              type: "string",
              description: "Verbatim or normalized price information."
            },
            price_min: {
              type: "number",
              description: "Lowest quoted price in USD when available."
            },
            price_max: {
              type: "number",
              description: "Highest quoted price in USD when available."
            },
            turnaround_text: {
              type: "string",
              description: "Verbatim or normalized turnaround information."
            },
            turnaround_days_min: {
              type: "number",
              description: "Minimum turnaround in days when available."
            },
            turnaround_days_max: {
              type: "number",
              description: "Maximum turnaround in days when available."
            },
            rush_available: {
              type: "boolean"
            },
            notes: {
              type: "string"
            },
            confidence: {
              type: "string",
              enum: ["low", "medium", "high"]
            }
          },
          required: ["service", "notes", "confidence"]
        }
      },
      {
        type: "function",
        name: "finish_call",
        description: "Use when the conversation is complete, the business declines to talk, or the business asks not to be contacted again.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            outcome: {
              type: "string",
              enum: ["completed", "declined", "no_pricing", "do_not_call", "needs_human_follow_up"]
            },
            summary: {
              type: "string"
            },
            do_not_call: {
              type: "boolean"
            }
          },
          required: ["outcome", "summary", "do_not_call"]
        }
      }
    ],
    tool_choice: "auto",
    tracing: "auto"
  };

  if (!isElevenLabsOutput()) {
    session.audio.output = {
      format: {
        type: "audio/pcmu"
      },
      voice: process.env.OPENAI_REALTIME_VOICE || "alloy",
      speed: 1.02
    };
  }

  return session;
}

function buildAgentInstructions(contact) {
  const callerName = process.env.CALLER_NAME || "Benny";
  const purpose = process.env.CALL_PURPOSE || "checking suit alteration price and turnaround time";
  const businessName = contact.name || "this tailor shop";
  const notes = contact.notes ? `\nContact notes: ${contact.notes}` : "";

  return [
    `You are ${callerName}, calling ${businessName}.`,
    `Purpose: ${purpose}.`,
    "This is a short call to understand public prices and turnaround times for a suit alteration Benny is evaluating.",
    "Required opening: Say you are Benny, say the purpose, and say you want to alterate a suit",
    "If the person says no, is busy, asks not to be called, sounds upset, or asks to stop, apologize once, say you will not take more time, call finish_call with the right outcome, and end politely.",
    "Do not imply the suit is already at the shop or that an appointment is being booked. You are only asking for typical pricing and timing.",
    "Keep the call under three minutes. Ask concise questions and avoid repeating yourself.",
    "Ask for typical price ranges and normal turnaround for shrinking/altering a suit jacket at the shoulders, chest, and waist, plus shrinking the pants down through waist/seat adjustment and tapering. Ask whether they price those separately or as a package.",
    "Ask whether shoulder alterations are possible at their shop, since some tailors avoid shoulder work. If shoulder work is not possible, still capture prices and timing for chest, waist, and pants adjustments.",
    "Ask if rush turnaround is available and what it costs, but do not push too hard if they only answer some questions.",
    "Speak in English unless the person clearly asks to continue in another language.",
    "Whenever a concrete price or turnaround is learned, call record_tailor_quote silently with the extracted fact.",
    "Before ending, briefly confirm the key prices and turnaround you heard. Then thank them and finish the call.",
    "Never ask for personal data, payment info, private customer details, or anything unrelated to tailoring services.",
    notes
  ].join("\n");
}

async function handleRealtimeTool(openaiSocket, contact, callId, name, args) {
  if (name === "record_tailor_quote") {
    contact.quotes ||= [];
    contact.quotes.push({
      id: randomUUID(),
      ...sanitizeQuote(args),
      capturedAt: nowIso()
    });
    contact.updatedAt = nowIso();
    await saveAndBroadcast();
    sendToolOutput(openaiSocket, callId, { ok: true });
    sendOpenAI(openaiSocket, {
      type: "response.create",
      response: {
        instructions: "Continue naturally. Do not mention that you recorded anything."
      }
    });
    return;
  }

  if (name === "finish_call") {
    contact.status = args.outcome === "completed" ? "completed" : args.outcome || "needs_review";
    contact.summary = String(args.summary || "").slice(0, 1500);
    contact.doNotCall = Boolean(args.do_not_call);
    contact.callCompletedAt = nowIso();
    contact.updatedAt = nowIso();
    await saveAndBroadcast();
    sendToolOutput(openaiSocket, callId, { ok: true });

    setTimeout(() => {
      void finishCall(contact, contact.summary || "Call finished.");
    }, 8000);
    return;
  }

  sendToolOutput(openaiSocket, callId, { ok: false, error: `Unknown tool: ${name}` });
}

function sendToolOutput(openaiSocket, callId, output) {
  if (!callId) return;
  sendOpenAI(openaiSocket, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output)
    }
  });
}

function sendOpenAI(openaiSocket, payload) {
  if (openaiSocket.readyState !== WebSocket.OPEN) return;
  openaiSocket.send(JSON.stringify(payload));
}

let cachedElevenLabsVoice = null;
let cachedElevenLabsReadiness = null;

async function resolveElevenLabsVoiceId() {
  const configuredVoiceId = clean(process.env.ELEVENLABS_VOICE_ID || "");
  if (configuredVoiceId) return configuredVoiceId;

  const voiceName = clean(process.env.ELEVENLABS_VOICE_NAME || "");
  if (!voiceName) {
    throw new Error("Set ELEVENLABS_VOICE_ID or ELEVENLABS_VOICE_NAME when AUDIO_OUTPUT_PROVIDER=elevenlabs.");
  }

  if (cachedElevenLabsVoice?.query === voiceName && cachedElevenLabsVoice?.voiceId) {
    return cachedElevenLabsVoice.voiceId;
  }

  const reqUrl = new URL("https://api.elevenlabs.io/v2/voices");
  reqUrl.searchParams.set("search", voiceName);
  reqUrl.searchParams.set("page_size", "20");
  reqUrl.searchParams.set("include_total_count", "false");

  const response = await fetch(reqUrl, {
    headers: {
      "xi-api-key": requiredEnv("ELEVENLABS_API_KEY")
    }
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`ElevenLabs voice lookup failed ${response.status}: ${responseText.slice(0, 500)}`);
  }

  const payload = parseJson(responseText) || {};
  const voices = Array.isArray(payload.voices) ? payload.voices : [];
  const selected = selectElevenLabsVoice(voices, voiceName);
  if (!selected?.voice_id) {
    const options = voices.slice(0, 5).map((voice) => `${voice.name || "Unnamed"} (${voice.voice_id || "no id"})`).join(", ");
    throw new Error(`Could not find ElevenLabs voice "${voiceName}". Set ELEVENLABS_VOICE_ID directly.${options ? ` Nearby results: ${options}` : ""}`);
  }

  cachedElevenLabsVoice = {
    query: voiceName,
    voiceId: selected.voice_id,
    name: selected.name || voiceName
  };
  return selected.voice_id;
}

function selectElevenLabsVoice(voices, query) {
  if (!voices.length) return null;
  const normalizedQuery = normalizeSearchText(query);
  const exact = voices.find((voice) => normalizeSearchText(voice.name) === normalizedQuery);
  if (exact) return exact;

  const queryTokens = normalizeSearchText(query).split(" ").filter((token) => token.length > 2);
  const scored = voices
    .map((voice) => {
      const searchable = normalizeSearchText([
        voice.name,
        voice.description,
        ...Object.values(voice.labels || {}),
        voice.sharing?.name,
        voice.sharing?.description,
        ...Object.values(voice.sharing?.labels || {})
      ].filter(Boolean).join(" "));
      const matches = queryTokens.filter((token) => searchable.includes(token)).length;
      return { voice, matches };
    })
    .sort((left, right) => right.matches - left.matches);

  return scored[0]?.matches ? scored[0].voice : voices[0];
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function createElevenLabsTtsStream({ voiceId, onAudio, onError }) {
  let socket = null;
  let connectPromise = null;
  let keepAliveTimer = null;
  let pendingText = "";
  let hasUnflushedText = false;
  let generation = 0;

  function buildUrl() {
    const reqUrl = new URL(`wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input`);
    reqUrl.searchParams.set("model_id", process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5");
    reqUrl.searchParams.set("output_format", process.env.ELEVENLABS_OUTPUT_FORMAT || "ulaw_8000");
    reqUrl.searchParams.set("inactivity_timeout", String(clamp(Number(process.env.ELEVENLABS_INACTIVITY_TIMEOUT || 180), 20, 180)));
    if (process.env.ELEVENLABS_AUTO_MODE === "true") reqUrl.searchParams.set("auto_mode", "true");
    return reqUrl.toString();
  }

  function open() {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (connectPromise) return connectPromise;

    const socketGeneration = generation;
    socket = new WebSocket(buildUrl(), {
      headers: {
        "xi-api-key": requiredEnv("ELEVENLABS_API_KEY")
      }
    });

    connectPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out connecting to ElevenLabs TTS."));
      }, 10000);

      socket.once("open", () => {
        clearTimeout(timeout);
        connectPromise = null;
        sendElevenLabsJson({
          text: " ",
          xi_api_key: requiredEnv("ELEVENLABS_API_KEY"),
          voice_settings: {
            stability: clamp(Number(process.env.ELEVENLABS_STABILITY || 0.5), 0, 1),
            similarity_boost: clamp(Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.8), 0, 1),
            use_speaker_boost: process.env.ELEVENLABS_USE_SPEAKER_BOOST !== "false",
            speed: clamp(Number(process.env.ELEVENLABS_SPEED || 1), 0.7, 1.2)
          },
          generation_config: {
            chunk_length_schedule: parseIntegerList(process.env.ELEVENLABS_CHUNK_LENGTH_SCHEDULE || "80,120,180,240")
          }
        });
        keepAliveTimer = setInterval(() => {
          sendElevenLabsJson({ text: " " });
        }, 15000);
        resolve();
      });

      socket.once("error", (error) => {
        clearTimeout(timeout);
        connectPromise = null;
        reject(error);
      });
    });

    socket.on("message", (raw) => {
      if (socketGeneration !== generation) return;
      const message = parseJson(raw.toString());
      if (!message) return;
      if (message.audio) onAudio(message.audio);
      if (message.error) onError(new Error(String(message.error)));
    });

    socket.on("close", () => {
      if (socketGeneration !== generation) return;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      socket = null;
      connectPromise = null;
    });

    socket.on("error", (error) => {
      if (socketGeneration !== generation) return;
      onError(error);
    });

    return connectPromise;
  }

  function sendElevenLabsJson(payload) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  function queuePayload(payload) {
    void open()
      .then(() => sendElevenLabsJson(payload))
      .catch(onError);
  }

  function pushText(delta) {
    pendingText += String(delta || "");
    if (!shouldSendElevenLabsText(pendingText)) return;
    const text = pendingText;
    pendingText = "";
    hasUnflushedText = true;
    queuePayload({ text });
  }

  function flush() {
    if (!pendingText && !hasUnflushedText) return;
    const text = pendingText || " ";
    pendingText = "";
    hasUnflushedText = false;
    queuePayload({ text, flush: true });
  }

  function close() {
    pendingText = "";
    hasUnflushedText = false;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    if (socket?.readyState === WebSocket.OPEN) {
      sendElevenLabsJson({ text: "" });
      socket.close();
    }
    socket = null;
    connectPromise = null;
  }

  function interrupt() {
    generation += 1;
    pendingText = "";
    hasUnflushedText = false;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    try {
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    } catch {
      // Ignore interruption close failures.
    }
    socket = null;
    connectPromise = null;
  }

  return { open, pushText, flush, close, interrupt };
}

function shouldSendElevenLabsText(text) {
  if (text.length >= 90) return true;
  if (text.length >= 35 && /[.!?]\s$/.test(text)) return true;
  if (text.length >= 55 && /[,;:]\s$/.test(text)) return true;
  return false;
}

function parseIntegerList(value) {
  const parsed = String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  return parsed.length ? parsed : [80, 120, 180, 240];
}

async function assertAudioProviderReady() {
  if (!isElevenLabsOutput()) return;
  if (cachedElevenLabsReadiness?.ok) return;
  if (cachedElevenLabsReadiness?.error) {
    throw new Error(cachedElevenLabsReadiness.error);
  }

  const voiceId = await resolveElevenLabsVoiceId();
  let tts = null;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settle(new Error("Timed out while checking ElevenLabs speech generation."));
      }, 12000);

      function settle(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          if (tts) tts.close();
        } catch {
          // Ignore preflight cleanup failures.
        }
        if (error) reject(error);
        else resolve();
      }

      tts = createElevenLabsTtsStream({
        voiceId,
        onAudio: () => settle(null),
        onError: (error) => settle(error)
      });

      tts.open()
        .then(() => {
          tts.pushText(process.env.ELEVENLABS_PREFLIGHT_TEXT || "Testing voice.");
          tts.flush();
        })
        .catch((error) => settle(error));
    });

    cachedElevenLabsReadiness = { ok: true, checkedAt: nowIso() };
  } catch (error) {
    const message = normalizeElevenLabsError(error);
    cachedElevenLabsReadiness = { ok: false, error: message, checkedAt: nowIso() };
    throw new Error(message);
  }
}

function normalizeElevenLabsError(error) {
  const message = error?.message || String(error || "ElevenLabs TTS error");
  if (message === "payment_required" || message.includes("payment_required")) {
    return "ElevenLabs cannot synthesize speech: payment_required. Check ElevenLabs billing, credits, plan access, and whether this voice/output format is available on your account.";
  }
  return message;
}

async function finishCall(contact, reason) {
  addTranscript(contact, "system", reason);
  contact.callCompletedAt ||= nowIso();
  contact.updatedAt = nowIso();
  await saveAndBroadcast();

  if (contact.callSid && hasTwilioConfig()) {
    const auth = Buffer.from(`${requiredEnv("TWILIO_ACCOUNT_SID")}:${requiredEnv("TWILIO_AUTH_TOKEN")}`).toString("base64");
    const body = new URLSearchParams({ Status: "completed" });
    try {
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(requiredEnv("TWILIO_ACCOUNT_SID"))}/Calls/${encodeURIComponent(contact.callSid)}.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body
      });
    } catch (error) {
      console.error("Failed to end Twilio call", error);
    }
  }
}

async function startCall(contact) {
  assertCallable(contact);

  try {
    await assertAudioProviderReady();
  } catch (error) {
    contact.status = "failed";
    contact.error = error.message;
    contact.updatedAt = nowIso();
    await saveAndBroadcast();
    throw error;
  }

  const callUrl = `${publicBaseUrl()}/twiml/answer?contactId=${encodeURIComponent(contact.id)}`;
  const statusUrl = `${publicBaseUrl()}/api/calls/status?contactId=${encodeURIComponent(contact.id)}`;
  const params = new URLSearchParams({
    To: contact.phone,
    From: requiredEnv("TWILIO_FROM_NUMBER"),
    Url: callUrl,
    Method: "POST",
    StatusCallback: statusUrl,
    StatusCallbackMethod: "POST"
  });
  for (const event of ["initiated", "ringing", "answered", "completed"]) {
    params.append("StatusCallbackEvent", event);
  }

  const accountSid = requiredEnv("TWILIO_ACCOUNT_SID");
  const auth = Buffer.from(`${accountSid}:${requiredEnv("TWILIO_AUTH_TOKEN")}`).toString("base64");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  const responseText = await response.text();
  if (!response.ok) {
    contact.status = "failed";
    contact.error = `Twilio error ${response.status}: ${responseText.slice(0, 500)}`;
    contact.updatedAt = nowIso();
    throw new Error(contact.error);
  }

  const twilioResult = parseJson(responseText) || {};
  contact.status = "calling";
  contact.callSid = twilioResult.sid || contact.callSid;
  contact.callStartedAt = nowIso();
  contact.callCompletedAt = null;
  contact.durationSeconds = null;
  contact.error = null;
  contact.attempts = Number(contact.attempts || 0) + 1;
  contact.updatedAt = nowIso();

  state.calls.push({
    id: randomUUID(),
    contactId: contact.id,
    callSid: contact.callSid,
    startedAt: contact.callStartedAt
  });

  return { contact, twilio: twilioResult };
}

function assertCallable(contact) {
  const issues = configIssues();
  if (issues.length) {
    throw new Error(`Calling is not ready: ${issues.join(", ")}`);
  }
  if (process.env.ALLOW_OUTBOUND_CALLS !== "true") {
    throw new Error("Outbound calls are disabled. Set ALLOW_OUTBOUND_CALLS=true in .env when you are ready.");
  }
  if (!contact.approved) {
    throw new Error("Contact is not approved for calling.");
  }
  if (contact.doNotCall) {
    throw new Error("Contact is marked do-not-call.");
  }
  if (!normalizePhone(contact.phone)) {
    throw new Error("Contact phone number is invalid.");
  }
  const attempts = Number(contact.attempts || 0);
  const maxAttempts = clamp(Number(process.env.MAX_ATTEMPTS_PER_CONTACT || 2), 1, 10);
  if (attempts >= maxAttempts) {
    throw new Error(`Contact has reached the max attempt limit (${maxAttempts}).`);
  }
}

async function maybeStartNextBatchCall() {
  if (!state.batch?.running || state.batch.remaining <= 0) return;
  if (state.contacts.some((contact) => ["calling", "ringing", "answered", "in_progress"].includes(contact.status))) return;

  const next = state.contacts.find((contact) => {
    if (!contact.approved || contact.doNotCall) return false;
    if (["completed", "declined", "do_not_call"].includes(contact.status)) return false;
    const maxAttempts = clamp(Number(process.env.MAX_ATTEMPTS_PER_CONTACT || 2), 1, 10);
    return Number(contact.attempts || 0) < maxAttempts;
  });

  if (!next) {
    state.batch = { running: false, remaining: 0, startedAt: null };
    await saveAndBroadcast();
    return;
  }

  try {
    state.batch.remaining -= 1;
    await startCall(next);
    await saveAndBroadcast();
  } catch (error) {
    next.status = "failed";
    next.error = error.message;
    next.updatedAt = nowIso();
    state.batch.remaining -= 1;
    await saveAndBroadcast();
    setTimeout(() => void maybeStartNextBatchCall(), 3000);
  }
}

async function handleTwilioStatus(reqUrl, form) {
  const contactId = reqUrl.searchParams.get("contactId");
  const contact = contactId
    ? state.contacts.find((item) => item.id === contactId)
    : state.contacts.find((item) => item.callSid === form.CallSid);

  if (!contact) return;

  contact.callSid = form.CallSid || contact.callSid;
  contact.twilioStatus = form.CallStatus || contact.twilioStatus;
  contact.updatedAt = nowIso();

  if (form.CallDuration) {
    contact.durationSeconds = Number(form.CallDuration);
  }

  const status = form.CallStatus;
  if (status === "ringing") contact.status = "ringing";
  if (status === "in-progress") contact.status = "answered";
  if (["busy", "no-answer", "failed", "canceled"].includes(status)) {
    contact.status = status === "no-answer" ? "no_answer" : status;
    contact.callCompletedAt = nowIso();
  }
  if (status === "completed") {
    if (!["completed", "declined", "do_not_call"].includes(contact.status)) {
      contact.status = contact.quotes?.length ? "completed" : "needs_review";
    }
    contact.callCompletedAt = nowIso();
    setTimeout(() => void maybeStartNextBatchCall(), 5000);
  }

  await saveAndBroadcast();
}

async function handleTwilioStreamStatus(reqUrl, form) {
  const contactId = reqUrl.searchParams.get("contactId");
  const contact = contactId
    ? state.contacts.find((item) => item.id === contactId)
    : state.contacts.find((item) => item.callSid === form.CallSid);

  if (!contact) return;

  contact.streamSid = form.StreamSid || contact.streamSid;
  contact.streamStatus = form.StreamEvent || contact.streamStatus;
  contact.updatedAt = nowIso();

  if (form.StreamEvent === "stream-error") {
    contact.status = "failed";
    contact.error = form.StreamError || "Twilio Media Stream error";
  }

  await saveAndBroadcast();
}

function serveTwiml(reqUrl, res) {
  const contactId = reqUrl.searchParams.get("contactId");
  const contact = state.contacts.find((item) => item.id === contactId);
  if (!contact) {
    res.writeHead(404, { "Content-Type": "text/xml" });
    res.end("<Response><Say>Contact not found.</Say></Response>");
    return;
  }

  const streamUrl = `${publicWsBaseUrl()}/media`;
  const streamStatusUrl = `${publicBaseUrl()}/api/streams/status?contactId=${encodeURIComponent(contact.id)}`;
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Connect>",
    `    <Stream url="${xmlEscape(streamUrl)}" statusCallback="${xmlEscape(streamStatusUrl)}" statusCallbackMethod="POST">`,
    `      <Parameter name="contactId" value="${xmlEscape(contact.id)}" />`,
    "    </Stream>",
    "  </Connect>",
    "</Response>"
  ].join("\n");

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(xml);
}

function importContacts(body) {
  const rows = Array.isArray(body.contacts) ? body.contacts : parseCsv(String(body.csv || ""));
  const approved = Boolean(body.approved);
  const resetExisting = Boolean(body.resetExisting);
  let imported = 0;

  for (const row of rows) {
    const phone = normalizePhone(row.phone || row.Phone || row.number || row.Number || "");
    if (!phone) continue;

    const existing = state.contacts.find((contact) => contact.phone === phone);
    const patch = {
      name: clean(row.name || row.Name || row.business || row.Business || ""),
      phone,
      city: clean(row.city || row.City || ""),
      state: clean(row.state || row.State || ""),
      timezone: clean(row.timezone || row.Timezone || row.time_zone || ""),
      notes: clean(row.notes || row.Notes || ""),
      approved,
      updatedAt: nowIso()
    };

    if (existing) {
      Object.assign(existing, patch);
      if (resetExisting) resetContactForImport(existing);
    } else {
      state.contacts.push({
        id: randomUUID(),
        status: "ready",
        attempts: 0,
        quotes: [],
        transcript: [],
        doNotCall: false,
        error: null,
        createdAt: nowIso(),
        ...patch
      });
    }
    imported += 1;
  }

  return imported;
}

function resetContactForImport(contact) {
  Object.assign(contact, {
    status: "ready",
    attempts: 0,
    quotes: [],
    transcript: [],
    summary: "",
    error: null,
    callSid: null,
    twilioStatus: null,
    streamSid: null,
    streamStatus: null,
    callStartedAt: null,
    callCompletedAt: null,
    durationSeconds: null,
    updatedAt: nowIso()
  });
}

function updateContact(contact, body) {
  if ("name" in body) contact.name = clean(body.name);
  if ("phone" in body) contact.phone = normalizePhone(body.phone) || contact.phone;
  if ("city" in body) contact.city = clean(body.city);
  if ("state" in body) contact.state = clean(body.state);
  if ("timezone" in body) contact.timezone = clean(body.timezone);
  if ("notes" in body) contact.notes = clean(body.notes);
  if ("approved" in body) contact.approved = Boolean(body.approved);
  if ("doNotCall" in body) contact.doNotCall = Boolean(body.doNotCall);
  if ("summary" in body) contact.summary = clean(body.summary);
  contact.updatedAt = nowIso();
}

function requireContact(contactId) {
  const contact = state.contacts.find((item) => item.id === contactId);
  if (!contact) throw new Error("Contact not found");
  return contact;
}

function requireCallAcknowledgement(body) {
  if (!body?.acknowledged) {
    throw new Error("Confirm that these are public business numbers and that the AI disclosure script is acceptable before calling.");
  }
}

function configIssues() {
  const provider = audioOutputProvider();
  const required = [
    "OPENAI_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
    "PUBLIC_BASE_URL"
  ];
  const missing = required.filter((key) => !process.env[key]);
  const issues = missing.map((key) => `missing ${key}`);
  if (process.env.PUBLIC_BASE_URL && !process.env.PUBLIC_BASE_URL.startsWith("https://")) {
    issues.push("PUBLIC_BASE_URL should be HTTPS for Twilio Media Streams");
  }
  if (!["openai", "elevenlabs"].includes(provider)) {
    issues.push("AUDIO_OUTPUT_PROVIDER must be openai or elevenlabs");
  }
  if (provider === "elevenlabs") {
    if (!process.env.ELEVENLABS_API_KEY) issues.push("missing ELEVENLABS_API_KEY");
    if (!process.env.ELEVENLABS_VOICE_ID && !process.env.ELEVENLABS_VOICE_NAME) {
      issues.push("missing ELEVENLABS_VOICE_ID or ELEVENLABS_VOICE_NAME");
    }
    if (cachedElevenLabsReadiness?.error) {
      issues.push(cachedElevenLabsReadiness.error);
    }
  }
  return issues;
}

function audioOutputProvider() {
  return String(process.env.AUDIO_OUTPUT_PROVIDER || process.env.TTS_PROVIDER || "openai")
    .trim()
    .toLowerCase();
}

function isElevenLabsOutput() {
  return audioOutputProvider() === "elevenlabs";
}

function activeVoiceLabel() {
  if (isElevenLabsOutput()) {
    return process.env.ELEVENLABS_VOICE_NAME || process.env.ELEVENLABS_VOICE_ID || "ElevenLabs voice";
  }
  return process.env.OPENAI_REALTIME_VOICE || "alloy";
}

function hasTwilioConfig() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

function publicBaseUrl() {
  return requiredEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
}

function publicWsBaseUrl() {
  return publicBaseUrl().replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

function requiredEnv(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function snapshot() {
  return {
    config: {
      port,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
      outboundEnabled: process.env.ALLOW_OUTBOUND_CALLS === "true",
      model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
      audioProvider: audioOutputProvider(),
      voice: activeVoiceLabel(),
      hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
      hasElevenLabsKey: Boolean(process.env.ELEVENLABS_API_KEY),
      hasTwilioSid: Boolean(process.env.TWILIO_ACCOUNT_SID),
      hasTwilioToken: Boolean(process.env.TWILIO_AUTH_TOKEN),
      hasTwilioFrom: Boolean(process.env.TWILIO_FROM_NUMBER),
      issues: configIssues()
    },
    batch: state.batch,
    contacts: state.contacts,
    calls: state.calls.slice(-50),
    stats: stats()
  };
}

function stats() {
  const total = state.contacts.length;
  const approved = state.contacts.filter((contact) => contact.approved).length;
  const completed = state.contacts.filter((contact) => contact.status === "completed").length;
  const needsReview = state.contacts.filter((contact) => contact.status === "needs_review").length;
  const callable = state.contacts.filter((contact) => contact.approved && !contact.doNotCall && !["completed", "declined", "do_not_call"].includes(contact.status)).length;
  return { total, approved, completed, needsReview, callable };
}

async function loadState() {
  await mkdir(dataDir, { recursive: true });
  try {
    const text = await readFile(dataFile, "utf8");
    const parsed = JSON.parse(text);
    return {
      contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
      calls: Array.isArray(parsed.calls) ? parsed.calls : [],
      batch: parsed.batch || { running: false, remaining: 0, startedAt: null }
    };
  } catch {
    return {
      contacts: [],
      calls: [],
      batch: { running: false, remaining: 0, startedAt: null }
    };
  }
}

async function saveAndBroadcast() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dataFile, `${JSON.stringify(state, null, 2)}\n`);
  broadcast();
}

function openEventStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

async function serveStatic(urlPath, res) {
  const decodedPath = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const targetPath = path.normalize(path.join(publicRoot, decodedPath));
  if (!targetPath.startsWith(publicRoot)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(targetPath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const body = await readFile(targetPath);
    res.writeHead(200, { "Content-Type": mimeType(targetPath) });
    res.end(body);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  return JSON.parse(text);
}

async function readForm(req) {
  const text = await readBody(req);
  return Object.fromEntries(new URLSearchParams(text));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseCsv(text) {
  const rows = [];
  const parsedRows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      parsedRows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  if (cell || row.length) {
    row.push(cell);
    parsedRows.push(row);
  }

  const [headers = [], ...bodyRows] = parsedRows.filter((items) => items.some((item) => item.trim()));
  for (const bodyRow of bodyRows) {
    const item = {};
    headers.forEach((header, index) => {
      item[header.trim()] = (bodyRow[index] || "").trim();
    });
    rows.push(item);
  }
  return rows;
}

function normalizePhone(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\+[1-9]\d{7,14}$/.test(text)) return text;
  const digits = text.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function sanitizeQuote(args) {
  return {
    service: clean(args.service),
    priceText: clean(args.price_text),
    priceMin: numberOrNull(args.price_min),
    priceMax: numberOrNull(args.price_max),
    turnaroundText: clean(args.turnaround_text),
    turnaroundDaysMin: numberOrNull(args.turnaround_days_min),
    turnaroundDaysMax: numberOrNull(args.turnaround_days_max),
    rushAvailable: typeof args.rush_available === "boolean" ? args.rush_available : null,
    notes: clean(args.notes),
    confidence: ["low", "medium", "high"].includes(args.confidence) ? args.confidence : "medium"
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clean(value) {
  return String(value || "").trim().slice(0, 2000);
}

function addTranscript(contact, speaker, text) {
  const cleanText = clean(text);
  if (!cleanText) return;
  contact.transcript ||= [];
  contact.transcript.push({
    id: randomUUID(),
    speaker,
    text: cleanText,
    at: nowIso()
  });
}

function flushTranscript(contact, speaker, text) {
  addTranscript(contact, speaker, text);
  contact.updatedAt = nowIso();
}

function safetyIdentifier(contact) {
  return createHash("sha256")
    .update(`tailor-call-agent:${contact.id}:${contact.phone}`)
    .digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mimeType(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function loadDotEnv(filePath) {
  try {
    if (!existsSync(filePath)) return;
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // .env is optional.
  }
}
