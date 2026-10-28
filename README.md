# Tailor Call Agent

A supervised local dashboard for calling tailor shops, asking a short market-research script, and extracting price points plus turnaround times.

## What It Does

- Imports tailor contacts from CSV.
- Starts one call or a sequential batch through Twilio Programmable Voice.
- Bridges Twilio Media Streams to the OpenAI Realtime API.
- Can use either OpenAI Realtime speech or ElevenLabs realtime TTS for the assistant voice.
- Stores transcripts, extracted service quotes, turnaround times, call status, and notes in `data/campaign.json`.
- Keeps outbound calls disabled until `ALLOW_OUTBOUND_CALLS=true` is set.

## Setup

```bash
cd tailor-call-agent
npm install
cp .env.example .env
npm run dev
```

Edit `.env` with your OpenAI and Twilio credentials.

For ElevenLabs speech, set:

```bash
AUDIO_OUTPUT_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_VOICE_NAME=Mark - Casual, Relaxed and Light
```

If the voice-name search returns the wrong voice or is ambiguous, set `ELEVENLABS_VOICE_ID` directly from your ElevenLabs voice library.

For Twilio to reach your local server, expose it with a tunnel and set `PUBLIC_BASE_URL`:

```bash
npx localtunnel --port 8787
```

Use the returned HTTPS URL in `.env`, then restart the server.

## CSV Format

Required column:

```csv
phone
```

Useful optional columns:

```csv
name,city,state,timezone,notes
```

Example:

```csv
name,phone,city,state,notes
Hem & Stitch,+12125550123,New York,NY,Ask about pants hems and jacket sleeves
```

## Compliance Defaults

The agent prompt identifies itself as an AI assistant, states who it is calling for, states the market-research purpose, asks whether now is a good time, and ends the call if the business declines. The app does not enable Twilio recording.

Only call public business numbers during appropriate business hours and honor opt-out or do-not-call requests.
