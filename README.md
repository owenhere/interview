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
