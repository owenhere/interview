# AI Interview Project

Minimal monorepo with a React frontend and Node/Express backend.

Overview
- Frontend: React + Vite (`/client`) — user enters name, joins interview, sees AI-generated questions, records answers with webcam.
- Backend: Node + Express (`/server`) — generates questions using OpenAI and accepts video uploads.

Setup
1. **Install ffmpeg** (required for video assembly):
   - Ubuntu/Debian: `sudo apt update && sudo apt install ffmpeg`
   - macOS: `brew install ffmpeg`
   - Windows: Download from https://ffmpeg.org/download.html
   - Verify: `ffmpeg -version`

2. Configure the backend environment (PostgreSQL + OpenAI):
   - Copy `server/env.example` to `server/.env`
   - Set `DATABASE_URL` (PostgreSQL connection string)
   - Set `OPENAI_API_KEY` (for question generation + evaluation)

3. From the repo root, install dependencies for each package:

```powershell
cd server; npm install
cd ../client; npm install
```

Run server and client (separate terminals):

```powershell
cd server; npm run dev
cd client; npm run dev
```

Server runs on `http://localhost:4000` by default. Client runs on `http://localhost:5173`.

Endpoints
- `POST /generate-questions` — returns JSON array of interview questions.
- `POST /upload-answer` — accepts `multipart/form-data` with `video` and `metadata` fields.

Notes
- This is a minimal starter. Improve UI, security, error handling, and storage as needed.
- **Video format:**
  - Browsers record via `MediaRecorder` as **WebM** (Chrome/Firefox) or MP4 (Safari).
  - The backend **requires ffmpeg** to assemble chunked uploads into valid `.mp4` files.
  - **IMPORTANT:** ffmpeg is mandatory for production. Simple byte concatenation creates corrupt WebM files due to container format limitations.
  - Verify ffmpeg is available: `ffmpeg -version`
- Upload limits / 413 errors:
  - If you see `413 Request Entity Too Large` on `POST /backend/upload-chunk`, it's **not** a slow-internet error — it means your **reverse proxy** (nginx/traefik) or Node upload limits are too small.
  - Node/multer limit can be controlled via `MAX_UPLOAD_MB` (defaults to 100MB).
  - If you use nginx, set e.g.:

```nginx
client_max_body_size 50m;
```

Migration (records.json -> PostgreSQL)
- If you have existing data in `server/records.json`, run:

```powershell
cd server
npm run migrate:records-json
```
