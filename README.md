# AI Interview Project

Minimal monorepo with a React frontend and Node/Express backend.

Overview
- Frontend: React + Vite (`/client`) — user enters name, joins interview, sees AI-generated questions, records answers with webcam.
- Backend: Node + Express (`/server`) — generates questions using OpenAI and accepts video uploads.

Setup
1. Copy your OpenAI key into `server/.env` as `OPENAI_API_KEY`.
2. From the repo root, install dependencies for each package:

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
- Video format:
  - Many browsers (notably Chrome) record via `MediaRecorder` as **WebM**, not MP4.
  - To ensure finalized recordings are **MP4**, the backend will use **ffmpeg** (if available) to assemble/transcode chunk uploads into `.mp4`.
  - Install ffmpeg on your deployed server, or set `ENABLE_FFMPEG=false` to disable this behavior.
- Upload limits / 413 errors:
  - If you see `413 Request Entity Too Large` on `POST /backend/upload-chunk`, it's **not** a slow-internet error — it means your **reverse proxy** (nginx/traefik) or Node upload limits are too small.
  - Node/multer limit can be controlled via `MAX_UPLOAD_MB` (defaults to 100MB).
  - If you use nginx, set e.g.:

```nginx
client_max_body_size 50m;
```
